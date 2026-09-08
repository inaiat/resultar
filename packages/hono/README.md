# resultar-hono

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
