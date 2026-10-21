# Native NestJS services

For new async code, return lazy `ResultTask` workflows and run them explicitly in native controller
methods. This runnable fixture retains eager `ResultAsync` / `StrictResultAsync` service methods
from `resultar` for compatibility coverage. Both types represent one shared in-flight execution.

```sh
cd examples/nestjs
pnpm dev
```

`pnpm dev` builds the workspace dependencies and starts the server. Run `pnpm smoke`
from the same directory to check the example.

The application exposes `GET /health` (200), `GET /users/1` (200) and `GET /users/2` (404).
Its smoke also checks shared cache state and injects a failing repository to verify the 503 mapping.

Like the Fastify and Hono examples, `main.ts` creates the application with its default services:

```ts
const app = createApplication();
await app.listen({ port: Number(process.env.PORT ?? 3000) });
```

`createApplication()` returns the `ResultarNestApp` instance synchronously.
It uses `createNestApp({ services, controllers })`, matching the Fastify and Hono examples'
factory shape. NestJS initializes the registered module and controllers when `listen()`, `inject()` or `ready()` is called.
Tests import `createApplication` from `main.ts` without starting a server or installing signal handlers.
The failure test passes `createServices().override("repository", brokenRepository)` to the same
application factory.

The file layout matches the [Fastify example](../fastify/README.md) and [Hono example](../hono/README.md):

- [Services](src/services.ts): `Cache`, `UsersRepository`, `Users`, function-based `Health` and DI registration. Repository and service methods retain eager `StrictResultAsync` contracts.
- [Controllers](src/routes.ts): native NestJS `@Controller` classes with `@Services()` parameter injection and exhaustive result-to-response mapping.
- [Application](src/main.ts): `createApplication()`, optional `bindings`, controller registration and server startup with `PORT`.

Each example contains its own services. NestJS imports `Service`, `service` and
`createModule` directly from `resultar-nestjs`. The application omits `bindings`, making cache, repository, users and health available in
`@Services()` and `request.services`. Its declaration follows the module automatically. Controllers use `InferRequestServices<ReturnType<typeof createServices>>`
without repeating the service list. Use `bindings: ["health", "users"]` to restrict
the exposed view, or `bindings: []` to select none. Omission prepares all registered services
before the handler; it does not defer construction until property access.

The application factory lives in `main.ts`:

```ts
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { createNestApp } from "resultar-nestjs";
import { HealthController, UsersController } from "./routes.ts";
import { createServices } from "./services.ts";

export const createApplication = (services = createServices()) =>
  createNestApp({
    adapter: new FastifyAdapter({ logger: true }),
    services,
    locals: (request) => ({ log: request.log }),
    controllers: [UsersController, HealthController],
    logger: ["error", "warn"],
  });

if (import.meta.main) {
  const app = createApplication();
  await app.listen({ port: Number(process.env.PORT ?? 3000) });
}
```

## Existing eager service contracts

The compatibility services in `services.ts` match the Fastify and Hono examples:

```ts
export const createServices = () =>
  createModule().singleton(Cache).singleton(UsersRepository).scoped(Users).scoped(Health);
```

`GET /health` calls `services.health.check()` and returns `{ "status": "ok", "users": 1 }`
with the default data. The default request decorator also exposes `cache` and `repository`. Supplying
`bindings: ["users", "health"]` keeps those dependencies internal to the module.

The package test suite also imports this application directly as a use case.
Run `pnpm --filter resultar-nestjs test` from the workspace root to include its routes,
repository override and application isolation checks alongside adapter tests.
