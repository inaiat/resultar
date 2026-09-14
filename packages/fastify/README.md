# resultar-fastify

Native Fastify plugins and request services backed by `resultar-di`. Routes keep ordinary
`async` handlers, schemas, type providers, `request.log` and `reply.code().send()`.

```sh
pnpm add fastify resultar resultar-di resultar-fastify
```

ESM; Node.js 24+; Fastify 5.12.3+. The plugin uses `fastify-plugin` 6.

## Register native services

```ts
import Fastify from 'fastify'
import { ok } from 'resultar'
import { createModule, service } from 'resultar-di'
import { createFastifyPlugin, type InferRequestServices } from 'resultar-fastify'

const Greeting = service('greeting', {}, () => ({
  async greet(name: string) { return ok({ message: `Hello, ${name}` }) },
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

Define business logic as a plain factory and pass it to `service(name, dependencies, factory)`.
Its methods can return ordinary promises, `Result` or `ResultAsync`; `ResultTask` is optional for
business methods. The [runnable example](../../examples/fastify/README.md) contains an independently
testable service, TypeBox routes, exhaustive `matchTags` and an injected repository.

## Application and request lifetimes

- `services`: a native module, or a sync/async factory receiving the Fastify instance. Each plugin
  registration owns one root, even when the same immutable module is registered in another server.
- `appBindings`: optional singleton selection, initialized during registration and exposed through
  `app.services`. Defaults to an empty selection. `InferAppServices<typeof plugin>` infers its type.
  Scoped/transient selections fail at startup. Unselected providers stay uninitialized.
- `bindings`: the services selected for each request. The plugin resolves them in `preHandler`
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
views from the advanced DI `ServiceAccess` object. Set `requestHook: "onRequest"` when those views
must exist before validation. The default remains `preHandler`. `appBindings` and `bindings`
initialize the explicitly selected services before exposing the corresponding view; empty bindings
allow entirely lazy synchronous factory access. Ordinary ResultTask providers must be initialized
before a synchronous property read, or consumed through `access.use`.

Declare facade options with `satisfies FastifyServicesOptions` before passing them to
`createFastifyPlugin`. `InferAppServices` and `InferRequestServices` then infer the returned view
shapes. `mapError` optionally translates errors at the native Fastify boundary after cleanup.
Do not duplicate scope caches or resource finalizers in the view. Request cleanup, disconnects,
startup rollback and application shutdown remain owned by this adapter.

Facades that historically report startup rollback errors once can set
`rethrowRollbackOnClose: false`. The default retains the cleanup failure on subsequent `close`.
