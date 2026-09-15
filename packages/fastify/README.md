# resultar-fastify

`resultar-fastify` reexports the application DI helpers: `createModule`, `Service`, `service`,
`resource`, and the types `ServiceClass`, `ServiceModule`, `ServiceScope`, `ServiceLifetime`
and `HttpApplication`. These are the original `resultar-di` exports, with the same identity
and behavior. You do not need to import or directly install `resultar-di` for this API.
Keep `resultar-di` as a direct dependency for framework-independent shared services or
when importing framework adapter helpers such as `withProvider` and `useServiceAccess`.
Core helpers such as `ResultTask` and `okAsync` continue to come from `resultar`.
The DI package has one entry point; migrate old `resultar-di/advanced` imports to `resultar-di`.

Native Fastify plugins and request services backed by `resultar-di`. Routes keep ordinary
`async` handlers, schemas, type providers, `request.log` and `reply.code().send()`.

```sh
pnpm add fastify resultar resultar-fastify
```

ESM; Node.js 24+; Fastify 5.12.3+. The plugin uses `fastify-plugin` 6.

## Register native services

For a new application, `createFastifyApp(options, configure)` follows the same shape as
Hono's `createHonoApp`. It creates a native Fastify instance, registers the services plugin,
and calls `configure` synchronously once.

The factory accepts the same checked service options as `createFastifyPlugin`. It does not
start a listener or initialize providers; native `ready()`, `inject()` and `listen()` drive
initialization, and `close()` releases resources. Its return type, `FastifyServicesApplication`,
preserves the selected services for `InferRequestServices` and `InferAppServices` without adding
runtime metadata. For an existing server or custom Fastify constructor
options, register `createFastifyPlugin` on your own instance.

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

The [runnable example](../../examples/fastify/README.md) keeps service definitions and
`createServices` in `services.ts`, native route plugins in `routes.ts`, and application
creation, request typing and startup in `main.ts`:

```ts
// main.ts
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

Route plugins read `request.services.users` and `request.services.health`. They do not
repeat service tokens or add declarations. Omitted `bindings` exposes the entire registered
module; supplying a list restricts the request type and keeps unselected providers internal. The declaration can also live in a `.d.ts` file
included by TypeScript, but the example needs no separate declaration file.

`InferAppServices<typeof createApplication>` follows `appBindings`. Both inference helpers
accept a factory, an application instance or a services plugin; `ReturnType` also remains
supported. Custom `exposeRequest` and `exposeApplication` views retain their inferred types.
Native routes and autoload remain supported when registered within the service plugin's scope.

Start the example with `pnpm dev` from `examples/fastify`. The `import.meta.main` guard lets
tests import `createApplication` without starting a listener.

## Existing Fastify applications

To register on an existing instance:

```ts
import Fastify from 'fastify'
import { okAsync } from 'resultar'
import { createModule, service, createFastifyPlugin, type InferRequestServices } from 'resultar-fastify'

const Greeting = service('greeting', {}, () => ({
  greet(name: string) { return okAsync({ message: `Hello, ${name}` }) },
}))

const plugin = createFastifyPlugin({
  services: createModule().scoped(Greeting),
  bindings: ['greeting'],
})

type Services = InferRequestServices<typeof plugin>
declare module 'fastify' {
  interface FastifyRequest { services: Services }
}

const app = Fastify()
await app.register(plugin)
app.get<{ Params: { name: string } }>('/hello/:name', async (request, reply) => {
  const result = await request.services.greeting.greet(request.params.name)
  return result.match(value => reply.send(value), () => reply.code(500).send())
})
await app.listen({ port: 3000 })
```

Use `Service` classes with `requires` for dependencies, or
`service(name, dependencies, factory)` for a function-based service. The
[runnable example](../../examples/fastify/README.md) combines class-based `UsersRepository`
and `Users` with function-based `Health`. Business methods return `StrictResultAsync`,
compose operations through `Result.gen`, and map errors explicitly in TypeBox routes.

## Application and request lifetimes

- `services`: a native module, or a sync/async factory receiving the Fastify instance. Each plugin
  registration owns one root, even when the same immutable module is registered in another server.
- `appBindings`: optional singleton selection, initialized during registration and exposed through
  `app.services`. Defaults to an empty selection. `InferAppServices<typeof plugin>` infers its type.
  Scoped/transient selections fail at startup. Unselected providers stay uninitialized.
- `bindings`: optional services selected for each request. Omission selects all registered
  services, including repositories and caches; `[]` selects none. The plugin resolves them in `preHandler`
  and makes a shallow-frozen object available as `request.services` until response completion.
- `locals`: optional sync/async extraction of externally owned request values. Perform authentication
  in earlier `onRequest`/`preValidation` hooks when services need authenticated locals. Locals cannot
  replace registrations or become dependencies of singletons.
- `name`: optional native plugin name, defaulting to `resultar-fastify`.

For configuration and locals, annotate callback parameters with the native framework types so
TypeScript can infer the complete graph before checking selections:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'

const plugin = createFastifyPlugin({
  services: (app: FastifyInstance) => features.value('settings', app.getDecorator<Settings>('settings')),
  bindings: ['users'],
  locals: (request: FastifyRequest) => ({ tenant: request.getDecorator<string>('tenant') }),
})
```

Declaration merging describes the application's registration; it does not install the plugin or
make services available before `preHandler`. Register the plugin before its routes. For differently
typed encapsulated contexts, use Fastify's `getDecorator<InferRequestServices<typeof plugin>>('services')`
instead of one global declaration. The package itself installs no global TypeScript augmentation.

Factory execution, dependency ordering, caching and lifetime validation belong to `resultar-di`.
Selected bindings are materialized once; reading a transient binding twice does not resolve it twice.
Use `resource` for owned connections and explicit cleanup. Values and externally supplied objects
are not automatically disposed by inspecting their methods.

## Completion, cancellation and errors

The adapter keeps `scope.use` callbacks alive through the response, including streamed replies.
Completion, client disconnect and transport failure release each child once. `request.signal`
propagates native disconnect/handler-timeout cancellation to acquisition; pass the same signal to
your own clients and `ResultTask.run*` calls. Cancellation is cooperative.

Fastify 5.12 can emit a generic abort when a fully received request body closes. The adapter
ignores that input-completion signal so JSON uploads retain their scopes through the response.
Response close/error events still handle client disconnects after upload; explicit native
timeout reasons remain cancellation signals. This does not change Fastify's own `request.signal`.

`onError` alone does not close services: the native error handler may still need them. Provider
failures go to Fastify's configured error handler with a Resultar cause attached. Cleanup failures
after the response is sent are logged through `request.log`. `app.close()` waits for request scopes
and releases application singletons; startup failures roll back prior acquisitions. Root cleanup
failures reject shutdown with their causes retained.
Cleanup ownership is registered before acquisition, including Fastify plugin timeouts; pending
startup work must settle before its resources can be released.

Internal readiness, completion and shutdown use `ResultAsync`; lifecycle signals are adapted with
`ResultAsync.fromCallback`. Readiness failures are typed `Err` values. Completion retains the full
`Exit`, including interruptions and composite release failures, without starting a second execution.
Native module/locals callbacks continue to accept ordinary async functions.

The adapter composes native lifecycle failures with `tryResult`, `tryResultAsync`, `orElse` and `mapErr`.
Rollback is awaited before `unwrapOrThrow()` hands the original failure back to Fastify;
initialization and rollback failures are retained together when both fail.

Fastify owns listeners, connection draining and shutdown settings. Stop accepting requests and
finish/cancel persistent streams before awaiting close. WebSocket upgrades and `reply.hijack()`
are outside this response lifecycle.

Domain results are mapped explicitly with `match` or `matchTags`. The package adds no `reply.result`,
error-status table or serialization policy. See [resultar-di](../di/README.md) for ownership and
[resultar-hono](../hono/README.md) for the equivalent native Hono middleware.

## Validation

```sh
pnpm --filter resultar-fastify check:full
pnpm --filter resultar-fastify smoke:package
pnpm --filter resultar-fastify-example smoke
```

## Framework facades

A framework can preserve its own service property API while sharing the native DI runtime.
Use `exposeApplication(access, app)` and `exposeRequest(access, request)` to construct service
views from the DI `ServiceAccess` object. Set `requestHook: "onRequest"` when those views
must exist before validation. The default remains `preHandler`. `appBindings` and `bindings`
initialize the effective selection before exposing the corresponding view. Omitted `bindings`
selects all registrations even with `exposeRequest`; empty bindings
allow entirely lazy synchronous factory access. Ordinary ResultTask providers must be initialized
before a synchronous property read, or consumed through `access.use`.

Declare facade options with `satisfies FastifyServicesOptions` before passing them to
`createFastifyPlugin`. `InferAppServices` and `InferRequestServices` then infer the returned view
shapes. `mapError` optionally translates errors at the native Fastify boundary after cleanup.
Do not duplicate scope caches or resource finalizers in the view. Request cleanup, disconnects,
startup rollback and application shutdown remain owned by this adapter.

Facades that historically report startup rollback errors once can set
`rethrowRollbackOnClose: false`. The default retains the cleanup failure on subsequent `close`.
