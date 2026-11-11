# resultar-request-zod

Zod adapter for `resultar-request`.

Use this package when a request response should be parsed with Zod while the transport and Resultar
error flow stay in `resultar-request`.

Prefer `requestJsonZodTask` (also exported as `requestJsonTask`) for new lazy `ResultTask`
workflows, and `requestJsonZod` (also exported as `requestJson`) when preserving an eager
`ResultAsync` boundary.

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

## `requestJsonZodTask` and `requestJson`

For new lazy `ResultTask` services, return `requestJsonZodTask` directly without `async` or
`ResultTask.fromResultAsync`:

```ts
import { ResultTask } from 'resultar'
import {
  requestJsonZodTask,
  type RequestError,
} from 'resultar-request-zod'
import { z } from 'zod'

const userSchema = z
  .object({
    id: z.string(),
    email: z.string().email(),
    plan: z.enum(['free', 'team']),
    seats: z.number().int().nonnegative(),
  })
  .transform((user) => ({
    ...user,
    email: user.email.toLowerCase(),
    seatLabel: `${user.seats} seats`,
  }))

type User = z.output<typeof userSchema>

const fetchUserTask = (id: string): ResultTask<User, RequestError> =>
  requestJsonZodTask({
    request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
    schema: userSchema,
    retry: { times: 2, delayMs: 100, backoff: 2 },
    validationError: ({ errors }) =>
      `User response failed validation with ${errors.length} issue(s)`,
  })

const loadUserLabelTask = ResultTask.fn(function* (id: string) {
  const { email, seatLabel } = yield* fetchUserTask(id)
  return `${email} (${seatLabel})`
})

const result = await loadUserLabelTask('123').runResult()
```

For existing eager `ResultAsync` contracts, use `requestJsonZod` (aliased as `requestJson`):

```ts
import { Result, type StrictResultAsync } from 'resultar'
import { requestJson as requestJsonZod, type RequestError } from 'resultar-request-zod'

const fetchUser = (id: string, signal?: AbortSignal): StrictResultAsync<User, RequestError> =>
  requestJsonZod({
    signal,
    request: (attemptSignal) => fetch(`https://example.com/users/${id}`, { signal: attemptSignal }),
    schema: userSchema,
  })

const loadUserLabel = (id: string): StrictResultAsync<string, RequestError> =>
  Result.gen(async function* () {
    const { email, seatLabel } = yield* fetchUser(id)
    return `${email} (${seatLabel})`
  })
```

Zod validates the unknown JSON response, applies the transform, and passes the transformed
`z.output<typeof userSchema>` value into the Resultar success channel. Both entrypoints retry
request-stage or HTTP `5xx` failures (stopping immediately on cancellation) without retrying
invalid JSON or validation failures.

`requestJsonZod` / `requestJsonZodTask` are exported as named adapter helpers alongside package-local
`requestJson` / `requestJsonTask` aliases. If an existing helper already returns `ResultAsync`, you
can still bridge it lazily with `ResultTask.fromResultAsync((signal) => fetchUser(id, signal))`.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema parsing,
while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and Resultar
error mapping.

## Shared Request Options

| Option | Purpose |
| --- | --- |
| `request` | `(signal: AbortSignal) => Promise<Response>` factory (or eager `Promise` in `requestJson`) |
| `signal` | Optional `AbortSignal` for eager `requestJson` (in `requestJsonZodTask`, use the Task runner signal) |
| `schema` | Zod schema used for runtime parsing and transformed `z.output` success inference |
| `validationError` | Static or computed validation failure message |
| `mapError` | Status-specific and category-specific domain error mapping |
| `retry` | Attempts, delay, backoff, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Use a request factory whenever `retry` is enabled. A previously created promise cannot be restarted.

## Requirements

- Node.js 24+
- ESM only
- `zod` installed as a peer dependency

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
