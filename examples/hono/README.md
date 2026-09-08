# Hono + Resultar DI

An example application combining dependency injection with
[Resultar DI](../../packages/di/README.md) and typed routes with
[resultar-hono](../../packages/hono/README.md).

- [Services](src/services.ts): typed composition with `singleton` and `scoped`.
- [Application](src/app.ts): Hono routes with inferred bindings via `createHonoApp`.
- [Bootstrap](src/main.ts): runs on Node via `@hono/node-server`.

---

## Run

From the monorepo root:

```sh
pnpm install
pnpm --filter resultar-hono-example build:deps
```

### Start the application

```sh
pnpm --filter resultar-hono-example start
# or inside examples/hono:
pnpm start
```

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

`PORT` and `HOST` can be configured via environment variables.

---

## Composition and lifecycle

- `Cache` is a **singleton** (one shared `Map` instance for the whole application lifetime,
  preloaded with user `1` / `Ada`).
- `Users` and `Health` are **scoped** (a fresh instance resolved for each HTTP request).
  `Users.find` and `Users.remove` return `ResultAsync`; `Health.check` returns the current
  user count.
- `createHonoApp` keeps one DI root and opens a child scope per request, holding scoped
  resources until the response body is fully consumed or canceled.
- The bootstrap passes `app.fetch` directly to `@hono/node-server`; port and hostname come
  from `PORT` and `HOST`. Server shutdown stays in the bootstrap: stop the server first,
  then await `app.close()`.

---

## Validation

```sh
# Type and Resultar Check rules:
pnpm run check

# Smoke test (drives the routes via app.request):
pnpm run smoke
```

The smoke script (`scripts/smoke.ts`) exercises `GET /health`, `DELETE /users/:id`,
`GET /users/:id` after deletion, and the updated `GET /health`, then closes the application.

---

## Limitations

The `Cache` is an in-memory `Map`, not a real database. The example wires no authenticated
request-local values — typed local entries such as the authenticated user still depend on a
framework adapter. It serves through `@hono/node-server` only (see the
[package README](../../packages/hono/README.md) for passing `app.fetch` to other servers;
Bun has not been validated). Binding selection is per request, not per route.
