# Deno example with resultar-hono

The runnable example lives in [examples/hono](../examples/hono/README.md).

- [Application and routes](../examples/hono/src/app.ts): bindings inferred by resultar-hono.
- [Services](../examples/hono/src/services.ts): singleton cache and scoped services.
- [Deno bootstrap](../examples/hono/src/main.deno.ts): direct instantiation and startup with Deno.serve.

The bootstrap instantiates the application and passes `app.fetch` directly to `Deno.serve`,
with no infrastructure ceremony required. Integration with Resultar DI and the per-request
lifecycle scope stay encapsulated in the Hono application.

To run it, after installing dependencies at the monorepo root:

```sh
pnpm --filter resultar-hono-example build:deps
cd examples/hono
deno task start
```

Set PORT and HOST in the environment. The default is http://127.0.0.1:3000.
Ctrl+C starts graceful shutdown. There is no automatic deadline for persistent streams.

Reference: [graceful shutdown in Deno](https://docs.deno.com/examples/http_server_graceful_shutdown/).
