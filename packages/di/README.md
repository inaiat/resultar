# resultar-di

Typed dependency composition and scoped resources for `ResultTask`.

Define services once, select the part of the application you need, and keep its resources alive
through a `use` callback. The package handles dependency selection, lifetimes, and ownership;
Resultar handles execution, interruption, failure causes, and cleanup.

## Contents

- [Recommended API](#recommended-api)
- [Class services and explicit requirements](#class-services-and-explicit-requirements)
- [Fetch and Hono request scopes](#fetch-and-hono-request-scopes)
- [Managed HTTP lifetime](#one-router-managed-http-lifetime)
- [Lifetime and inference](#lifetime-and-inference)
- [Named registration](#named-registration)
- [API reference](#api-reference)
- [Testing with overrides](#testing-with-overrides)
- [Framework service facades](#framework-service-facades)
- [Limitations](#limitations)

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
import { createModule, service, Service } from 'resultar-di'

const Cache = service('cache', ResultTask.sync(() => new Map<string, string>()))
const Tenant = Service.require<string>()('tenant')
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
Tokens remain available through `yield*` when initialization requires task composition. The class-shaped `Service` API is available from the same entry point.

A single `createModule()` supports tokens/classes, named factories and module-level
`task`/`resource` registration, including after `value`, `merge` and `override`.
All APIs are imported from `resultar-di`; prefer tokens/classes in application code.

Duplicate registrations identify the service and suggest `override()`. An asynchronous factory
passed to `service(name, dependencies, factory)` points to `service(name, task)` instead.

## Class services and explicit requirements

Use `Service` when you prefer class-shaped tokens. `requires` injects a readonly object whose
properties are inferred from the declared tokens. Its `make` factory can return the service object directly:

```ts
import { ResultTask } from 'resultar'
import { createModule, Service } from 'resultar-di'

const Storage = Service.require<ReadonlyMap<string, string>>()('storage')

class Users extends Service('users', {
  requires: { cache: Storage },
  make: ({ cache }) => ({
    find: (id: string) => cache.get(id),
  }),
}) {}

const services = createModule()
  .value('storage', new Map([['1', 'Ada']]))
  .scoped(Users)
```

`cache` is the injected alias; `storage` is the provider identifier. A requirement does not register
or execute its provider. Register providers explicitly using `value`, `singleton`, `scoped`, or
`transient`. Tokens and service classes can both appear in `requires`.

With `requires`, `make` returns a synchronous value or a `ResultTask`. Prefer returning the object
directly for ordinary service construction; keep `ResultTask.gen` for initialization with typed
failures, additional requirements or owned resources. Existing `ResultTask.sync` factories remain
supported. Promises and thenables are rejected: wrap asynchronous initialization in
`ResultTask.tryPromise` or another task. Methods on the returned service can still return
`ResultAsync` or `StrictResultAsync`. Without `requires`, `make` remains a task. The generator form
also supports inline requirements:

```ts
class Users extends Service('users', {
  make: ResultTask.gen(function* () {
    const cache = yield* Service.require<ReadonlyMap<string, string>>()('storage')
    return { find: (id: string) => cache.get(id) }
  }),
}) {}
```

`ResultTask.service<T>()('name')` is the equivalent core API. The existing
`ResultTask.service<T, 'name'>('name')` remains supported. For an explicit service contract, use
`Service<UsersContract>()('users', definition)` with either definition form. Class services are tokens;
resolve them through the module rather than instantiating them with `new`. Forward token registrations
are checked at the `use` boundary.

Construction remains lazy. Dependencies resolve sequentially in entry order before `make` is
called with a shallow-frozen object. Both synchronous factories and returned tasks execute in the
service's owning lifetime, and `ServiceClass.make` always exposes a normalized `ResultTask`.
Synchronous factories add no typed initialization failures (`E = never`). A returned task's
additional requirements combine with `requires`, and its failures remain in `E`. `requires: {}` supports a dependency-free factory. Thrown factory defects remain `Die`, and
acquisition, interruption, rollback and finalization use the existing ResultTask scope.

Each call to `Service.require` or `ResultTask.service` creates a distinct token. Inline requirements
work with this DI module's named resolution and with core `provideServices({ storage })`. Core `provideService(token, value)` supplies both the exact token and a named fallback. Reuse the
original reference to select an exact binding when identifiers collide. Same-name tokens are not
globally interned; exact token bindings take precedence over named environments.

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

The application helpers are `createModule`, `service`, `Service` (including `Service.require`),
and `resource`. Framework adapter helpers `inspectModule`, `withProvider`, `useServiceAccess`
and `ServiceAccessError` are exported from the same entry point, along with their public types.
See [named registration](#named-registration), the [API reference](#api-reference) and
[framework service facades](#framework-service-facades) below.

### Migration from the split entry points

Replace imports from `resultar-di/advanced` with `resultar-di`. The old subpath has been removed.
Existing token-based imports keep working; `createModule` now exposes all registration forms.
The change does not alter lazy initialization, dependency resolution or resource lifetimes.

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

`scope.useSingletons(keys, callback)` is the application-only variant of `use`. It remains lazy,
shares the same root cache, and rejects scoped/transient selections and callback tokens at runtime.
It also rejects request locals. Keep the application callback alive for the serving lifetime;
`close()` waits for it before releasing singleton resources. This is how
[`resultar-fastify`](../fastify/README.md) initializes `app.services` without another container.

Framework adapters can run an optional application `ResultTask` through this same operation. The
task's `R` is checked against the module and its singleton dependencies are shared with requests;
the adapter owns when the task runs and how native startup and shutdown events are connected.
`startServiceTask(use, task)` is the low-level adapter bridge: `use` binds the task to the existing
`useSingletons` scope, `ready` reports initialization, and `close()` releases its retained scope.
Close the session before closing the root. The bridge starts on invocation; constructing the
underlying `ResultTask` remains lazy. Native adapters own this session automatically.

Cancellation is cooperative and follows ResultTask semantics. An uncooperative SDK can delay
shutdown. Initialization within a graph is sequential; the package does not implement parallel startup
or a global runtime.

## Named registration

The same `createModule()` also accepts named factories. Prefer tokens and classes for application
services; named registration is useful when integrating an existing framework or composing factories.

`singleton`, `scoped` and `transient` receive a name, a typed dependency list and a synchronous
factory. `task` and module-level `resource` default to scoped lifetime; pass
`{ lifetime: 'singleton' | 'scoped' | 'transient' }` to choose another lifetime.

### Simple singleton without release

Use `singleton` for a service shared by multiple child scopes that needs no cleanup.

```ts
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";

let cacheCreations = 0;
const services = createModule()
  .singleton("cache", [], () => {
    cacheCreations += 1;
    return new Map<string, string>();
  })
  .scoped("users", ["cache"], ({ cache }) => ({ cache }))
  .scoped("sessions", ["cache"], ({ cache }) => ({ cache }));

const application = services.scope();
const program = application.use(["users", "sessions"], ({ users, sessions }) =>
  ResultTask.sync(() => {
    users.cache.set("status", "ready");
    return {
      cacheInstance: cacheCreations,
      sameInstance: users.cache === sessions.cache,
      status: sessions.cache.get("status"),
    };
  }),
);

const first = await ResultTask.runResult(program);
// Ok({ cacheInstance: 1, sameInstance: true, status: 'ready' })

const second = await ResultTask.runResult(
  application.use(["users", "sessions"], ({ users, sessions }) =>
    ResultTask.sync(() => ({
      cacheInstance: cacheCreations,
      sameInstance: users.cache === sessions.cache,
      status: sessions.cache.get("status"),
    })),
  ),
);
// Ok({ cacheInstance: 1, sameInstance: true, status: 'ready' })
await ResultTask.runPromise(application.close());
```

`users` and `sessions` share one cache in each child scope, while both child scopes share the
singleton cache owned by `application`. The application root owns the cache until `close()`.

### Share an existing instance across executions

Register an existing instance with `value` when independent executions should share it:

```ts
const sharedCache = new Map<string, string>();
const sharedServices = createModule().value("cache", sharedCache);
const sharedProgram = sharedServices.use(["cache"], ({ cache }) =>
  ResultTask.sync(() => {
    const alreadyUsed = cache.has("status");
    cache.set("status", "ready");
    return alreadyUsed;
  }),
);

const first = await ResultTask.runResult(sharedProgram); // Ok(false)
const second = await ResultTask.runResult(sharedProgram); // Ok(true): same cache
```

`value` uses the supplied instance directly; it does not create or dispose it.

### Compose an application

Factories receive only the dependencies they declare. Register dependencies before dependents;
unknown names, forward references, duplicate names, and incompatible overrides are type errors.
Dependency lists infer literal tuples without `as const` at inline call sites.

For `singleton`, `scoped`, and `transient`, a non-empty dependency list requires the creation
function to declare a dependency parameter. This catches accidentally passing an unrelated
zero-argument function at the registration itself:

```ts
const unrelated = () => ({ status: "ready" });

// Type error: dependencyParameterRequired: "cache"
services.scoped("users", ["cache"], unrelated);

// Receive the selected dependencies, with their inferred types.
services.scoped("users", ["cache"], ({ cache }) => ({ cache }));

// A zero-argument function is valid when no dependencies are declared.
services.singleton("status", [], unrelated);
```

This is a TypeScript signature check, not a runtime inspection of the function body. A function
can still declare a parameter and ignore it, and an explicitly widened function type or `any`
can hide its original signature. The returned service type is inferred independently; consumers
still validate that it satisfies their service contract. Task providers and resource callbacks
keep their existing callback rules.

```ts
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";

const services = createModule()
  .value("config", { databaseUrl: "memory" })
  .resource("database", ["config"], {
    acquire: ({ config }) => connectDatabase(config.databaseUrl),
    release: (database) => database.close(),
  })
  .scoped("health", ["database"], ({ database }) => createHealthUseCase({ database }))
  .resource("session", ["database"], {
    acquire: ({ database }) => connectSession(database),
    release: (session) => session.close(),
  })
  .resource("server", ["health", "session"], {
    acquire: ({ health, session }) => serve({ health, session }),
    release: (server) => server.close(),
  });

// connectDatabase, connectSession, serve, close, and waitForShutdown return ResultTask.
// createHealthUseCase is an ordinary synchronous factory.
const program = services.use(["server"], ({ server }) => server.waitForShutdown());
const exit = await ResultTask.runExit(program);
```

Nothing is acquired until `program` runs. Shutdown releases server, session, then database.
A failure during construction releases resources already acquired. A failed release does not skip
earlier finalizers; `runExit` retains execution and release causes.

The server adapter must implement graceful HTTP draining in its release task. This package does
not install process signal handlers or implement HTTP/session shutdown behavior.

## API reference

| Operation                                            | Purpose                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `value(name, value)`                                 | Register an externally owned value; no automatic release                     |
| `singleton(name, dependencies, create)`              | Create a synchronous service once per root                                   |
| `scoped(name, dependencies, create)`                 | Create a synchronous service once per child scope                            |
| `transient(name, dependencies, create)`              | Create a synchronous service on every resolution                             |
| `singleton(ServiceToken)`                            | Register a class-shaped service once per root                                |
| `scoped(ServiceToken)`                               | Register a class-shaped service once per child scope                         |
| `transient(ServiceToken)`                            | Register a class-shaped service on every resolution                          |
| `task(name, dependencies, create)`                   | Initialize using a lazy ResultTask, including an existing scoped acquisition |
| `resource(name, dependencies, { acquire, release })` | Acquire with a ResultTask and register release in the same scope             |
| `override(name, value)`                              | Return a new module with a type-checked, externally owned replacement        |
| `use(dependencies, callback)`                        | Select a graph and keep it alive through the callback's ResultTask           |
| `scope()`                                            | Open a long-lived root; each `scope.use` call gets a child scope             |
| `merge(module)`                                      | Combine immutable modules; duplicate names are rejected                      |
| `http(dependencies, handle)`                         | Fetch application task: one owned root, a fresh child scope per response     |
| `scope.withServices(values)`                         | Supply typed locals a child may resolve; cannot overwrite registrations      |
| `scope.fetch(dependencies, handle)`                  | Fetch handler whose child stays open through response-body consumption       |
| `scope.useSingletons(dependencies, callback)`        | Hold application services with singleton lifetime rules                      |
| `scope.close()`                                      | Release root singletons; waits for active children, then runs finalizers     |

`release(resource, exit, dependencies)` receives the original scope outcome and the same dependencies
used during acquisition. Use it for cleanup that depends on whether the application succeeded.

Pass `{ lifetime: 'singleton' }`, `{ lifetime: 'scoped' }`, or `{ lifetime: 'transient' }` as the
last argument to `task`, or alongside `acquire` and `release` for `resource`.

`singleton`, `scoped`, and `transient` accept synchronous return values. For task-based initialization without its own cleanup,
use `task`; for an SDK returning a Promise, adapt it with `ResultTask.tryPromise` inside that task.
Existing `ResultTask.acquireRelease` programs can also be registered with `task` without duplicating
their release logic.

## Testing with overrides

```ts
const testing = services.override("database", fakeDatabase);

const result = await ResultTask.runResult(testing.use(["health"], ({ health }) => health.check()));
```

Only health and its selected dependencies are resolved. Database acquisition is replaced entirely;
session and the HTTP server are not created. Downstream factories receive the replacement. The
original module remains available for other tests. Callers own the lifetime of injected values.

An override must implement the complete registered service contract. For small mocks, declare
small application-facing interfaces at factory and resource boundaries. DI cannot make a broad
service interface narrow automatically.

## Framework service facades

Framework adapters that must preserve synchronous property access can use `withProvider`,
`inspectModule` and `useServiceAccess` from `resultar-di`. They use the same DI runtime;
there is no separate resolver or cache. Ordinary application code should prefer typed service
selections.

`withProvider(module, name, provider)` returns a new module and replaces that name without acquiring
it. A provider is an external `{ value }`, a `{ task, lifetime }`, or a synchronous
`{ create: access => value, release?, lifetime }`. Lifetime defaults to `singleton` for these
adapter providers. `release(value, exit)` returns a ResultTask and belongs to the native owner.
`allowTransientDependencies` is an explicit opt-in for traditional factory-container semantics;
token dependencies continue to enforce lifetime ordering.

`inspectModule(module)` returns immutable name/lifetime metadata. `useServiceAccess(scope, callback,
{ initialize, application })` holds a request child scope until its ResultTask callback finishes.
Application access uses the root; its caller must close the root after ending the callback.
`initialize` eagerly resolves only its named services. The access object exposes `get`, `has`,
`keys`, `use` and `close`. `get` returns a Result, resolves factories synchronously, and reads
previously initialized task providers. It reports an error when an asynchronous provider has not
been initialized. Factories stay lazy, scoped values are cached per child and transient reads
acquire a fresh value each time. Root access rejects request-scoped services.

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
