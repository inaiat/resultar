# resultar-request-typebox

TypeBox adapter for `resultar-request`.

Use this package when a request response should be validated with TypeBox while the transport and
Resultar error flow stay in `resultar-request`.

For a schema-library-agnostic request, use [`resultar-request`](../request/README.md) directly with
its `validator` or `decode` options. The sibling
[`resultar-request-zod`](../request-zod/README.md) package provides the same request flow with Zod
schemas instead of TypeBox.

## Install

```sh
pnpm add resultar-request-typebox typebox
```

```sh
npm install resultar-request-typebox typebox
```

## `requestJson`

```ts
import { createTaggedError } from 'resultar'
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

const user = requestJsonTypeBox({
  request: () => fetch('https://example.com/users/123'),
  schema: userSchema,
  mapError: mapUserError,
})

const userLabel = user.map(({ email, plan }) => `${email} (${plan})`)
```

`Static<typeof userSchema>` is the success type, so the request returns
`ResultAsync<User, UserApiError>` in this example. TypeBox validates the unknown JSON response at
runtime, while Resultar keeps request, HTTP, invalid-JSON, and validation failures in the error
channel. `requestJsonTypeBox` is the named adapter helper, and `requestJson` is an alias for
package-local ergonomics.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema
validation, while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and
Resultar error mapping.

For a runnable server-backed version of this flow, see the
[request example](../../examples/request/README.md).
