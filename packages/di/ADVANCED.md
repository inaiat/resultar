# Advanced composition

Use the token-based API in [README](README.md) for new applications. This reference covers class tokens and low-level named registration.

Import `createModule` from `resultar-di/advanced` for the named registration methods below.
The primary entry point accepts tokens only. Both entry points share the same runtime;
the distinction controls the TypeScript API and autocomplete.

## Creation and lifetime

For synchronous services, the registration method declares the lifetime directly: `singleton`,
`scoped`, or `transient`. Each receives a name, a typed dependency list, and a creation function.
Use `task` for ResultTask initialization and `resource` for explicit acquisition and release.

| Registration | Creation                                   | Default lifetime         | Cleanup                                  |
| ------------ | ------------------------------------------ | ------------------------ | ---------------------------------------- |
| `value`      | Caller supplies the existing value         | `singleton`              | Caller owns cleanup                      |
| `singleton`  | Synchronous function, on first demand      | One per application root | No automatic release                     |
| `scoped`     | Synchronous function, on first demand      | One per child scope      | No automatic release                     |
| `transient`  | Synchronous function, on every resolution  | No cache                 | No automatic release                     |
| `task`       | ResultTask initialization, on first demand | `scoped`                 | The task can register its own finalizers |
| `resource`   | ResultTask acquisition, on first demand    | `scoped`                 | Automatic `release` at the owning scope  |

`task` and `resource` accept `{ lifetime: 'singleton' | 'scoped' | 'transient' }`.
Singletons are cached by the root returned from `scope()`, scoped services are cached by each child
`use`, and transients are recreated on every resolution. `use` itself creates an isolated root and
closes it when the callback finishes. Use `scope()` for an application root that serves multiple
child scopes, then call `close()` during shutdown.

## Class-shaped services

`Service` creates a class-shaped token. The token carries the service identifier and its `make`
task, so dependencies are declared where they are used with `yield*`. The registration method still
chooses the lifetime; the class itself does not need a lifetime option.

```ts
import { ResultTask } from "resultar";
import { createModule, Service } from "resultar-di/advanced";

interface CacheService {
  readonly values: ReadonlyMap<string, string>;
}

class Cache extends Service<CacheService>()("cache", {
  make: ResultTask.sync(() => ({ values: new Map([["1", "Ada"]]) })),
}) {}

interface UsersService {
  readonly find: (id: string) => string | undefined;
}

class Users extends Service<UsersService>()("users", {
  make: ResultTask.gen(function* buildUsers() {
    const cache = yield* Cache;
    return { find: (id: string) => cache.values.get(id) };
  }),
}) {}

const application = createModule().singleton(Cache).scoped(Users).scope();
const result = await ResultTask.runResult(
  application.use(["users"], ({ users }) => ResultTask.sync(() => users.find("1"))),
);
await ResultTask.runPromise(application.close());
```

`singleton(Cache)` shares one cache across all child scopes. `scoped(Users)` creates one users
service per child scope. Use `.transient(ServiceToken)` when every resolution must create a new
instance. The token identifier (`'cache'` or `'users'`) becomes the selected service key and is
checked as a literal by TypeScript. A class service can depend on another class service without a
second dependency array; the runtime resolver applies lifetime validation and reports an unknown
service when a required token was not registered. Class `make` tasks may use `ResultTask.acquireRelease`; their resources belong to the registered
lifetime and remain alive until that owner closes. Class tokens cannot be instantiated with `new`.
Service identifiers are canonical names: registered values must satisfy the required contract.
Forward registrations are checked at the `use` boundary.

## Simple singleton without release

Use `singleton` for a service shared by multiple child scopes that needs no cleanup.

```ts
import { ResultTask } from "resultar";
import { createModule } from "resultar-di/advanced";

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

## Share an existing instance across executions

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

## Compose an application

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
import { createModule } from "resultar-di/advanced";

const services = createModule()
  .value("config", { databaseUrl: "memory" })
  .resource("database", ["config"], {
    acquire: ({ config }) => connectDatabase(config.databaseUrl),
    release: (database) => database.close(),
  })
  .scoped("health", ["database"], ({ database }) => createHealthUseCase({ database }))
  .resource("whatsapp", ["database"], {
    acquire: ({ database }) => connectWhatsApp(database),
    release: (whatsapp) => whatsapp.close(),
  })
  .resource("server", ["health", "whatsapp"], {
    acquire: ({ health, whatsapp }) => serve({ health, whatsapp }),
    release: (server) => server.close(),
  });

// connectDatabase, connectWhatsApp, serve, close, and waitForShutdown return ResultTask.
// createHealthUseCase is an ordinary synchronous factory.
const program = services.use(["server"], ({ server }) => server.waitForShutdown());
const exit = await ResultTask.runExit(program);
```

Nothing is acquired until `program` runs. Shutdown releases server, WhatsApp, then database.
A failure during construction releases resources already acquired. A failed release does not skip
earlier finalizers; `runExit` retains execution and release causes.

The server adapter must implement graceful HTTP draining in its release task. This package does
not install process signal handlers or implement HTTP/WhatsApp shutdown behavior.

## API

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

`release(resource, exit, dependencies)` receives the original scope outcome and the same dependencies
used during acquisition. Use it for cleanup that depends on whether the application succeeded.

Pass `{ lifetime: 'singleton' }`, `{ lifetime: 'scoped' }`, or `{ lifetime: 'transient' }` as the
last argument to `task`, or alongside `acquire` and `release` for `resource`.

`singleton`, `scoped`, and `transient` accept synchronous return values. For task-based initialization without its own cleanup,
use `task`; for an SDK returning a Promise, adapt it with `ResultTask.tryPromise` inside that task.
Existing `ResultTask.acquireRelease` programs can also be registered with `task` without duplicating
their release logic.

## Tests without a container cast

```ts
const testing = services.override("database", fakeDatabase);

const result = await ResultTask.runResult(testing.use(["health"], ({ health }) => health.check()));
```

Only health and its selected dependencies are resolved. Database acquisition is replaced entirely;
WhatsApp and the HTTP server are not created. Downstream factories receive the replacement. The
original module remains available for other tests. Callers own the lifetime of injected values.

An override must implement the complete registered service contract. For small mocks, declare
small application-facing interfaces at factory and resource boundaries. DI cannot make a broad
service interface narrow automatically.
