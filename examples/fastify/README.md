# Native Fastify services

```sh
pnpm --filter resultar-fastify-example smoke
pnpm --filter resultar-fastify-example start
```

The application exposes `GET /users/1` (200) and `GET /users/2` (404). Its smoke also injects a
failing repository and checks the 503 mapping.

Like the Hono example, `main.ts` creates the application with its default services:

```ts
const app = createApplication();
await app.listen({ port: 3000, host: "127.0.0.1" });
```

`createApplication()` returns the native Fastify instance synchronously.
Fastify initializes the registered plugins when `listen()`, `inject()` or `ready()` is called.
`main.ts` contains both application creation and server startup. Importing it in tests does not
start a server or install signal handlers. The failure test registers `createServices(repository)`
and `usersRoutes` on a native Fastify instance to replace the repository.

- `src/users.ts`: plain service factory, repository contract and typed errors; both async contracts
  return `StrictResultAsync`, with no framework or DI imports.
- `src/services.ts`: default in-memory repository, singleton repository registration, scoped service
  and inferred `request.services` declaration.
- `src/routes.ts`: native Fastify TypeBox schemas and exhaustive result-to-response mapping.
- `src/main.ts`: application creation, ordinary plugin registration, server startup and shutdown.

The sample repository owns no connections. A real database connection should be registered with
`resource` and an explicit release callback, as documented in [resultar-di](../../packages/di/README.md).

Repository adapters convert driver failures to `UserReadError` with `tryResultAsync` or
`fromPromise`. The service composes the repository's result directly and turns a missing user into
`UserNotFoundError`. The in-memory implementation returns `okAsync`.

The checker enables `preferResultAsync: "error"` and `preferResultAsyncMode: "all"`, so both
`Promise<User | undefined>` and inferred Promise-returning implementations fail the check. Native
Fastify plugin and HTTP handler functions retain their framework contracts with local,
documented rule suppressions. Driver callbacks passed to Resultar conversion helpers can likewise
use a local suppression when their Promise return is required for interoperability.
