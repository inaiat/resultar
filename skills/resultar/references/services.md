# Typed services and HTTP scopes

Read the installed `resultar-di/README.md`, `resultar-hono/README.md` and `resultar-fastify/README.md` for the exact companion
versions. The primary DI exports are `createModule`, `service`, and `resource`; class tokens and
named factory overloads belong to `resultar-di/advanced`.

- Register a service token with `.singleton(Token)`, `.scoped(Token)`, or `.transient(Token)`.
  Dependency objects are inferred from tokens. Use `service(name, task)` for asynchronous
  initialization; an async function passed as an ordinary factory is a defect in the contract.
- Keep a server's serving-and-waiting task inside its owning `use` / ResultTask scope. Returning a
  live resource from a completed scope returns a resource whose finalizer has already run.
- Use `createHonoApp` for Hono routes. Ordinary `await` and `result.match` inside a route are valid;
  generator-specific restrictions do not apply to a route body.
- Use `createHonoServices(module).middleware(keys, { locals })` to add services to an existing Hono
  router. Inline route middleware infers `c.var.services` while preserving `c.env` and native RPC
  responses. Install one services middleware per request; consume/cancel responses before `close()`.
- Use `createFastifyPlugin({ services, bindings, appBindings?, locals? })` for native Fastify routes.
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
