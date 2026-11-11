# resultar-request-typebox

TypeBox adapter for `resultar-request`.

Use this package when a request response should be validated with TypeBox while the transport and
Resultar error flow stay in `resultar-request`.

Prefer `requestJsonTypeBoxTask` (also exported as `requestJsonTask`) for new lazy `ResultTask`
workflows, and `requestJsonTypeBox` (also exported as `requestJson`) when preserving an eager
`ResultAsync` boundary.

For a schema-library-agnostic request, use
[`resultar-request`](https://www.npmjs.com/package/resultar-request) directly with its `validator`
or `decode` options. The sibling
[`resultar-request-zod`](https://www.npmjs.com/package/resultar-request-zod) package provides the
same request flow with Zod schemas instead of TypeBox.

## Install

```sh
pnpm add resultar-request-typebox resultar typebox
```

```sh
npm install resultar-request-typebox resultar typebox
```

## `requestJsonTypeBoxTask` and `requestJson`

For new lazy `ResultTask` services, return `requestJsonTypeBoxTask` directly without `async` or
`ResultTask.fromResultAsync`:

```ts
import { createTaggedError, ResultTask } from 'resultar'
import {
  requestJsonTypeBoxTask,
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
}).withProps<{
  readonly reason: 'not-found' | 'http' | 'invalid-json' | 'request' | 'validation'
  readonly detail: string
}>() {}

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

const fetchUserTask = (id: string): ResultTask<User, UserApiError> =>
  requestJsonTypeBoxTask({
    request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
    schema: userSchema,
    mapError: mapUserError,
    retry: { times: 2, delayMs: 100, backoff: 2 },
  })

const loadUserLabelTask = ResultTask.fn(function* (id: string) {
  const { email, plan } = yield* fetchUserTask(id)
  return `${email} (${plan})`
})

const result = await loadUserLabelTask('123').runResult()
```

For existing eager `ResultAsync` contracts, use `requestJsonTypeBox` (aliased as `requestJson`):

```ts
import { Result, type StrictResultAsync } from 'resultar'
import { requestJson as requestJsonTypeBox } from 'resultar-request-typebox'

const fetchUser = (id: string, signal?: AbortSignal): StrictResultAsync<User, UserApiError> =>
  requestJsonTypeBox({
    signal,
    request: (attemptSignal) => fetch(`https://example.com/users/${id}`, { signal: attemptSignal }),
    schema: userSchema,
    mapError: mapUserError,
  })

const loadUserLabel = (id: string): StrictResultAsync<string, UserApiError> =>
  Result.gen(async function* () {
    const { email, plan } = yield* fetchUser(id)
    return `${email} (${plan})`
  })
```

`Static<typeof userSchema>` is the success type, while Resultar keeps request, HTTP, invalid-JSON,
and validation failures in the typed error channel. `requestJsonTypeBox` / `requestJsonTypeBoxTask`
are exported as named adapter helpers alongside package-local `requestJson` / `requestJsonTask`
aliases. If an existing helper already returns `ResultAsync`, you can still bridge it lazily with
`ResultTask.fromResultAsync((signal) => fetchUser(id, signal))`.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema
validation, while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and
Resultar error mapping.

## Shared Request Options

| Option | Purpose |
| --- | --- |
| `request` | `(signal: AbortSignal) => Promise<Response>` factory (or eager `Promise` in `requestJson`) |
| `signal` | Optional `AbortSignal` for eager `requestJson` (in `requestJsonTypeBoxTask`, use the Task runner signal) |
| `schema` | TypeBox schema used for runtime validation and `Static` success inference |
| `validationError` | Static or computed validation failure message |
| `mapError` | Status-specific and category-specific domain error mapping |
| `retry` | Attempts, delay, backoff, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Use a request factory whenever `retry` is enabled. A previously created promise cannot be restarted.

## Requirements

- Node.js 24+
- ESM only
- `typebox` installed as a peer dependency

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
