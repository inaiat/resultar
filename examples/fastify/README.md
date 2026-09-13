# Native Fastify services

```sh
pnpm --filter resultar-fastify-example smoke
pnpm --filter resultar-fastify-example start
```

The application exposes `GET /users/1` (200) and `GET /users/2` (404). Its smoke also injects a
failing repository and checks the 503 mapping.

- `src/users.ts`: plain service factory, repository contract and typed errors; no framework or DI imports.
- `src/services.ts`: singleton repository, scoped service and inferred `request.services` declaration.
- `src/routes.ts`: native Fastify TypeBox schemas and exhaustive result-to-response mapping.
- `src/app.ts`: ordinary plugin registration; the application owns its server and calls `app.close()`.

The sample repository owns no connections. A real database connection should be registered with
`resource` and an explicit release callback, as documented in [resultar-di](../../packages/di/README.md).
