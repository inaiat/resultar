# DX review: Awilix and resultar-di

> **Superseded (2026-09-05):** the P1 findings below were resolved by [RFC 0002](./rfcs/rfc-0002-di-lifetimes-scopes.md)
> (Implemented). Kept as a historical record of one private-consumer migration review.

Date: 2026-09-05. Scope: local implementation after introducing Service and per-class registrations.

## Verdict

resultar-di has a good API direction but does not yet beat Awilix overall.
The lifetime methods are clear; dependencies with yield* have symbol navigation in the editor.
The total cost of creating a service still includes contract, token, make, and factory adaptation.
Moreover, there are demonstrable type, ownership, and concurrency failures.

The earlier claim that checks and smokes passed was correct, but those tests did not
demonstrate every advertised guarantee. Passing the existing tests is not enough to declare
the runtime ready.

## Comparison baseline

The app container of a private consumer (using InferCradleFromResolvers, PROXY, strict,
singleton factories, and disposers) was inspected. It already uses those Awilix features.
Therefore, inferring the types of registered services is not an exclusive advantage of ours.

Awilix documents common functions and classes, scopes with local registrations, local
injections, aliases, and cradle inference. Those features lower the cost of adopting existing code.
Source: [official documentation](https://github.com/jeffijoe/awilix#readme).

Its implementation also checks cycles and keeps the resolution stack for dependency
and lifetime errors. Source: [container.ts](https://github.com/jeffijoe/awilix/blob/master/src/container.ts).

## Practical comparison

| Situation | resultar-di assessment |
| --- | --- |
| Read the lifetime in the registration | Good: singleton(Token), scoped(Token), transient(Token). |
| Identify dependencies in the service | Good: yield* Token offers a direct reference to the symbol. |
| Add an already existing factory | More ceremony: explicit list or Service wrapper with make. |
| Separate contract and implementation | Possible, but the current token joins contract and default implementation. |
| Test with mocks | Per-name override is typed, but consistent token usage is still missing. |
| Run a service in a route | await users.remove(id) is simple, but it comes from ResultAsync and also works with another DI. |
| Open a scope per request | Missing adapter and API for local tenant/requestId/user values. |
| Guarantee singleton and cleanup | Still insufficient: reproductions below. |
| Inspect graph errors | Missing specific errors, resolution path, and cycle detection. |
| Validate requirements before running | Partial: the current removal compares names without validating contracts. |

## Reproduced problems

A temporary fixture was run with imports from the local DI code and the current core build.
The full fixture passed with strict TypeScript, with no casts hiding type errors.
The results below come from real execution; they were not inferred from reading alone.

### P1 — Equal names can satisfy an incompatible contract

If Cache requires read(): string and Users does yield* Cache, this compiles:

    createModule().value("cache", 123).scoped(Users)

The method call ends in TypeError: cache.read is not a function.
RegisteredServiceRequirements removes the tag by checking only the identifier.
Fix needed: check the contract and the chosen identity for tokens, including
value registrations, overrides, and module composition.

Location: packages/di/src/module.ts, RegisteredServiceRequirements and class registration.

### P1 — use removes a requirement without providing the service to the callback

This compiles without requiring services at execution time:

    createModule().singleton(Cache).use([], () =>
      ResultTask.gen(function* () {
        return (yield* Cache).read()
      })
    )

Result: MissingServiceError: Missing ResultTask service: cache.
The resolver only wraps the token's make; the use callback does not receive that context.
Fix needed: provide the promised requirements or keep them in the callback type.
The same analysis must cover task, resource, and finalizers, not just class registrations.

Location: packages/di/src/module.ts, UseTask and makeScope.

### P1 — Singleton with acquireRelease is closed by the first child

A singleton Database was registered whose make uses ResultTask.acquireRelease.
The release flips open to false.

Observed result:

    first use: open=true; releases after finish=1
    second use: open=false; releases=1

The instance stays in the root cache, but the finalizer belongs to the first use's execution scope.
Fix needed: unify the owner of the cache and the finalizers. The documented restriction to use a
separate resource does not protect an API that accepts this make without error.

Location: packages/di/src/module.ts, RuntimeScope.resolve and registerLifetime.

### P1 — Concurrent demands create two singletons

Two runPromise runs executed scope.use simultaneously over the same root and async token.

Observed result:

    returned IDs=[1, 2]; constructions=2

The cache is only filled after creation. This also exposes synchronous factories to the async
gap of task resolution.
Fix needed: share in-flight initialization, define retry after failure and
consumer cancellation, and test shutdown during acquisition.

Location: packages/di/src/module.ts, RuntimeScope.resolve.

### P1 — Resolver drops errors and its own requirements

A resolver returning ResultTask.fail("resolver-failure") produces a workflow assignable to:

    ResultTask<string, never, never>

Actual result: Failure(Fail("resolver-failure")).
provideServiceResolver preserves E of the original task and ignores E/R of the task returned by the resolver.
Fix needed: preserve the resolver's errors, requirements, and releases, and validate the returned
value for each tag. The current public API accepts values unrelated to the requested contract.

Location: packages/resultar/src/result-task.ts, ResultTaskServiceResolver and provideServiceResolver.

### P1 — Defect during release interrupts the remaining finalizers

Two resources were acquired. The second one's release returns a ResultTask.sync that throws Error.

Observed result:

    eventos=["second release"]

The first one's release does not run. RuntimeScope.close uses catchAll, which does not capture Die.
Fix needed: drain all finalizers while preserving Fail/Die/Interrupt and composite causes,
using core semantics. Capturing only the creation of the release task does not fix it.

Location: packages/di/src/module.ts, RuntimeScope.close.

## Other gaps found by inspection

- RuntimeScope.resolve keeps no resolution path and detects no cycles. Tokens now
  allow graphs that do not depend on registration order, making this protection necessary.
- close mutates root state and removes finalizers when building the task, before running it.
  This contradicts the laziness expectation and deserves a dedicated test.
- ServiceClass declares new() returning the contract, but ServiceBase only has static members.
  The API should distinguish a token from an implementation class; the current constructor promises more
  than it delivers.
- The Hono example opens one child for the server's lifetime. It demonstrates scopes but not per-request
  isolation. The adapter needs to cover tenant, concurrency, errors, and SSE completion/cancellation.
- The requirements and errors union is conservative for the whole module. A small selected graph
  may require environments of unused services, complicating isolated tests.

## Recommended order to surpass current DX

1. Fix the six reproduced cases and add type and runtime regressions.
2. Make tokens consistent across registration, selection, override, and externally provided values.
   Choose an explicit identity policy; equal names must not hide wrong contracts.
3. Reduce ceremony: infer the contract from make for simple services and offer a short
   path for existing factories. Keep an explicit contract when it helps mocks and implementations.
   Classes should be an option, without requiring an empty class in every service.
4. Add errors with the dependency path and cycle validation. Do not promise full
   inspection of a dynamic generator graph without running the code or producing metadata.
5. Create a Hono adapter with per-request scope and typed local inputs; adapt ResultAsync at the edge
   while keeping await in the domain method.
6. Add module composition and inference tests on larger graphs. Evaluate aliases after
   an application demonstrates the need.

Example of proposed direction, not yet implemented:

    const root = createModule().singleton(Cache).scoped(Users).scope()
    const result = await root.use(Users, users => users.find("1"))
    const testing = module.override(Users, fakeUsers)

That shape would require token-based selection and explicit ResultAsync support in the callback and at the
execution edge. Merely making the callback async is not enough; its scope must last until the operation finishes.

## Success criterion

Surpassing the DX means adding a service with little code, receiving useful errors before
production, and trusting that the declared lifetime matches real behavior.
The next investment should be fixing these guarantees, followed by less ceremony and
per-request integration. The shorter registration alone does not demonstrate superiority.
