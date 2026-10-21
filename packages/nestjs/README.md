# resultar-nestjs

`resultar-nestjs` reexports the application DI helpers: `createModule`, `Service`, `service`,
`resource`, and the types `ServiceClass`, `ServiceModule`, `ServiceScope`, `ServiceLifetime`
and `HttpApplication`. These are the original `resultar-di` exports, with the same identity
and behavior. You do not need to import or directly install `resultar-di` for this API.
Keep `resultar-di` as a direct dependency for framework-independent shared services or
when importing framework adapter helpers such as `withProvider` and `useServiceAccess`.
Core helpers such as `ResultTask` continue to come from `resultar`.
The DI package has one entry point; migrate old `resultar-di/advanced` imports to `resultar-di`.

Native NestJS modules, parameter decorators and request services backed by `resultar-di`.
Controllers keep ordinary `async` handlers, `@Controller()`, `@Get()`, `@Post()`, `@Param()`,
`@Body()`, guards, pipes, interceptors, exception filters and `@Res({ passthrough: true })`.

Prefer lazy `ResultTask` values for new async service methods and run them explicitly in controllers.
`ResultAsync` and `StrictResultAsync` are the in-flight `Result` types in `resultar` (returned by `task.runResult()`); existing eager contracts keep one
shared execution and can be adapted with `ResultTask.fromResultAsync(() => legacyMethod())`.

```sh
pnpm add @nestjs/common @nestjs/core @nestjs/platform-fastify reflect-metadata rxjs resultar resultar-nestjs
```

ESM; Node.js 24+; NestJS 11+.

## Register native services

For a new application, `createNestApp(options, configure)` follows the same shape as
Fastify's `createFastifyApp` and Hono's `createHonoApp`. It creates a native NestJS HTTP
application, registers the services module, and calls `configure` once.

The factory accepts `NestAppOptions`, combining the same checked service options as
`createNestModule` with NestJS module metadata (`controllers`, `providers`, `imports`, `exports`)
and `nestOptions`. It does not start a listener or initialize providers; `ready()`, `inject()`
and `listen()` drive initialization, and `close()` releases resources. Its return type,
`NestServicesApplication`, preserves the selected services for `InferRequestServices` and
`InferAppServices` without adding runtime metadata. For an existing NestJS application,
import `createNestModule` in your own `@Module({ imports: [...] })`.

## Optional request bindings

| Configuration | Services resolved and exposed before the handler |
| --- | --- |
| `bindings` omitted | All services registered in the module |
| `bindings: ["users", "health"]` | Only the listed services; their dependencies are resolved internally |
| `bindings: []` | None |

Creating the application still initializes no providers. On a request, the effective selection
is resolved in registration order for the default view, following dependency resolution and
each provider's lifetime. Singletons are reused, scoped services belong to the request and
transients are created per resolution. Reading the resulting view does not resolve them again.

Omission is convenient for small modules. Restrict the list when an unrelated service should
not initialize for those routes: an acquisition failure in any selected service prevents the
handler from running. Missing or incompatible requirements are checked for the effective
selection. No route-body analysis or automatic property-based resolution is performed.

## Routes in separate files

The [runnable example](../../examples/nestjs/README.md) keeps service definitions and
`createServices` in `services.ts`, native controllers in `routes.ts`, and application
creation, request typing and startup in `main.ts`:

```ts
// main.ts
import "reflect-metadata";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { createNestApp, type InferRequestServices } from "resultar-nestjs";
import { HealthController, UsersController } from "./routes.ts";
import { createServices } from "./services.ts";

export const createApplication = (services = createServices()) =>
  createNestApp({
    adapter: new FastifyAdapter({ logger: true }),
    services,
    locals: (request) => ({ log: request.log }),
    controllers: [UsersController, HealthController],
  });

export type AppRequestServices = InferRequestServices<typeof createApplication>;

if (import.meta.main) {
  const app = createApplication();
  await app.listen({ port: Number(process.env.PORT ?? 3000) });
}
```

Controllers inject request services with `@Services() services: AppRequestServices` (or pick a single
service with `@Services("users") users: AppRequestServices["users"]`) or read `request.services`.
Omitted `bindings` exposes the entire registered module; supplying a list restricts the request type
and keeps unselected providers internal.

`InferAppServices<typeof createApplication>` follows `appBindings`. Both inference helpers
accept a factory, an application instance or a `NestServicesModule`; `ReturnType` also remains
supported. Custom `exposeRequest` and `exposeApplication` views retain their inferred types.

Start the example with `pnpm dev` from `examples/nestjs`. The `import.meta.main` guard lets
tests import `createApplication` without starting a listener.

## Existing NestJS applications

To register inside an existing NestJS `@Module()`:

```ts
import "reflect-metadata";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { ResultTask } from "resultar";
import {
  createModule,
  createNestModule,
  service,
  Services,
  type InferRequestServices,
} from "resultar-nestjs";

const Greeting = service("greeting", {}, () => ({
  greet(name: string) {
    return ResultTask.sync(() => ({ message: `Hello, ${name}` }));
  },
}));

const ServicesModule = createNestModule({
  services: createModule().scoped(Greeting),
  bindings: ["greeting"],
});

type RequestServices = InferRequestServices<typeof ServicesModule>;

@Controller("hello")
class HelloController {
  @Get(":name")
  async greet(@Param("name") name: string, @Services() services: RequestServices) {
    const result = await services.greeting.greet(name).runResult();
    return result.match(
      (value) => value,
      () => ({ message: "Error" }),
    );
  }
}

@Module({
  imports: [ServicesModule],
  controllers: [HelloController],
})
class AppModule {}

const app = await NestFactory.create(AppModule, new FastifyAdapter());
await app.listen(3000);
```

Application singletons selected in `appBindings` can also be injected into native NestJS providers
via `@Inject(APP_SERVICES)` or read with `getAppServices(app)`.

## Application and request lifetimes

- `services`: a native module, or a sync/async factory receiving the NestJS application context. Each module
  registration owns one root, even when the same immutable module is registered in another server.
- `appBindings`: optional singleton selection, initialized during module startup and exposed through
  `app.services` and `@Inject(APP_SERVICES)`. Defaults to an empty selection. `InferAppServices<typeof ServicesModule>` infers its type.
  Scoped/transient selections fail at startup. Unselected providers stay uninitialized.
- `startup`: optional `ResultTask<void, E, R>` or `(app: INestApplicationContext) => ResultTask<void, E, R>`
  run once during NestJS module initialization before the server accepts requests.
  Its service requirements are checked against the module, and a failure rolls back the application
  root. Use it for schema setup, seeds or framework-level consumers; it does not expose its values.
- `bindings`: optional services selected for each request. Omission selects all registered
  services, including repositories and caches; `[]` selects none. The module resolves them before
  the controller handler and makes a shallow-frozen object available via `@Services()` and `request.services`
  until response completion.
- `locals`: optional sync/async extraction of externally owned request values. Perform authentication
  in guards (or set `requestHook: "guard"` and run auth earlier) when services need authenticated locals.
  Locals cannot replace registrations or become dependencies of singletons.
- `requestHook`: `"interceptor"` (default, runs after guards) or `"guard"` (runs inside `APP_GUARD`
  when custom guards need `request.services`).

## Completion, cancellation and errors

The adapter keeps `scope.use` callbacks alive through the response, including streamed replies.
Completion, client disconnect and transport failure release each child once. `request.signal`
propagates native disconnect/handler-timeout cancellation to acquisition; pass the same signal to
your own clients and `task.run*` / `ResultTask.run*` calls. Cancellation is cooperative.

Exception filters still have access to `request.services` when a controller throws: scope cleanup
waits until the HTTP response finishes (`close` / `finish` / `error`). Provider acquisition
failures propagate through NestJS's exception pipeline with a Resultar cause attached. Cleanup
failures after the response is sent are logged. `app.close()` waits for request scopes
and releases application singletons; startup failures roll back prior acquisitions. Root cleanup
failures reject shutdown with their causes retained.

Domain results are mapped explicitly with `match` or `matchTags`. The package adds no
error-status table or magic exception serialization policy. See [resultar-di](../di/README.md) for ownership,
[resultar-fastify](../fastify/README.md) for Fastify, and [resultar-hono](../hono/README.md) for Hono.

## Validation

```sh
pnpm --filter resultar-nestjs check:full
pnpm --filter resultar-nestjs smoke:package
pnpm --filter resultar-nestjs-example smoke
```
