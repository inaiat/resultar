# RFC 0002: Explicit lifetimes and request scopes (resultar-di)

- Status: implemented in `resultar-di`; Hono adapter and concurrent cache remain outside the package.
- Date: 2026-09-05.
- Context: private consumer migration and Hono example in `examples/hono`.
- Reference: Awilix 13.0.5 installed in a private consumer with the official documentation consulted on this date.

## Observed problem

Synchronous registration must directly communicate how long an instance is shared.
The API uses `singleton`, `scoped`, and `transient`, each with a name, dependencies, and creation function.
Child scopes share the root's singletons; `module.use` executions create independent roots.

Another problem was requiring `ResultTask.runResult` on every route of the example. Methods now return
`ResultAsync`, allowing `await users.remove(id)`. This improves the HTTP call, but does not create a
DI scope or automatic cancellation. Those are independent decisions.

## Comparison with Awilix

| Awilix feature                         | Status in resultar-di                                          | Direction                 |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------- |
| Values, functions, and classes           | `value`, `singleton`, `scoped`, `transient`; tokens via `Service` | Keep                 |
| Singleton, scoped, and transient         | Dedicated sync methods; `lifetime` in `task` and `resource`       | Implemented          |
| Child scopes and local registrations     | `scope()` creates a root; `scope.use()` creates children          | Implemented          |
| Strict mode for incompatible lifetimes   | Runtime validation with lifetimes                                 | Implemented          |
| Disposers                                | Resources with finalization via ResultTask                        | Keep                  |
| `aliasTo`, `build`, `hasRegistration`    | No dedicated equivalents                                          | Evaluate against real usage |
| `PROXY`, `CLASSIC`, local injections     | Explicit dependency list and closures                             | Keep explicit        |
| `loadModules`                            | No file-based discovery                                           | Defer                |

These features are described in the [Awilix documentation](https://github.com/jeffijoe/awilix#table-of-contents).
The [container](https://github.com/jeffijoe/awilix/blob/master/src/container.ts) keeps a singleton cache
at the root and a scoped cache per scope; transients never enter the cache. Disposal walks the local cache
in parallel and does not close child scopes. In Resultar, keeping ordered finalization and composite causes
remains a requirement, including for transient resources.

## Separating the three choices

1. **Creation:** existing value, sync function, task initialization, or acquisition with release.
2. **Lifetime:** application singleton, scoped per operation/request, transient per resolution.
3. **Methods:** synchronous `Result`, awaitable `ResultAsync`, or lazy `ResultTask` depending on the contract.

A factory can create a singleton. A resource can also be singleton or scoped. `release`
does not define how many instances will exist; it defines how to shut down each acquired resource.

`ResultTask` stays lazy and never becomes a thenable. Awaitable services use `ResultAsync`; I/O
operations of those services must propagate cancellation explicitly when needed. Routes
await operations before closing their scope, without firing off orphaned work.

## Implemented API

Executable example:

```ts
createModule()
  .resource("database", [], {
    lifetime: "singleton",
    acquire: connectDatabase,
    release: (database) => database.close(),
  })
  .singleton("cache", [], createCache)
  .scoped("users", ["database"], createUsersService)
  .transient("operation", [], createOperation);
```

For services with their own dependencies, the class token eliminates repetition of the name list:

```ts
interface UsersService {
  readonly find: (id: string) => ResultAsync<User, UserNotFoundError>;
}

class Users extends Service<UsersService>()("users", {
  make: ResultTask.gen(function* buildUsers() {
    const cache = yield* Cache;
    return createUsersService({ cache });
  }),
}) {}

createModule().singleton(Cache).scoped(Users);
```

`Service` preserves the literal identifier and the service contract. `yield* Cache` also appears
in the `make` type requirement; when registering `Users`, the module resolver satisfies that requirement
by identifier, applies lifetime validation, and keeps the service inference available in
`use`. The method (`singleton`, `scoped`, or `transient`) remains the only scope choice.

`singleton`, `scoped`, and `transient` choose the lifetime in the method itself, with no fourth argument.
`task` and `resource` keep the `lifetime` option and default to `scoped`. The creation
function remains a factory; the registration method communicates how its instance will be shared.

An application root is opened with `const application = module.scope()`. Each
`application.use(...)` resolves a child and closes it when done. Closing the root is explicit:
`await ResultTask.runPromise(application.close())`.

## Ownership and caches

- The module is an immutable description. Each `module.use` execution creates its own root runtime;
  the module does not store singleton instances across executions.
- Singletons belong to the root and are shared across its requests. Acquisition and finalization
  happen in the root scope, even when demand comes from a child.
- Each child scope receives inherited definitions and its own scoped cache. Typed local entries,
  such as the authenticated user, tenant, and requestId, still depend on a framework adapter.
- Transients are created on each resolution/injection. That does not mean a new instance on each
  method call. Each acquisition with release belongs to the scope that requested it.
- `value` and value overrides remain external references, with no automatic cleanup.
- Test overrides create independent applications. Request overrides cannot change
  already-built singletons nor contaminate the root cache.
- Concurrent demands for the same singleton/scoped share the in-flight acquisition.
  Failures allow retry; cancelling one consumer does not cancel another's initialization.

## Lifetime validation

Adopt strict validation by default: a singleton does not capture scoped/transient, and a scoped does not
capture transient. The rule covers each pair during resolution and fails with `Die(TypeError)` before
delivering the incompatible service.

Dependencies and names are validated during composition; lifetimes are validated at
runtime to also protect JavaScript callers. This prevents a singleton from holding the first
request's tenant. The [Awilix strict mode](https://github.com/jeffijoe/awilix#strict-mode) guides this protection.

## Hono integration

An optional adapter keeps the application runtime and opens one child per request. The route's common
path remains `await users.remove(id)`, with small typed contracts. The integration
does not add a mandatory Hono dependency to the base package.

Closing the root shuts down its singleton resources. The adapter should stop accepting requests and
wait for children before calling `scope.close()`.
For streaming/SSE, returning a `Response` does not mean resource usage has ended: the scope
must track completion/cancellation of the body. Do not implement cleanup only in a middleware
`finally`, and do not declare streaming support without validating this behavior.

## Delivery criteria

- Two requests share the singleton database and receive distinct scoped services. **Covered by the runtime.**
- Within one request, consumers share the same scoped; transients are distinct. **Covered by the runtime.**
- Two runs of the same application do not share a singleton by accident. **Covered by the runtime.**
- Different tenant contexts do not mix, even with concurrent requests.
- Concurrent acquisition shares one instance; failures do not leave caches unusable.
- Partial failure, route error, and interruption release each resource exactly once.
- A child does not shut down the root's singleton. **Covered by the runtime.** Closing the root waits for active children.
- Type tests preserve acquisition/release errors, local entries, and external requirements.

Shared concurrent acquisition, retry, partial rollback, and waiting for children are implemented
and covered by regression tests.

The Fetch adapter was implemented in `ServiceScope.fetch`, with streaming, cancellation,
body failure, empty response, and handler failure tests. The Hono example uses one child per request.
`withServices` provides typed local values and `merge` composes immutable modules without collisions.
`service` and `resource` create tokens without classes; the registration method chooses the lifetime.
Inference follows selected dependencies up to eight levels; beyond that it uses a
conservative union to limit compiler work. `close` preserves cleanup errors.
Aliases remain out of scope.
