# Services and ecosystem packages

Read the matching package README before generating framework or request code.
These manuals are included in the published agent bundle; installed declarations
win when companion versions differ from the bundle's `versions.json`.

## Core services and DI

Core [service requirements](../../../DOCUMENTATION.md#lazy-tasks-and-service-requirements)
use `serviceTag` / `ResultTask.service`, `provideService`, `provideServices`,
`provideServiceResolver`, and runner `services` options. Do not require `R = never`
before calling a runner that receives the required services.

The [DI manual](../../../packages/di/README.md) covers:

- `Service`, `Service.require`, `service`, `resource`, and `createModule`;
- named/token registration: `value`, `singleton`, `scoped`, `transient`, `task`, `resource`;
- immutable `merge` and type-checked `override` (an externally owned replacement value);
- `use`, `scope`, `withServices`, `useSingletons`, `close`, `http`, and `scope.fetch`;
- framework author APIs: `withProvider`, `inspectModule`, `useServiceAccess`,
  `ServiceAccessError`, and `startServiceTask`.

A singleton cannot capture scoped/transient/request-local dependencies; scoped
providers cannot capture transient dependencies. Register dependencies before their
dependents. `value` and `override` do not transfer disposal ownership. Use task
providers for fallible initialization and resource providers for acquisition/release.
`scope.close()` waits for active children and releases root resources. Streaming
HTTP lifetimes need `http` / `fetch` ownership through body consumption, not only
through creation of the Response.

## Frameworks

| Package | Features and boundary |
| --- | --- |
| [Hono](../../../packages/hono/README.md) | `createHonoApp`, `createHonoServices`, inferred request services, optional bindings, locals, startup and response-body lifetime; Deno/server limitations |
| [Fastify](../../../packages/fastify/README.md) | `createFastifyApp`, `createFastifyPlugin`, `request.services`, `app.services`, request/app bindings, locals, startup, cancellation, close and exposure policy |
| [NestJS](../../../packages/nestjs/README.md) | `createNestApp`, `createNestModule`, `Services`, `APP_SERVICES`, `getRequestServices`, `getAppServices`, inferred request/app services, bindings, locals and native lifecycle |

Select the adapter for the existing framework. Keep framework-native request,
reply, decorators, and bootstrap contracts at the boundary. App bindings must
satisfy singleton lifetime rules; request bindings select request-visible services.
Read each adapter's startup, error, streaming, and shutdown sections before promising
resource behavior. The [framework examples](../../../README.md#runnable-examples) are executable
integration projects, including external route/controller files.

## Outbound HTTP

[`resultar-request`](../../../packages/request/README.md) supplies lazy `requestJsonTask`
(returning `ResultTask<T, E>`) and eager `requestJson` (returning `ResultAsync<T, E>`),
Fetch/Undici response support, validators/decoders, status and body checks, cancellation-aware retry,
and stage-preserving domain `mapError`. Its public error helpers are `RequestError`,
`HttpResponseErrorCauseError` (also `HttpClientRequestErrorCause`),
`baseRequestErrorHandler`, `integrationErrorHandler`, and `isHttpResponseError`.
The README describes structured error contexts and exported transport/validation types.

[`resultar-request-zod`](../../../packages/request-zod/README.md) adds `requestJsonZodTask` /
`requestJsonZod` and derives transformed success from `z.output<Schema>`.
[`resultar-request-typebox`](../../../packages/request-typebox/README.md) adds
`requestJsonTypeBoxTask` / `requestJsonTypeBox` and infers `Static<Schema>`. Both offer
package-local `requestJsonTask` and `requestJson` aliases and re-export the base public API.

Raw Promise-returning SDK/database drivers use `ResultTask.tryPromise` directly
inside repository adapters; new repository/service methods expose Tasks, not Promises.

For new lazy HTTP orchestration, return `requestJsonTask` / `requestJsonZodTask` /
`requestJsonTypeBoxTask` directly without `async` or `ResultTask.fromResultAsync`:

```ts
const load = requestJsonTask({
  request: signal => fetch(url, { signal }),
  validator: isPayload,
})
```

Preserve `requestJson` in existing eager `ResultAsync` callers (passing `signal` to cancel
attempts and retry delays), and use `ResultTask.fromResultAsync(signal => existingAsyncHelper(signal))`
when bridging an existing `ResultAsync` helper into a Task. `url` and `isPayload` above are
application-specific. The complete [request example](../../../examples/request/README.md) and
[agent evaluation cases](../evals/cases.mjs) demonstrate plain, Zod, and TypeBox validation,
cancellation, and lazy execution. Keep retry ownership explicit; do not retry invalid payloads merely
because they arrived over HTTP. Use the helpers rather than duplicating HTTP
status/JSON/error mapping logic, unless the application's contract requires it.
