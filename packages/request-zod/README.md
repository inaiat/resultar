# resultar-request-zod

Zod adapter for `resultar-request`.

Use this package when a request response should be parsed with Zod while the transport and Resultar
error flow stay in `resultar-request`.

`requestJsonZod` (also exported as `requestJson`) builds a lazy, repeatable `ResultTask<T, E>` that
runs your request factory on execution with the active Task `AbortSignal` and `TaskClock`.

For a schema-library-agnostic request, use
[`resultar-request`](https://www.npmjs.com/package/resultar-request) directly with its `validator`
or `decode` options. The sibling
[`resultar-request-typebox`](https://www.npmjs.com/package/resultar-request-typebox) package
provides the same request flow with TypeBox schemas instead of Zod.

## Install

```sh
pnpm add resultar-request-zod resultar zod
```

```sh
npm install resultar-request-zod resultar zod
```

## `requestJsonZod` and `requestJson`

Return `requestJsonZod` (or its package-local `requestJson` alias) directly from service functions
without an `async` wrapper:

```ts
import { ResultTask } from "resultar";
import { requestJsonZod, type RequestError } from "resultar-request-zod";
import { z } from "zod";

const userSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    plan: z.enum(["free", "team"]),
    seats: z.number().int().nonnegative(),
  })
  .transform((user) => ({
    ...user,
    email: user.email.toLowerCase(),
    seatLabel: `${user.seats} seats`,
  }));

type User = z.output<typeof userSchema>;

const fetchUser = (id: string): ResultTask<User, RequestError> =>
  requestJsonZod({
    request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
    schema: userSchema,
    retry: { times: 2, delayMs: 100, backoff: 2 },
    validationError: ({ errors }) =>
      `User response failed validation with ${errors.length} issue(s)`,
  });

const loadUserLabel = ResultTask.fn(function* (id: string) {
  const { email, seatLabel } = yield* fetchUser(id);
  return `${email} (${seatLabel})`;
});

const result = await loadUserLabel("123").runResult();
```

Zod validates the unknown JSON response, applies the transform, and passes the transformed
`z.output<typeof userSchema>` value into the Resultar success channel. Retries handle
request-stage or HTTP `5xx` failures (stopping immediately on Task cancellation) without retrying
invalid JSON or validation failures.

`requestJsonZod` is exported alongside the package-local `requestJson` alias. The package also
re-exports the public `resultar-request` API, including `RequestError`, map-error types, retry
types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema parsing,
while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and Resultar
error mapping.

## Shared Request Options

| Option            | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `request`         | `(signal: AbortSignal) => Promise<Response>` factory invoked on each Task execution and retry    |
| `schema`          | Zod schema used for runtime parsing and transformed `z.output` success inference                 |
| `validationError` | Static or computed validation failure message                                                    |
| `mapError`        | Status-specific and category-specific domain error mapping                                       |
| `retry`           | Attempts, delay, backoff, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Pass an `AbortSignal` at the execution boundary via `.runResult({ signal })` / `.runExit({ signal })`,
or compose with `ResultTask.timeout` and fiber interruption inside Task workflows.

## Requirements

- Node.js 24+
- ESM only
- `zod` installed as a peer dependency

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
