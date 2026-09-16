# resultar-hono

`resultar-hono` reexports the application DI helpers: `createModule`, `Service`, `service`,
`resource`, and the types `ServiceClass`, `ServiceModule`, `ServiceScope`, `ServiceLifetime`
and `HttpApplication`. These are the original `resultar-di` exports, with the same identity
and behavior. You do not need to import or directly install `resultar-di` for this API.
Keep `resultar-di` as a direct dependency for framework-independent shared services or
when importing framework adapter helpers such as `withProvider` and `useServiceAccess`.
Core helpers such as `ResultTask` and `okAsync` continue to come from `resultar`.
The DI package has one entry point; migrate old `resultar-di/advanced` imports to `resultar-di`.

## Add services to an existing Hono router

`createHonoServices` supplies per-route middleware over the same `resultar-di` request scopes.
It preserves `c.env`, execution context and native route/RPC response inference:

```ts
import { Hono } from 'hono'
import { createModule, createHonoServices } from 'resultar-hono'

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
pnpm add resultar-hono resultar hono
```

```ts
import { createModule, service, createHonoApp } from 'resultar-hono';

const Greeting = service('greeting', {}, () => ({ text: 'Hello' }));
const app = createHonoApp(
  { services: createModule().scoped(Greeting) },
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

## Optional request bindings

| Configuration | Services resolved and exposed before the handler |
| --- | --- |
| `bindings` omitted | All services registered in the module |
| `bindings: ["users", "health"]` | Only the listed services; their dependencies are resolved internally |
| `bindings: []` | None |

Creating the application still initializes no providers. On a request, the effective selection
is resolved in registration order for the default view, following dependency resolution and
each provider's lifetime. Singletons are reused, scoped services belong to the request and
transients are created per resolution. Reading the resulting view does not resolve them again.

Omission is convenient for small modules. Restrict the list when an unrelated service should
not initialize for those routes: an acquisition failure in any selected service prevents the
handler from running. Missing or incompatible requirements are checked for the effective
selection. No route-body analysis or automatic property-based resolution is performed.

`createHonoApp` also accepts an optional `startup: ResultTask<void, E, R>`. It runs once on the first call to
`ready()` or before the first request, using the same root as the request services:

```ts
import { ResultTask } from 'resultar'

const app = createHonoApp(
  {
    services,
    startup: ResultTask.gen(function* () {
      const database = yield* Database
      yield* database.ensureSchema()
    }),
  },
  configureRoutes,
)

// At the server boundary, stop startup if initialization fails.
await app.ready().unwrapOrThrow()
```

The task's requirements are checked against the module. A failed task closes the root and prevents
subsequent requests. Startup is lazy, shared by concurrent requests and optional; applications
without it keep the existing behavior.
Directly acquired resources remain alive until `close()`, then release before singleton dependencies.
Startup cannot capture scoped/transient services. Closing during startup requests cooperative
cancellation and prevents waiting requests from reaching routes. Failed startup and cleanup causes
are retained together; an SDK that ignores cancellation can still delay shutdown.

## Routes in separate files

The [runnable example](../../examples/hono/README.md) keeps service definitions and
`createServices` in `services.ts`, native routes in `routes.ts`, and application creation,
the exported `AppHono` type and Node startup in `main.ts`:

```ts
// main.ts
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createHonoApp, type InferRequestServices } from "resultar-hono";
import { healthRoutes, usersRoutes } from "./routes.ts";
import { createServices } from "./services.ts";

// The package infers context.env and keeps resources alive until the response finishes.
export const createApplication = (services = createServices()) =>
  createHonoApp({ services }, (app) => {
    usersRoutes(app);
    healthRoutes(app);
  });

export type AppHono = Hono<{ Bindings: InferRequestServices<typeof createApplication> }>;

if (import.meta.main) {
  const app = createApplication();
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
    console.log(`Listening on http://${info.address}:${info.port}/`);
  });
}
```

Route files import only the application type:

```ts
// routes.ts — health route excerpt
import type { AppHono } from "./main.ts";

export const healthRoutes = (app: AppHono) => {
  app.get("/health", async (c) => {
    const result = await c.env.health.check();
    return result.match(
      (health) => c.json(health),
      () => c.json({ error: "Health unavailable" }, 503),
    );
  });
};
```

The type-only import adds no runtime dependency on the bootstrap. `InferRequestServices`
accepts the factory or its returned application and infers a readonly view of all registered
services by default, or only the explicit `bindings` selection. Routes do not repeat service tokens and need no global augmentation.
This helper describes `createHonoApp` bindings in `c.env`; `createHonoServices` middleware
continues to infer its per-route selection in `c.var.services`.

Start the example with `pnpm dev` from `examples/hono`. Tests import `createApplication`
without starting the Node server because startup is guarded by `import.meta.main`.

## Lifecycle

- `fetch(request)` serves requests using one shared root and a fresh child scope per response.
- `request(input, init?)` uses the same path for tests. Relative paths resolve against localhost.
- `ready()` runs the optional startup task once and returns a `ResultAsync`; call it before opening a
  server listener when startup errors should be handled explicitly.
- `close()` returns a Promise of Result, retaining the module's typed release failures. Concurrent
  and repeated calls return the same promise; requests after close are rejected. Defects or
  composite causes that cannot be represented by Result may reject with ResultTaskCauseError,
  following `ResultTask.runResult` semantics.

The application type is `HonoApplication<CloseError, RequestServices>`. The second parameter
defaults to `object`, preserving `HonoApplication<CloseError>`. `createHonoApp` retains both
`ServiceScopeError<R>` and the selected bindings: handle the `close()` `Err` case for typed
release failures. Service type metadata exists only in the declarations, not at runtime.
`createHonoApp` adds `ready()` to its inferred return type without requiring that method on existing
implementations or test doubles of the `HonoApplication` interface.

Selected services are acquired before each handler. Singleton providers live until root close; scoped providers live
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

Class services reexported by this adapter accept synchronous factories:
`Service("users", { requires: { repository: Repository }, make: ({ repository }) => ({ find: (id: string) => repository.find(id) }) })`.
Construction remains lazy and follows the registered lifetime. Factories can also return a
`ResultTask` for initialization with failures or resources; raw Promises are not accepted.
