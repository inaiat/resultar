# Request Example

Runnable examples for `resultar-request`, `resultar-request-typebox`, and
`resultar-request-zod`.

For new async code, prefer lazy `ResultTask` workflows with explicit runners. The request adapters
and this server fixture retain eager `ResultAsync` compatibility contracts.
Calling an adapter starts one shared execution; wrap the call in a Task factory to defer it.

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
`ResultAsync.withResource`. The `start` script runs `src/server.ts` separately for manual
requests. The server script is only an HTTP fixture; TypeBox and Zod request usage stays in `src/`
and `scripts/smoke.ts`.

The files are split by validator:

- [`src/typebox.ts`](src/typebox.ts) shows one direct TypeBox request example.
- [`src/zod.ts`](src/zod.ts) shows one direct Zod transform example.
- [`src/account-server.ts`](src/account-server.ts) defines the local HTTP fixture with typed Resultar
  boundaries.
- [`src/server.ts`](src/server.ts) runs that fixture and manages its lifecycle with
  `ResultAsync.withResource`.
- [`scripts/smoke.ts`](scripts/smoke.ts) executes the TypeBox and Zod examples together.

The `src/typebox.ts` and `src/zod.ts` files are executable with `tsx` and always manage their local
fixture internally.

It shows:

- TypeBox response validation with `resultar-request-typebox`.
- Zod response parsing with a transform using `resultar-request-zod`.
- Domain error mapping for HTTP, invalid JSON, request failures, and validation failures.
- Typed server startup, execution, and cleanup without `try`/`catch` control flow.

The smoke script checks the expected success and failure branches, including the server-backed fetch
flow.

## New Task workflows

For a server that is already running, compose a fresh request per Task execution:

```ts
import { ResultTask } from 'resultar'
import { requestJson } from 'resultar-request-typebox'
import { Type } from 'typebox'

const accountSchema = Type.Object({
  email: Type.String(),
  id: Type.String(),
  plan: Type.Union([Type.Literal('free'), Type.Literal('team')]),
  seats: Type.Number(),
})

const loadAccount = (baseUrl: string) => ResultTask.fromResultAsync(() =>
  requestJson({
    request: () => fetch(`${baseUrl}/accounts/team`),
    schema: accountSchema,
  }),
)

const result = await loadAccount('http://127.0.0.1:3000').runResult()
const label = result.match(account => account.email, error => error.message)
```

The factory starts a new adapter call on every run. `fromResultAsync(existingAsync)` reuses an
already-started operation instead. Task has no `.then`, its `map` is synchronous, and its `match`
returns a Task; use a runner or match the `Result` after `runResult` as above. The adapter's JSON
validation and error mapping stay unchanged. For new server ownership code, use
`ResultTask.acquireRelease` inside `ResultTask.scoped`; the source fixture keeps its original
eager `withResource` bracket for compatibility coverage.

## Limitations

The fixture serves a single hard-coded `GET /accounts/team` payload on `127.0.0.1`; unknown
routes return plain-text 404. The examples cover JSON request/response validation only — no
streaming, RPC, or platform integrations — and the manual `src/server.ts` runner stops on
`SIGINT`/`SIGTERM` without a drain phase.
