# Resultar Request Example

Runnable examples for `resultar-request`, `resultar-request-typebox`, and
`resultar-request-zod`.

Run it from the repository root:

```sh
pnpm run example:resultar-request
```

Or run the package directly:

```sh
pnpm --filter resultar-request-example check
pnpm --filter resultar-request-example smoke
pnpm --filter resultar-request-example start
pnpm --filter resultar-request-example typebox
pnpm --filter resultar-request-example zod
```

The `src/` files are intentionally direct examples against a base URL. The `start` script runs
`scripts/server.ts`, which starts a real local HTTP server for manual requests. The smoke script
starts that server, calls it with `fetch`, and shuts it down. The server script is only an HTTP
fixture; TypeBox and Zod request usage stays in `src/` and `scripts/smoke.ts`.

The files are split by validator:

- `src/typebox.ts` shows one direct TypeBox request example.
- `src/zod.ts` shows a direct Zod transform example and a retry example.
- `scripts/server.ts` starts the local HTTP fixture.
- `scripts/smoke.ts` calls that server through the TypeBox and Zod examples.

The `src/typebox.ts` and `src/zod.ts` files are executable with `tsx`. With no argument they start the
local fixture internally; with a base URL argument they call that server instead.

It shows:

- TypeBox response validation with `resultar-request-typebox`.
- Zod response parsing with a transform using `resultar-request-zod`.
- Domain error mapping for HTTP, invalid JSON, request failures, and validation failures.
- Retry over a transient HTTP `503`.

The smoke script checks the expected success and failure branches, including the server-backed fetch
flow.
