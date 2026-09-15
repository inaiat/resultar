# Native Fastify services

```sh
cd examples/fastify
pnpm dev
```

`pnpm dev` builds the workspace dependencies and starts the server. Run `pnpm smoke`
from the same directory to check the example.

The application exposes `GET /health` (200), `GET /users/1` (200) and `GET /users/2` (404).
Its smoke also checks shared cache state and injects a failing repository to verify the 503 mapping.

Like the Hono example, `main.ts` creates the application with its default services:

```ts
const app = createApplication();
await app.listen({ port: Number(process.env.PORT ?? 3000) });
```

`createApplication()` returns the native Fastify instance synchronously.
It uses `createFastifyApp({ services }, configure)`, matching the Hono example's
factory shape. The callback registers native Fastify route plugins.
Fastify initializes the registered plugins when `listen()`, `inject()` or `ready()` is called.
Tests import `createApplication` from `main.ts` without starting a server or installing signal handlers.
The failure test passes `createServices().override("repository", brokenRepository)` to the same
application factory.

The file layout matches the [Hono example](../hono/README.md):

- [Services](src/services.ts): `Cache`, `UsersRepository`, `Users`, function-based `Health` and DI registration. Repository and service methods return `StrictResultAsync`.
- [Routes](src/routes.ts): native Fastify TypeBox schemas and exhaustive result-to-response mapping.
- [Application](src/main.ts): `createApplication()`, optional `bindings`, inferred `request.services`, route registration and server startup with `PORT`.

Each example contains its own services. Fastify imports `Service`, `service` and
`createModule` directly from `resultar-fastify`. The application omits `bindings`, making cache, repository, users and health available in
`request.services`. Its declaration follows the module automatically. Routes do not repeat
the service list or declare framework types. Use `bindings: ["health", "users"]` to restrict
the exposed view, or `bindings: []` to select none. Omission prepares all registered services
before the handler; it does not defer construction until property access.

The application factory and request declaration live together in `main.ts`:

```ts
import { createFastifyApp, type InferRequestServices } from "resultar-fastify";
import { healthRoutes, usersRoutes } from "./routes.ts";
import { createServices } from "./services.ts";

export const createApplication = (services = createServices()) =>
  createFastifyApp({ services }, (app) => {
    app.register(usersRoutes);
    app.register(healthRoutes);
  });

declare module "fastify" {
  interface FastifyRequest {
    services: InferRequestServices<typeof createApplication>;
  }
}

if (import.meta.main) {
  const app = createApplication();
  await app.listen({ port: Number(process.env.PORT ?? 3000) });
}
```

Declare the repository as a class and reference it directly in the service. The following
excerpt comes from `services.ts`; the function-based health service and registration follow below:

```ts
import {
  createTaggedError,
  ok,
  okAsync,
  Result,
  ResultTask,
  type StrictResultAsync,
} from "resultar";
import { createModule, Service, service } from "resultar-fastify";

export type User = { readonly id: string; readonly name: string };

export class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}) {}

export class UserReadError extends createTaggedError({
  name: "UserReadError",
  message: "Could not read user $id",
}) {}

export class Cache extends Service("cache", {
  make: ResultTask.sync(() => new Map<string, User>([["1", { id: "1", name: "Ada" }]])),
}) {}

export class UsersRepository extends Service("repository", {
  requires: { cache: Cache },
  make: ({ cache }) =>
    ResultTask.sync(() => ({
      findById(id: string): StrictResultAsync<User | undefined, UserReadError> {
        return okAsync(cache.get(id));
      },
      remove(id: string): StrictResultAsync<boolean, never> {
        return okAsync(cache.delete(id));
      },
    })),
}) {}

export class Users extends Service("users", {
  requires: { repository: UsersRepository },
  make: ({ repository }) =>
    ResultTask.sync(() => ({
      findById(id: string): StrictResultAsync<User, UserNotFoundError | UserReadError> {
        return Result.gen(async function* () {
          const user = yield* repository.findById(id);
          if (user === undefined) return UserNotFoundError.err({ id });
          return ok(user);
        });
      },
      remove(id: string): StrictResultAsync<void, UserNotFoundError> {
        return Result.gen(async function* () {
          const removed = yield* repository.remove(id);
          if (!removed) return UserNotFoundError.err({ id });
          return ok(undefined);
        });
      },
    })),
}) {}
```

Classes are DI tokens; the route uses `request.services.users.findById(id)`. The default cache
and repository are constructed lazily and shared by the application's request scopes.
The failing-repository test uses `services.override("repository", brokenRepository)` directly;
`createServices()` remains a zero-argument DI module factory.

## Function-based health service

For a synchronous factory, use `service` with its dependencies directly:

```ts
import { okAsync } from "resultar";
import { service } from "resultar-fastify";
// Cache is declared above in the same services.ts file.

export const Health = service("health", { cache: Cache }, ({ cache }) => ({
  check() {
    return okAsync({ status: "ok", users: cache.size });
  },
}));
```

The factory receives the same inferred cache used by the class-based repository. Each call to
`check()` reads its current size. `services.ts` registers both forms in the same module:

```ts
export const createServices = () =>
  createModule().singleton(Cache).singleton(UsersRepository).scoped(Users).scoped(Health);
```

`GET /health` calls `request.services.health.check()` and returns `{ "status": "ok", "users": 1 }`
with the default data. The default request decorator also exposes `cache` and `repository`. Supplying
`bindings: ["users", "health"]` keeps those dependencies internal to the module.

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

The package test suite also imports this application directly as a use case.
Run `pnpm --filter resultar-fastify test` from the workspace root to include its routes,
repository override and application isolation checks alongside adapter tests.
