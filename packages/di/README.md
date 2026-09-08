# resultar-di

Typed dependency composition and scoped resources for `ResultTask`.

Define services once, select the part of the application you need, and keep its resources alive
through a `use` callback. The package handles dependency selection, lifetimes, and ownership;
Resultar handles execution, interruption, failure causes, and cleanup.

## Install

```sh
pnpm add resultar-di resultar
```

ESM; Node.js 24+. The implementation has no Node-specific imports or global container.

## Recommended API

Define a token with `service`, then choose its lifetime when composing the module. Dependencies
are a typed object of tokens; ordinary synchronous factories need no class or generator wrapper.
Use `service(name, task)` for task initialization and `resource(name, { acquire, release })` for
resources. All three register with the same `.singleton`, `.scoped`, or `.transient` methods.

```ts
import { ResultTask } from 'resultar'
import { createModule, service } from 'resultar-di'

const Cache = service('cache', ResultTask.sync(() => new Map<string, string>()))
const Tenant = ResultTask.service<string, 'tenant'>('tenant')
const Users = service('users', { cache: Cache, tenant: Tenant }, ({ cache, tenant }) => ({
  find: (id: string) => cache.get(`${tenant}:${id}`),
}))

const storage = createModule().singleton(Cache)
const features = createModule().scoped(Users)
const application = storage.merge(features).scope()

const result = await ResultTask.runResult(
  application.withServices({ tenant: 'acme' }).use(['users'], ({ users }) =>
    ResultTask.sync(() => users.find('1')),
  ),
)
await ResultTask.runPromise(application.close())
```

`merge` preserves types and rejects duplicate names. `withServices` returns a facade over the same
root; each `use` or `fetch` creates a new child with those local values. It cannot overwrite
registered services or capture request locals inside singletons. Local values are externally owned.
Tokens remain available through `yield*` when initialization requires task composition. The class-shaped `Service` API in the advanced entry point is optional.

The primary `createModule()` exposes token registration only, including after `value`, `merge`,
and `override`. Named factory overloads and module-level `task`/`resource` registration are available
from `resultar-di/advanced`; they do not appear in the primary TypeScript autocomplete.

Duplicate registrations identify the service and suggest `override()`. An asynchronous factory
passed to `service(name, dependencies, factory)` points to `service(name, task)` instead.

## Fetch and Hono request scopes

The Fetch adapter needs no Hono dependency. Select a request-scoped Hono router and delegate to
its `fetch` method:

```ts
const RequestInfo = ResultTask.service<Request, 'request'>('request')
const Router = service('router', { users: Users, request: RequestInfo }, createHttpApp)
const application = storage.merge(features).scoped(Router).scope()

const fetch = (request: Request) => application
  .withServices({ request, tenant: 'acme' })
  .fetch(['router'], ({ router }, incoming) => router.fetch(incoming))(request)

export default { fetch }
```

The caller supplies authenticated tenant data in real applications. Routes receive ordinary
services and can keep `await users.remove(id)`. Each request gets fresh scoped services and shares
the root singletons. Close the root when the server stops accepting requests.

The child stays open until the response body ends, errors, or is canceled. Request abort propagates
to body cancellation. Empty responses finish cleanup before the fetch promise resolves. A handler
or acquisition failure rejects the fetch promise; cleanup failures after headers have been delivered
error the response body, with the ResultTask cause attached to the error. Hono still handles its
own route errors according to its configured error handler.

Consumers must read or cancel response bodies, including in tests. An unconsumed body keeps its
scope active and can delay root shutdown. WebSocket upgrade responses are outside this adapter's
Response-body lifecycle. See the runnable [Hono example](../../examples/hono/README.md).

### Which request scope to use

- `scope.fetch(keys, handler)`: per-response child scope over a `ServiceScope` you own and close.
- `services.http(keys, handler)`: same per-response scope, but the application root is acquired in
  the surrounding `ResultTask` scope and closed automatically on shutdown.
- `createHonoApp` (`resultar-hono`): Hono adapter over `scope.fetch` with inferred bindings, a
  `request()` test helper, and typed `close()`.

Prefer `createHonoApp` for Hono routes and `http()` for long-lived services inside a `ResultTask`
lifetime. Every variant keeps the child open until the response body ends, errors, or is canceled.

## One router, managed HTTP lifetime

Build the router once and pass request services through Hono bindings. `http()` acquires its
application root in the surrounding ResultTask scope, opens a child for each response, and closes
the root automatically during shutdown:

```ts
import { createModule, service } from 'resultar-di'

const services = createModule()
  .singleton(Cache)
  .scoped(Users)
  .value('tenant', 'acme')
const router = createHttpApp() // Hono router, built once
const App = service('app', services.http(['users'], (bindings, request) =>
  router.fetch(request, bindings),
))
const application = createModule().singleton(App)
```

Routes read their request's services from `context.env`; domain service methods remain ordinary
awaitable calls. The returned application exposes `fetch(request)` and `request(path, init)` for
tests. Keep server execution in the owning task scope and consume or cancel response bodies.

The main exports are `createModule`, `service`, and `resource`. Class tokens are available from
`resultar-di/advanced`. See [advanced composition](ADVANCED.md) for class tokens and low-level
named registration; those are alternatives, not prerequisites for the main API.

## Lifetime and inference

- Each module `use` execution has a fresh root and child scope, including concurrent runs of the
  same task.
- `scope().use` creates a fresh child scope; singleton entries remain in the root until `close()`.
- Concurrent consumers share one initialization per owning scope. Failed attempts release partial
  acquisitions and can be retried. Even an `undefined` value is cached.
- Canceling one consumer does not cancel singleton initialization needed by another.
- `close()` is lazy and idempotent; execution prevents new children and waits for active children
  before releasing singleton resources.
- Dependency cycles fail with a dependency path rather than waiting indefinitely.
- Registered tokens are available inside `use` callbacks, task providers, and finalizers.
- Lifetime validation is strict: a singleton cannot depend on a scoped or transient service, and a
  scoped service cannot depend on a transient service.
- Only selected services and their transitive dependencies execute, in dependency order.
- Nested module `use` calls own separate roots. A `ServiceScope` reuses its root and creates child
  scopes for each call.
- `value` and `override` references are shared as supplied; their contents are not deep-frozen.
- Factories receive a shallow-frozen dependency object. They do not receive the module or a resolver.
- Expected task failures remain in `E`. Thrown factory bugs remain `Die` defects.
- Deferred release errors enter `E` when `use` closes its scope. External ResultTask service
  requirements remain visible to the runtime boundary.
- `use` and `fetch` infer errors and external requirements from selected services, transitive
  dependencies, and callback tokens. Type traversal falls back to a conservative module union
  after eight dependency levels to bound compiler work. Explicitly widened module types are also
  conservative. Overrides remove the replaced provider metadata, including initialization errors,
  cleanup errors, and external requirements.
- `close()` retains declared cleanup error types and needs no fresh service environment: finalizers
  retain the environment from acquisition. Its error union is conservative across registrations.

`use` closes resources **before** its returned task completes. Return data, not a live connection or
server you intend to use later. TypeScript cannot enforce that a resource never escapes a callback.
For an application, keep the serving-and-waiting task inside `use`. There is intentionally no public
`resolve()` or `build()` that returns a live graph with a separate manual `dispose()` obligation.

Cancellation is cooperative and follows ResultTask semantics. An uncooperative SDK can delay
shutdown. Initialization within a graph is sequential; the package does not implement parallel startup
or a global runtime.

## Relationship to the core RFC

The ownership and lifetime design is documented in the [DI lifetimes RFC](../../docs/rfcs/rfc-0002-di-lifetimes-scopes.md).
The RFC describes scope ownership, request isolation, and shutdown.

The core owns `ResultTask`, `acquireRelease`, `scoped`, `Cause`, and typed service requirements.
This optional package owns named composition, dependency selection, caching, and overrides. It
uses public core APIs and creates no separate cancellation or finalizer runtime. Applications can
continue using explicit composition or core service tags without adopting this package.

For a runnable Hono application, see [`examples/hono`](../../examples/hono/README.md). It demonstrates
`value`, shared factories without release, and typed service overrides. The small application fixture
in `tests/application.test.ts` and the public package smoke in `scripts/smoke-package.ts` also cover
composition without an HTTP framework.

## Limitations

- No service aliases: there is no `aliasTo` equivalent, and no `hasRegistration`/`build`
  inspection helpers. Select services by their registered names.
- No file-based discovery: there is no `loadModules` equivalent. Register every service explicitly.
- No Bun-runtime validation: supported behavior is validated on Node.js; Bun-specific behavior is
  out of scope.
- No unvalidated streaming: streaming/SSE scopes are supported only through the validated
  `fetch`/`http` body lifecycle. Do not roll cleanup-only-`finally` middleware and call it streaming
  support.
- Inference is conservative past eight dependency levels: `use`/`fetch` error and requirement
  inference traverses selected dependencies up to eight levels, then falls back to a module-wide
  union to bound compiler work.
- Request locals need a per-framework adapter: `withServices` supplies the typed local values, but
  extracting the tenant/request from an incoming request is wired per framework.

Run `pnpm --filter resultar-di test:scale` to compile generated graphs of 50, 100 and 200 services, plus a chain of 12 services. The script checks the built public declarations and prints compiler time and memory.
