# resultar-hono

## Add services to an existing Hono router

`createHonoServices` supplies per-route middleware over the same `resultar-di` request scopes.
It preserves `c.env`, execution context and native route/RPC response inference:

```ts
import { Hono } from 'hono'
import { createModule } from 'resultar-di'
import { createHonoServices } from 'resultar-hono'

const di = createHonoServices(createModule().value('answer', 42))
const app = new Hono<{ Bindings: { suffix: string } }>()
  .get('/public', c => c.text('public'))
  .get('/answer', di.middleware(['answer']), c =>
    c.json({ answer: c.var.services.answer, suffix: c.env.suffix }),
  )

export default app
// On shutdown, after consuming/canceling active responses:
// const closed = await di.close()
```

Only matching middleware selects and initializes services. Its scope stays open through response
body consumption, failure or cancellation, using `scope.fetch`; it does not close in a middleware
`finally`. `close()` is idempotent, retains typed root cleanup errors and rejects new scoped requests.

Use `middleware(keys, { locals: (c: Context<AppEnvironment>) => ({ tenant: c.var.tenant }) })`
after authentication to supply request locals. Sync and async callbacks are supported. Registered
names cannot be overwritten, and a singleton cannot capture locals. Install one services middleware
per request; all selected services should be listed in that middleware. No global Hono variable
augmentation is installed. For `app.use`, declare the application's variables explicitly according
to Hono's normal typing rules; inline route middleware infers `c.var.services` automatically.

`createHonoApp` below retains its existing `c.env` bindings and application-wide selection behavior.
For the corresponding native Fastify plugin, see [`resultar-fastify`](../fastify/README.md).

Typed Hono service bindings and one DI scope per response. Configure ordinary Hono routes;
reuse Resultar DI for service resolution, streaming ownership and cleanup.

```sh
pnpm add resultar-hono resultar-di resultar hono
```

```ts
import { createModule, service } from 'resultar-di';
import { createHonoApp } from 'resultar-hono';

const Greeting = service('greeting', {}, () => ({ text: 'Hello' }));
const app = createHonoApp(
  { services: createModule().scoped(Greeting), bindings: ['greeting'] },
  (hono) => {
    hono.get('/', (c) => c.text(c.env.greeting.text));
  },
);

const response = await app.request('/');
console.log(await response.text());

const closed = await app.close();
closed.match(
  () => console.log('closed'),
  (error) => console.error(error),
);
```

The callback receives a real Hono instance and configures it synchronously once. Bindings are
inferred from the selected DI services. Unknown names and missing dependencies are compile-time
errors. Use ordinary `await` and `result.match` inside routes. Configure middleware, `onError`
and `notFound` on the supplied Hono instance as usual.

## Lifecycle

- `fetch(request)` serves requests using one shared root and a fresh child scope per response.
- `request(input, init?)` uses the same path for tests. Relative paths resolve against localhost.
- `close()` returns a Promise of Result, retaining the module's typed release failures. Concurrent
  and repeated calls return the same promise; requests after close are rejected. Defects or
  composite causes that cannot be represented by Result may reject with ResultTaskCauseError,
  following `ResultTask.runResult` semantics.

The application type is `HonoApplication<CloseError>`. `createHonoApp` instantiates it as
`HonoApplication<ServiceScopeError<R>>`: handle the `close()` `Err` case for typed release
failures.

Services are acquired on demand. Singleton providers live until root close; scoped providers live
until their response is consumed, canceled or fails. A returned Response does not mean its body
has finished. Consume or cancel every response in tests. `close` waits for active consumers:
persistent streams must be finished or canceled before waiting for shutdown.

Provider failures before Hono runs reject fetch with their cause. Hono's `onError` handles route
errors; it cannot intercept earlier DI failures or failures after headers have been delivered.
A finalizer failure after headers affects the response body instead of changing the HTTP status.
Every request, including 404, resolves the selected bindings; selection is not per route.

## Deno and other servers

Pass `app.fetch` to the server chosen by your application. Port, hostname, TLS, operating-system
signals, deadlines and server shutdown remain in the bootstrap. Stop/drain the server first,
then await `app.close()`. No `/node`, `/deno` or `/bun` adapters are provided.

See the [complete example](../../examples/hono/README.md) with workspace dependencies and
no experimental module-resolution flags.

| Runtime | Status |
| --- | --- |
| Node.js 24 | Exercised (example via `@hono/node-server`) |
| Deno | Exercised (`Deno.serve` with `app.fetch`) |
| Bun | Not validated |

The runtime uses web APIs and does not import Node APIs.

## Limitations

This adapter accepts `Request` only. It does not forward runtime bindings or `ExecutionContext`,
guarantee Hono RPC schemas, support WebSocket upgrades, or infer authenticated request-local DI
values — typed local entries such as the authenticated user still depend on a framework adapter.
Selection is per request, not per route. Use the existing lower-level integration when those
features are needed.
