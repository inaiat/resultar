# Request Example

Runnable examples for `resultar-request`, `resultar-request-typebox`, and
`resultar-request-zod`.

Run it from the repository root:

```sh
pnpm run example:request
```

Or run the package directly:

```sh
pnpm --filter resultar-request-example check
pnpm --filter resultar-request-example smoke
pnpm --filter resultar-request-example start
pnpm --filter resultar-request-example typebox
pnpm --filter resultar-request-example zod
```

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
