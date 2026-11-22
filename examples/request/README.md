# Request Example

Runnable examples for `resultar-request`, `resultar-request-typebox`, and
`resultar-request-zod`.

All request adapters (`requestJson`, `requestJsonTypeBox`, `requestJsonZod`) and this server
fixture return lazy, repeatable `ResultTask` workflows directly. Compose retries, timeouts, and
cancellation on the task, then execute explicitly with `.runResult()`.

Run it from the repository root:

```sh
pnpm run example:request
```

Or run the package directly:

```sh
pnpm --filter resultar-request-example build:deps
pnpm --filter resultar-request-example check
pnpm --filter resultar-request-example smoke
pnpm --filter resultar-request-example start
pnpm --filter resultar-request-example typebox
pnpm --filter resultar-request-example zod
```

Installation does not build packages. The execution and smoke scripts build their workspace
dependencies explicitly; run `build:deps` before a standalone `check`.

The `src/` files start a real local HTTP server, call it with `fetch`, and release it through
`ResultTask.acquireRelease` + `ResultTask.scoped`. The `start` script runs `src/server.ts` separately for manual
requests. The server script is only an HTTP fixture; TypeBox and Zod request usage stays in `src/`
and `scripts/smoke.ts`.

The files are split by validator:

- [`src/typebox.ts`](src/typebox.ts) shows one direct TypeBox request example.
- [`src/zod.ts`](src/zod.ts) shows one direct Zod transform example.
- [`src/account-server.ts`](src/account-server.ts) defines the local HTTP fixture with typed Resultar
  boundaries (`ResultTask.fromCallback` and `ResultTask.acquireRelease`).
- [`src/server.ts`](src/server.ts) runs that fixture and manages its lifecycle with
  `ResultTask.scoped`.
- [`scripts/smoke.ts`](scripts/smoke.ts) executes the TypeBox and Zod examples together.

The `src/typebox.ts` and `src/zod.ts` files are executable with `vpx` and always manage their local
fixture internally.

It shows:

- TypeBox response validation with `resultar-request-typebox`.
- Zod response parsing with a transform using `resultar-request-zod`.
- Domain error mapping for HTTP, invalid JSON, request failures, and validation failures.
- Typed server startup, execution, and cleanup without `try`/`catch` control flow.

The smoke script checks the expected success and failure branches, including the server-backed fetch
flow.

## Task-native requests

`requestJson`, `requestJsonTypeBox`, and `requestJsonZod` return `ResultTask` directly:

```ts
import { Retry } from "resultar";
import { requestJsonTypeBox, t } from "resultar-request-typebox";

const accountSchema = t.Object({
  email: t.String(),
  id: t.String(),
  plan: t.Union([t.Literal("free"), t.Literal("team")]),
  seats: t.Number(),
});

const loadAccount = (baseUrl: string) =>
  requestJsonTypeBox({
    request: (signal) => fetch(`${baseUrl}/accounts/team`, { signal }),
    schema: accountSchema,
  }).retry(Retry.policy({ times: 2, delayMs: 100 }));

const result = await loadAccount("http://127.0.0.1:3000").runResult();
const label = result.match(
  (account) => account.email,
  (error) => error.message,
);
```

Each `.runResult()` starts a fresh, cancelable HTTP request. Task has no `.then`, its `map` is synchronous, and its `match`
returns a Task; execute at the boundary with `.runResult()` and match the resolved `Result` as above. Server ownership uses
`ResultTask.acquireRelease` inside `ResultTask.scoped`.

## Limitations

The fixture serves a single hard-coded `GET /accounts/team` payload on `127.0.0.1`; unknown
routes return plain-text 404. The examples cover JSON request/response validation only — no
streaming, RPC, or platform integrations — and the manual `src/server.ts` runner stops on
`SIGINT`/`SIGTERM` without a drain phase.
