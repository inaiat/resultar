# resultar-request-typebox

TypeBox adapter for `resultar-request`.

Use this package when a request response should be validated with TypeBox while the transport and
Resultar error flow stay in `resultar-request`.

Prefer `ResultTask` for new async workflows. This adapter still returns the eager `ResultAsync`
compatibility API from the `resultar/async` subpath, deprecated since v4; defer the adapter call with `fromResultAsync(factory)`.

For a schema-library-agnostic request, use
[`resultar-request`](https://www.npmjs.com/package/resultar-request) directly with its `validator`
or `decode` options. The sibling
[`resultar-request-zod`](https://www.npmjs.com/package/resultar-request-zod) package provides the
same request flow with Zod schemas instead of TypeBox.

The `resultar/async` subpath is included in the `resultar` installation.

## Install

```sh
pnpm add resultar-request-typebox resultar typebox
```

```sh
npm install resultar-request-typebox resultar typebox
```

## `requestJson`

```ts
import { createTaggedError, ResultTask } from 'resultar'
import {
  requestJson as requestJsonTypeBox,
  type RequestJsonMapError,
} from 'resultar-request-typebox'
import { Type, type Static } from 'typebox'

const userSchema = Type.Object(
  {
    id: Type.String(),
    email: Type.String(),
    plan: Type.Union([Type.Literal('free'), Type.Literal('team')]),
  },
  { additionalProperties: false },
)

type User = Static<typeof userSchema>

class UserApiError extends createTaggedError({
  name: 'UserApiError',
  message: 'User API $reason: $detail',
}) {}

const mapUserError = {
  404: ({ statusCode }) =>
    new UserApiError({ reason: 'not-found', detail: `HTTP ${statusCode}` }),
  http: ({ statusCode }) =>
    new UserApiError({ reason: 'http', detail: `HTTP ${statusCode}` }),
  invalidJson: ({ cause }) =>
    new UserApiError({ cause, reason: 'invalid-json', detail: cause.message }),
  request: ({ cause }) =>
    new UserApiError({ cause, reason: 'request', detail: cause.message }),
  validation: ({ errors }) =>
    new UserApiError({
      reason: 'validation',
      detail: `${errors.length} validation issue(s)`,
    }),
} satisfies RequestJsonMapError

const userTask = ResultTask.fromResultAsync(() =>
  requestJsonTypeBox({
    request: () => fetch('https://example.com/users/123'),
    schema: userSchema,
    mapError: mapUserError,
  }),
)

const userLabelTask = userTask.map(({ email, plan }) => `${email} (${plan})`)
const result = await ResultTask.runResult(userLabelTask)
```

`Static<typeof userSchema>` is the success type, so the adapter call itself returns
`ResultAsync<User, UserApiError>`. TypeBox validates the unknown JSON response at
runtime, while Resultar keeps request, HTTP, invalid-JSON, and validation failures in the error
channel. `requestJsonTypeBox` is the named adapter helper, and `requestJson` is an alias for
package-local ergonomics.

The bridge above produces `ResultTask<User, UserApiError>` and calls the adapter afresh on each
run. Passing an existing Async value would reuse its already-started execution. Task is lazy,
non-thenable and uses explicit runners; its `map` is synchronous and its `match` returns another
Task to run. Existing callers can keep awaiting the adapter's eager Async result during migration.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema
validation, while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and
Resultar error mapping.

## Shared Request Options

| Option | Purpose |
| --- | --- |
| `request` | Promise or retryable promise factory returning a Fetch/Undici-compatible response |
| `schema` | TypeBox schema used for runtime validation and `Static` success inference |
| `validationError` | Static or computed validation failure message |
| `mapError` | Status-specific and category-specific domain error mapping |
| `retry` | Attempts, delay, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Use a request factory whenever `retry` is enabled. A previously created promise cannot be restarted.

## Requirements

- Node.js 24+
- ESM only
- `typebox` installed as a peer dependency

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
