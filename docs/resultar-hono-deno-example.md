# Deno example with resultar-hono

The maintained runnable example lives in [examples/hono](../examples/hono/README.md)
and starts on Node.js via `@hono/node-server`.

- [Application](../examples/hono/src/main.ts): application creation, inferred bindings and Node startup.
- [Routes](../examples/hono/src/routes.ts): native Hono routes and result-to-response mapping.
- [Services](../examples/hono/src/services.ts): singleton cache and scoped services.

For Deno, create the application with `createHonoApp` and pass `app.fetch` to `Deno.serve`.
Integration with Resultar DI and the per-request lifecycle stays encapsulated in the Hono
application. See the [adapter's runtime guide](../packages/hono/README.md#deno-and-other-servers).

To run it, after installing dependencies at the monorepo root:

```sh
cd examples/hono
pnpm dev
```

Set `PORT` in the environment to change the port from 3000. In a Deno bootstrap, stop and drain
the server before calling `app.close()` so scoped resources can finish with their responses.

Reference: [graceful shutdown in Deno](https://docs.deno.com/examples/http_server_graceful_shutdown/).
