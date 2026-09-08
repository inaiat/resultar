# Plan: resultar-hono

Status: Initial API implemented in `packages/hono`, with an example in `examples/hono`.
The text below records the original plan; the current usage reference is the [package README](../packages/hono/README.md).
Migrating private consumers and validating Bun are not part of this delivery.

> **Implemented:** `resultar-hono` ships in `packages/hono` with the example in `examples/hono`.
> The current usage reference is the [package README](../packages/hono/README.md); the plan below
> is the original record.

## Goal and limits

Reduce repetitive integration between Hono and resultar-di: infer the services available in
handlers, keep one root per application and one scope per response, and expose explicit closing.
The package will be `resultar-hono`, in `packages/hono`, with a single entry point.
There will be no `/node`, `/bun`, or `/deno`, no port opening, signal listeners, or server abstraction.

`resultar` keeps tasks and finalization; `resultar-di` keeps resolution, lifetimes, and the Fetch adapter;
`resultar-hono` connects that adapter to Hono. Do not copy `runScopedResponse` into the new package.
Use Hono as a peer dependency, respecting the versions actually verified in tests.
The absence of Node imports is a requirement; declared runtime support depends on running the tests.

## Proposed API

```ts
createHonoApp({ services, bindings }, (app) => {
  // app é uma instância real de Hono, com bindings inferidos.
  app.get(...);
});
```

The result is an application with:

- `fetch(request): Promise<Response>`: entry point for the server.
- `request(input, init?): Promise<Response>`: test convenience, going through the same scope.
- `close(): Promise<Result<void, CloseError>>`: closes the root and preserves cleanup failures.

`CloseError` above is a type variable derived from the module's finalizers, not a new generic error.
If the current `scope.close()` typing does not allow preserving that channel in the wrapper, resolve that
before stabilizing the signature; do not substitute `any` or drop the failure.
The async API can be used with `await`, without requiring `runResult` in the consumer's bootstrap.

The callback configures an ordinary Hono app exactly once. This avoids duplicating every Hono method
in a custom builder or changing its fetch method. The wrapper provides the only public execution
point, so a test call cannot accidentally bypass scopes.
Registering the module does not instantiate its services. The root will be created after route setup;
provider initialization stays on demand.

## Proposed example

Reusing `createServices` from the current example, with singleton Cache and scoped Users/Health:

```ts
// app.ts — proposta, ainda não executável até existir resultar-hono.
import { createHonoApp } from "resultar-hono";
import { createServices } from "./services-module.js";

export const createApplication = (services = createServices()) =>
  createHonoApp({ services, bindings: ["health", "users"] }, (app) => {
    app.get("/health", async (c) => {
      const result = await c.env.health.check();
      return result.match(
        (health) => c.json(health),
        () => c.json({ error: "Health unavailable" }, 503),
      );
    });

    app.delete("/users/:id", async (c) => {
      const result = await c.env.users.remove(c.req.param("id"));
      return result.match(
        () => c.body(null, 204),
        () => c.json({ error: "User not found" }, 404),
      );
    });
  });
```

Without writing `Hono<{ Bindings: ... }>` or repeating the service contracts. An invalid key
in `bindings` or access to an unselected service must fail in TypeScript.
`services-module.ts` will contain only the existing composition; there will be no App/Server tokens
to wire the router to the bindings.

```ts
// Teste da aplicação — proposta.
const app = createApplication();
try {
  const health = await app.request("/health");
  console.log(await health.json()); // Consumir o corpo também conclui o scope da resposta.

  const removed = await app.request("/users/1", { method: "DELETE" });
  console.log(removed.status); // 204: resposta sem corpo, scope já finalizado.
} finally {
  const closed = await app.close();
  closed.match(
    () => console.log("Recursos liberados"),
    (error) => console.error("Falha no encerramento", error),
  );
}
```

The consumer-chosen server receives `app.fetch`. The shutdown cycle stays in
bootstrap: stop new connections, drain or cancel active responses, and await `app.close()`.
Do not close the application right after calling the function that starts listening on the port.
The Node example will keep its server adapter and signal handling outside the package.

## Semantics and decisions

1. One router and one DI root per application; one child scope per response. `request` and `fetch`
   go through exactly the same integration, including overrides and finalization.
2. The scope stays alive until the body is consumed, cancelled, or fails. A middleware with
   `finally` after `await next()` is not enough for streaming. Reuse `ServiceScope.fetch`.
3. `close` is idempotent, waits for consumers per the DI contract, and rejects new
   executions after closing. Unconsumed responses can block shutdown: the consumer
   must consume/cancel bodies, or abort the request.
4. Domain errors stay in `result.match` in the handler. `app.onError` handles errors reaching
   Hono. Resolution failures before the router keep rejecting `fetch` with their cause;
   cleanup errors after the headers affect the stream, without trying to swap its HTTP status.
   Do not create automatic mapping from domain errors to statuses.
5. Unsatisfied external dependencies must block adapter construction by types,
   per the DI contract. Per-request values such as the authenticated tenant
   will not be inferred from headers or middleware: that requires a later, dedicated API.
6. V1 receives only Request and uses `c.env` for selected services. External native bindings,
   ExecutionContext/waitUntil, WebSocket, and Hono RPC are not guaranteed by this first API.
   Do not advertise a full replacement for `Hono.fetch(request, env, executionCtx)`.
   If those uses are needed by a private consumer, revisit the contract before migrating them.
7. Selected services are resolved for every request, including 404s. Do not promise
   per-route resolution; per-route selection is future work, only if a real need arises.

## Implementation steps

1. Prove the types with the current module: bindings inference, close-error preservation,
   rejection of missing external dependencies, overrides, and combined modules. Extract public
   type helpers from DI only if needed, without exposing Graph or runtime internals to the consumer.
2. Create `packages/hono` with manifest, ESM exports, build, README, and dependencies following the
   existing packages' pattern. Implement router setup, delegation to `scope.fetch`,
   request convenience, and closing with a typed result.
3. Verify success, 404, provider and handler failures, bodiless responses, streaming, cancellation,
   abort, failing cleanup, concurrency, repeated close, and calls after close. Compare
   instances to prove shared singleton and request-isolated scoped services.
4. Migrate the DI example, preserving routes and the Node adapter, removing the manual wiring
   `services.http(...router.fetch...)` and the tokens that existed only for that wiring.
   Validate the real requests, interruption, and startup rollback already covered by the example.
5. Validate a private consumer with a local link and run checks/build/tests before deciding to migrate it.
   Check the bindings already in use, streaming, and the server/root close order.
6. Verify the packaged bundle in an isolated consumer and run the Fetch suite on the available
   runtimes. Explicitly document environments not yet verified.

## Completion criteria

The example must declare DI and routes without repeating binding types, without manually assembling a
Fetch adapter, and without artificial tokens for router/server. Bootstrap must keep showing
who closes the application. Tests must demonstrate that this code reduction preserves isolation,
streaming, and finalization. Do not create another routes API, DI runtime, or server adapter.

## References

- [Hono App: fetch and request](https://hono.dev/docs/api/hono)
- [Hono Context: bindings and env](https://hono.dev/docs/api/context)
- [DI and existing Fetch integration](../packages/di/README.md)
- [Response lifecycle implementation](../packages/di/src/fetch.ts)
