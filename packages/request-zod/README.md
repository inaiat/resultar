# resultar-request-zod

Zod adapter for `resultar-request`.

Use this package when a request response should be parsed with Zod while the transport and Resultar
error flow stay in `resultar-request`.

Prefer `ResultTask` for new async workflows. This adapter returns eager `ResultAsync`
(also re-exported from the `resultar/async` subpath); defer the adapter call with `fromResultAsync(factory)`.

For a schema-library-agnostic request, use
[`resultar-request`](https://www.npmjs.com/package/resultar-request) directly with its `validator`
or `decode` options. The sibling
[`resultar-request-typebox`](https://www.npmjs.com/package/resultar-request-typebox) package
provides the same request flow with TypeBox schemas instead of Zod.

The `resultar/async` subpath is included in the `resultar` installation.

## Install

```sh
pnpm add resultar-request-zod resultar zod
```

```sh
npm install resultar-request-zod resultar zod
```

## `requestJson`

```ts
import { ResultTask } from 'resultar'
import {
  requestJson as requestJsonZod,
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

const userTask: ResultTask<User, RequestError> = ResultTask.fromResultAsync(() =>
  requestJsonZod({
    request: () => fetch('https://example.com/users/123'),
    schema: userSchema,
    retry: {
      times: 2,
      delayMs: ({ nextAttempt }) => nextAttempt * 100,
    },
    validationError: ({ errors }) =>
      `User response failed validation with ${errors.length} issue(s)`,
  }),
)

const userLabelTask = userTask.map(({ email, seatLabel }) => `${email} (${seatLabel})`)
const result = await userLabelTask.runResult()
```

The adapter call itself returns `ResultAsync<User, RequestError>`. Zod validates the unknown JSON response,
applies the transform, and passes the transformed `z.output<typeof userSchema>` value into the
Resultar success channel. The request can also retry request or HTTP `5xx` failures without retrying
invalid JSON or validation failures.

The bridge above produces `ResultTask<User, RequestError>` and calls the adapter afresh on each
run. Passing an existing Async value would reuse its already-started execution. Task is lazy,
non-thenable and uses explicit runners; its `map` is synchronous and its `match` returns another
Task to run. Existing callers can keep awaiting the adapter's eager Async result during migration.

`requestJsonZod` is exported as the named adapter helper, and `requestJson` is an alias for
package-local ergonomics.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema parsing,
while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and Resultar
error mapping.

## Shared Request Options

| Option | Purpose |
| --- | --- |
| `request` | Promise or retryable promise factory returning a Fetch/Undici-compatible response |
| `schema` | Zod schema used for runtime parsing and transformed `z.output` success inference |
| `validationError` | Static or computed validation failure message |
| `mapError` | Status-specific and category-specific domain error mapping |
| `retry` | Attempts, delay, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Use a request factory whenever `retry` is enabled. A previously created promise cannot be restarted.

## Requirements

- Node.js 24+
- ESM only
- `zod` installed as a peer dependency

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
