# Awilix vs Resultar composition root

- Status: Note
- Date: 2026-09-05
- Scope: DX of replacing Awilix in Resultar consumers
- Case: a private consumer API (`createAppContainer` → `createAppServices`)

Review after RFC 0001: replacing the container still requires no DI API. Lifecycle,
however, is a concrete case for `ResultTask.acquireRelease` + `scoped`, now implemented as
a slice of Phase 3. The lifecycle example lives in `examples/resultar/src/application-lifecycle.ts`;
adoption by the real private adapters is still pending.

## Summary

Awilix and Resultar solve different problems. Awilix is a DI container. Resultar is the
typed error channel. In that API, Awilix did not inject classes or create a scope per request: it
only assembled singleton factories and called two disposers.

The correct swap in this graph is not `ResultTask.service` in each use case. It is an explicit
composition root (`createAppServices`) that Hono reads at the HTTP edge. Resultar already covered the rest
(`StrictResultAsync`, tagged errors, `safeTry`, `runPromise`).

Verdict after the migration:

- production path: DX **better or equal**;
- HTTP test path: DX **worse**, until the type Hono requires is narrowed;
- Resultar does **not** need a new API for this swap;
- recreating Awilix, Layer, or lifetimes in core is not worth it.

## What Awilix did in that consumer

Three registration groups:

| Group | Examples | Role |
| --- | --- | --- |
| Values | `appConfig`, `logger` | `asValue` — already existed outside the container |
| Infra | `dbClient`, repos, jwt, hasher, S3, realtime, session, schema | `asFunction(...).singleton()` |
| App | 12 use cases + boot helpers | factories that read the cradle via PROXY |

The only real lifecycles were the disposers of `dbClient` and `sessionClient`. Everything else
was "call the factory once and cache it". The routes resolved nothing: they did
`c.get("container").cradle.authUseCase.loginTenant(...)`. The tests assembled a minimal container
with `asValue`.

The factories already received a named object (`{ dbClient }`, `ArenaUseCaseDependencies`). The
PROXY only filled those keys from the parameter name.

## DX comparison

| Task | Awilix | Composition root |
| --- | --- | --- |
| Understand the graph | Names in PROXY; order is implicit | `createAppServices` shows the order |
| Add a singleton | `asFunction(createX).singleton()` and the parameter name has to match | Call the factory and return it in the object |
| Missing dependency | Runtime failure (`strict`) | Compile failure in the typed factory |
| HTTP route | `c.get("container").cradle.authUseCase` | `c.get("app").authUseCase` |
| Dispose | Hidden `.disposer()` | Visible `services.dispose()`, in Resultar |
| Route test | Minimal container + `asValue({} as never)` in stubs | `as unknown as AppServices` |
| Folder auto-load | Available, not used here | Does not exist; the single file is enough |
| Lifetimes | `SINGLETON` / `SCOPED` / `TRANSIENT` | Everything is a process singleton; scope is the object passed at the edge |

Awilix saved ceremony when registering the 21st service (one line). In return TypeScript
could not see the graph, and a misnamed parameter only broke at runtime.

The composition root gains a visible graph, a missing dep as a type error, Resultar dispose, and one
fewer dependency. Adding the 21st service is one more line, explicit.

What **did not** change — and was already Resultar DX:

- use cases returning `StrictResultAsync`;
- tagged errors at the HTTP edge;
- `sendResult` with `.match`;
- boot with `safeTry` / `tryResultAsync`.

## Where DX improved

### Visible graph

`createAppServices` builds in order: database client, repositories, jwt/hasher/storage,
realtime, schema, session events, session client, use cases. Anyone opening the file sees the
coupling. In Awilix that was scattered across registration names.

### A missing dependency is a type

`createJwtService({ appConfig })` and `createHealthUseCase({ databaseHealthRepository })` were already
typed. Without PROXY, the call in the composition root is the point where the compiler rejects an incomplete
graph. Awilix `strict` only complained at resolution time.

`arenaDeps` makes explicit what PROXY hid: almost every use case receives the same
`ArenaUseCaseDependencies` bag, not a minimal constructor.

### Dispose aligned with the rest of the app

Shutdown stops being a generic `container.dispose()`. `services.dispose()` closes the session client and
then the database, both even if the first fails, and returns `StrictResultAsync<void, AppLifecycleError>`.

### Slightly shorter routes

```ts
c.get("container").cradle.authUseCase.loginTenant(body)
c.get("app").authUseCase.loginTenant(body)
```

The pattern is still a service locator in the Hono context. It just lost one level (`.cradle`).

## Where DX regressed

### Route tests lost the type

This is the one regression that should be treated as a problem, not a matter of taste:

```ts
const createTestApp = (
  healthUseCase: AppServices["healthUseCase"],
  logger: AppServices["logger"] = createAppLogger(),
): AppServices =>
  ({
    appConfig: loadAppConfig({}),
    healthUseCase,
    logger,
  }) as unknown as AppServices
```

Awilix also required stubs (`as never` on `dbClient` and friends), but what the test
*registered* stayed typed. Now the test asserts that the omitted services exist. The
`healthUseCase` parameter stays typed: an incompatible `check` signature is rejected. The assertion
hides the absence of the other services required by the full application.

### Hono carries the whole process

`createHonoApp(services: AppServices)` requires `dbClient`, `schemaBootstrap`,
`connectDbClient`, and `dispose`. No route uses those. SSE only needs `realtimeEventBus`.
Auth only needs `authUseCase` and `appConfig`. The cradle had the same problem; the swap did not fix it.

### The `app` name collides with Hono

`registerArenaTenantChatRoutes = (app) => { ... c.get("app") }` mixes the Hono app with the
composition root. `services` would be the right name for the context variable.

### The folder is still called `container`

Anyone entering the repository looks for Awilix. The file is now `app-services.ts`.

## What should not be done

- Do not bring Awilix back. The composition root is the right model for a graph of process
  singletons.
- Do not put `ResultTask.service` in each use case now. The use cases already close over
  `arenaDeps` and return `StrictResultAsync`. Tags do not improve the HTTP route.
- Do not add folder auto-load. One file with ~20 factories is readable. Auto-wiring by name was the
  bad part of Awilix.
- Do not add `Layer`, lifetimes, or a scope runtime to Resultar because of this app. RFC
  0001 defers `Layer` until there is evidence of real usage. Two disposers are not that evidence.

`ResultTask.service` / `provideServices` / `runResult` already exist in 3.6 and suffice if a program
wants the type to forbid execution without `Database` or `Clock`. That is a second step, not the
HTTP container replacement.

## Recommended improvements in the consumer

In order of value:

1. **Typed HTTP surface**, without the infrastructure bag.

   ```ts
   export type AppHttpServices = Pick<
     AppServices,
     | "appConfig"
     | "logger"
     | "authUseCase"
     | "healthUseCase"
     | "chatUseCase"
     | "realtimeEventBus"
   // only what routes and middleware read
   >

   export const createHonoApp = (services: AppHttpServices): ConsumerHonoApp => { /* ... */ }
   ```

   This `Pick` shrinks the contract but still requires every selected field. To test only
   `/health`, extract a route factory with minimal dependencies; tests of the full application
   need a complete, typed `AppHttpServices` fixture.

2. **Route factory and test fixture** instead of the assertion. Example of a proposed API for
   an isolated route, after extracting `createHealthRoutes`:

   ```ts
   createHealthRoutes({
     logger,
     healthUseCase: {
       check: () => okAsync({ database: "connected", status: "healthy" }),
     },
   })
   ```

3. **Mechanical rename:** `container` folder → `composition` (or `app-services.ts` at the root of
   `infrastructure`), and `c.get("app")` → `c.get("services")`.

Optional and low value: `const servicesOf = (c) => c.get("services")` in routes. The noise today
is `c.get("app").chatUseCase`, not the lack of a DI.

## Implications for Resultar

No DI API is needed to replace Awilix in this shape. The resource-management improvement is a
separate front: `acquireRelease` + `scoped` preserve execution and release failures, per
RFC 0001. The HTTP → session → database order and control of restore tasks remain
the application composition's responsibility; the current slice does not implement fibers yet.

What core already offers and the consumer should use:

- `Result` / `StrictResult` for validation and pure rules;
- `ResultAsync` / `StrictResultAsync` for I/O and use cases that already close over deps;
- `createTaggedError` at the edge;
- `tryResultAsync` / `safeTry` in boot and dispose;
- `ResultTask` only when the program needs to declare `R` requirements and receive them at execution time.

What stays out of core, on purpose:

- global container;
- auto-wiring by parameter name;
- lifetimes;
- `Layer`.

The evidence from this consumer confirms the RFC 0001 decision: lightweight service tokens in
`ResultTask`, composition root in the application, no runtime DI.

## Conclusion

For writing domain features, DX is better: visible graph, a missing dep is a type, dispose is
Resultar, one fewer dependency.

For writing HTTP tests, DX is worse until the Hono type is narrowed. Without that, the swap is
architecturally correct and loose at the test edge — the same service locator as before, with an
uglier cast.

Improve (1) and (2) in the consumer. The rename is hygiene. The rest of Awilix is not missed in this
project, and should not be reintroduced into Resultar.
