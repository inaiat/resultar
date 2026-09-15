# Hono + Resultar DI

An example application combining dependency injection with
[Resultar DI](../../packages/di/README.md) and typed routes with
[resultar-hono](../../packages/hono/README.md).

The file layout matches the [Fastify example](../fastify/README.md):

- [Services](src/services.ts): `Cache`, `UsersRepository`, `Users`, function-based `Health` and DI registration.
- [Routes](src/routes.ts): native Hono routes and result-to-response mapping.
- [Application](src/main.ts): `createApplication()`, optional `bindings`, exported `AppHono`, route registration and Node server startup.

Both examples keep `createServices()` separate from framework integration. The application
omits `bindings`, exposing cache, repository, users and health in `c.env`. Pass
`bindings: ["health", "users"]` to restrict the view, or `bindings: []` to select none.
All selected services are resolved before the handler, including when a route uses only health.

---

## Run

From the monorepo root:

```sh
pnpm install
```

### Start the application

```sh
cd examples/hono
pnpm dev
```

`pnpm dev` builds the workspace dependencies and starts the server.

---

## Endpoints

By default the application listens on `http://127.0.0.1:3000`:

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok","users":1}

curl http://127.0.0.1:3000/users/1
# {"id":"1","name":"Ada"}

curl -X DELETE http://127.0.0.1:3000/users/1
# 204 No Content

curl http://127.0.0.1:3000/health
# {"status":"ok","users":0}
```

`PORT` can be configured via an environment variable.

---

## Local services

The example contains its own services and imports the DI API from `resultar-hono`:

```ts
import { Service, service, createModule } from "resultar-hono";
```

`Users` declares `requires: { repository: UsersRepository }`; the repository declares
`requires: { cache: Cache }`. Their methods return `StrictResultAsync`, and the user service
composes lookup and removal through `Result.gen`. `Health` uses the function-based `service`
API and reads the same cache.

## Application and route types

The application and its router type are defined together in `main.ts`:

```ts
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createHonoApp, type InferRequestServices } from "resultar-hono";
import { healthRoutes, usersRoutes } from "./routes.ts";
import { createServices } from "./services.ts";

// The package infers context.env and keeps resources alive until the response finishes.
export const createApplication = (services = createServices()) =>
  createHonoApp({ services }, (app) => {
    usersRoutes(app);
    healthRoutes(app);
  });

export type AppHono = Hono<{ Bindings: InferRequestServices<typeof createApplication> }>;

if (import.meta.main) {
  const app = createApplication();
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
    console.log(`Listening on http://${info.address}:${info.port}/`);
  });
}
```

`routes.ts` imports `AppHono` with `import type`. Both `usersRoutes` and `healthRoutes`
receive `(app: AppHono)` and access services through `c.env`. The type follows the
module by default, or its explicit `bindings` selection, so route files do not list service tokens themselves.
The import is erased at runtime and does not start the server.

## Composition and lifecycle

- `Cache` is a **singleton** (one shared `Map` instance for the whole application lifetime,
  preloaded with user `1` / `Ada`).
- `UsersRepository` is a **singleton** backed by that cache.
- `Users` and `Health` are **scoped** (a fresh instance resolved for each HTTP request).
  `Users.findById` and `Users.remove` return `StrictResultAsync`; `Health.check` returns the
  current user count. Each application owns its cache, independently of other applications.
- `createHonoApp` keeps one DI root and opens a child scope per request, holding scoped
  resources until the response body is fully consumed or canceled.
- `main.ts` passes `app.fetch` directly to `@hono/node-server`; the port comes from `PORT`.
  The server starts only when the file is executed directly, so tests can import `createApplication()`.

---

## Validation

```sh
# Type and Resultar Check rules:
pnpm run check

# Smoke test (drives the routes via app.request):
pnpm run smoke
```

The smoke script (`scripts/smoke.ts`) checks the initial health and user, successful deletion,
repeated deletion and lookup returning 404, and the updated health, then closes the application.
It also checks isolation between applications and a failing repository returning 503.

---

## Limitations

The `Cache` is an in-memory `Map`, not a real database. The example wires no authenticated
request-local values — typed local entries such as the authenticated user still depend on a
framework adapter. It serves through `@hono/node-server` only (see the
[package README](../../packages/hono/README.md) for passing `app.fetch` to other servers;
Bun has not been validated). Binding selection is per request, not per route.

The package test suite also imports this application directly as a use case.
Run `pnpm --filter resultar-hono test` from the workspace root to include lookup, deletion,
health, repository override and application isolation checks alongside adapter tests.
