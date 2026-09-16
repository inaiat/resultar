# Typed services and HTTP scopes

Read the installed `resultar-di/README.md`, `resultar-hono/README.md` and `resultar-fastify/README.md` for the exact companion
versions. The application DI helpers are `createModule`, `service`, `Service`, and `resource`.
Named factory overloads and low-level adapter access use the same `resultar-di` entry point.
The former `/advanced` subpath has been removed; migrate existing imports to `resultar-di`.

- Use `ResultTask.service<Contract>()('name')` in core or `Service.require<Contract>()('name')`
  in DI to infer the literal identifier. The direct core overload remains supported; do not invent
  `Result.service`. Service requirements are represented by `R` in `ResultTask<T, E, R>`.
- Declare class services with `Service('name', { requires: { alias: Token }, make: ({ alias }) =>
({ ... }) })`. The readonly dependency object is inferred; `make` can return the service
  object directly or a ResultTask. Factories remain lazy and synchronous values add no typed
  initialization errors. Promises and thenables are rejected. Use `ResultTask.gen` for
  initialization with typed failures, additional requirements or owned resources. Without `requires`, pass a task directly as `make` and yield requirements inline or by token.
  Both forms support `Service<Contract>()('name', definition)`.
- Keep provider registration explicit. `requires` does not acquire or register dependencies.
  Inline tokens resolve by name in DI or `provideServices`; core `provideService` supplies an exact
  token binding plus a named fallback. Reuse the same token for exact identity when identifiers
  collide; separately created tags can resolve the named fallback.
- Register a service token with `.singleton(Token)`, `.scoped(Token)`, or `.transient(Token)`.
  Dependency objects are inferred from tokens. Use `service(name, task)` for asynchronous
  initialization; an async function passed as an ordinary factory is a defect in the contract.
- Keep a server's serving-and-waiting task inside its owning `use` / ResultTask scope. Returning a
  live resource from a completed scope returns a resource whose finalizer has already run.
- Use `createHonoApp` for Hono routes. Ordinary `await` and `result.match` inside a route are valid;
  generator-specific restrictions do not apply to a route body.
  Export `type AppHono = Hono<{ Bindings: InferRequestServices<typeof createApplication> }>`
  from `main.ts`, using `InferRequestServices` from `resultar-hono`. Separate route files import
  `AppHono` with `import type` and receive `(app: AppHono)`. Bindings follow the application
  selection without repeating service tokens.
- `bindings` is optional in `createHonoApp`, `createFastifyApp` and `createFastifyPlugin`.
  Omission selects all registrations; an explicit list restricts the view and `[]` selects none.
  Selected services resolve before the handler, preserving each lifetime and resource ownership.
  Unused default-selected services can still fail acquisition and prevent the handler.
  Fastify `appBindings` continues to default to `[]`; locals satisfy requirements without being
  automatically exposed as registrations. The Hono middleware API still takes explicit keys.
- `startup` is optional in the native application adapters and accepts a `ResultTask<void, E, R>`
  whose requirements are checked against the module. Fastify runs it in `onReady` after plugin
  loading and also accepts `(app: FastifyInstance) => ResultTask<void, E, R>`. Hono runs it on
  `ready()` or before the first request. Direct resources live until close and release before
  singleton dependencies; scoped/transient dependencies are rejected. A failure rolls back the
  application root, preserving cleanup causes. Hono close cancels pending startup cooperatively.
- Use `createHonoServices(module).middleware(keys, { locals })` to add services to an existing Hono
  router. Inline route middleware infers `c.var.services` while preserving `c.env` and native RPC
  responses. Install one services middleware per request; consume/cancel responses before `close()`.
- Use `createFastifyApp({ services, bindings? }, configure)` for a new native Fastify application,
  or `createFastifyPlugin({ services, bindings?, appBindings?, locals? })` for an existing server.
  Derive `FastifyRequest.services` once with
  `InferRequestServices<typeof createApplication>` directly in `main.ts` or in a declaration
  file included by TypeScript. `InferAppServices` also accepts the application return type. Both follow the
  selected bindings or custom exposed views; no global types or runtime metadata are installed
  by the adapter. Native routes and autoload do not need wrappers.
  `app.services` contains the selected startup singletons; `request.services` is available from
  `preHandler` through response completion. Register authentication providing locals earlier.
  Infer decorators with `InferAppServices` / `InferRequestServices`; augment Fastify in the application
  or use its typed `getDecorator`. Annotate module/locals callback parameters with native Fastify
  types when their inferred return values participate in selection checking.
- Keep business logic in plain factories with async methods when sufficient. Register them using
  `service(name, dependencies, factory)`. Map results explicitly through `matchTags` and native
  response APIs; the framework adapters install no status table or `reply.result` helper.
- `scope.useSingletons(keys, callback)` restricts selected services and callback tokens to the root
  lifetime. Keep its callback active while serving; it is not a free-standing resolver. Factory
  initialization stays lazy until selection; resource release remains explicit.
- `scope.fetch`, `services.http`, and `createHonoApp` keep the request scope open until the Response
  body ends, fails, or is canceled. Tests must consume or cancel response bodies before shutdown.
- Stop and drain the server, finish/cancel persistent streams, then await application close.
  Handle typed release errors; defects and composite causes may reject `close()`.
- Supply authenticated request locals through the appropriate per-request integration. A singleton
  cannot capture scoped services or request-local data. Extracting authentication remains the
  framework adapter's responsibility.

For a complete runnable pattern, see the workspace `examples/hono/` and `examples/resultar/`
application lifecycle examples. The distributed guide includes the checked core recipe at
`examples/workflow.mjs`; use the published declarations to adapt companion integrations.

## Framework DI exports

`resultar-fastify` and `resultar-hono` reexport the application DI helpers: `createModule`, `Service`,
`service`, `resource`, plus `HttpApplication`, `ServiceClass`, `ServiceLifetime`, `ServiceModule`
and `ServiceScope` types. In framework-specific code, import these from the adapter together
with its integration helpers. Core APIs such as `ResultTask` still come from `resultar`.
Keep direct `resultar-di` imports and dependencies in framework-independent shared code and
for framework adapter helpers such as `withProvider` and `useServiceAccess`. Check the installed adapter exports before using this convenience
with older versions.

## Runnable HTTP examples

The maintained Fastify and Hono examples each contain their own `services.ts`, `routes.ts`
and `main.ts`. `services.ts` declares `Cache`, `UsersRepository` and `Users` classes,
function-based `Health`, and the `createServices` module factory. `main.ts` omits
`bindings` and owns framework typing and startup. The default request view includes all
registered services, including the cache and repository. Do not introduce
a shared package, separate `users.ts` or an extra `app.ts` for these small examples.
Start either example with `pnpm dev` from its directory; `PORT` defaults to 3000.
