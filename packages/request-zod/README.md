# resultar-request-zod

Zod adapter for `resultar-request`.

Use this package when a request response should be parsed with Zod while the transport and Resultar
error flow stay in `resultar-request`.

For a schema-library-agnostic request, use [`resultar-request`](../request/README.md) directly with
its `validator` or `decode` options. The sibling
[`resultar-request-typebox`](../request-typebox/README.md) package provides the same request flow
with TypeBox schemas instead of Zod.

## Install

```sh
pnpm add resultar-request-zod zod
```

```sh
npm install resultar-request-zod zod
```

## `requestJson`

```ts
import type { ResultAsync } from 'resultar'
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

const user: ResultAsync<User, RequestError> = requestJsonZod({
  request: () => fetch('https://example.com/users/123'),
  schema: userSchema,
  retry: {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
  },
  validationError: ({ errors }) =>
    `User response failed validation with ${errors.length} issue(s)`,
})

const userLabel = user.map(({ email, seatLabel }) => `${email} (${seatLabel})`)
```

The returned type is `ResultAsync<User, RequestError>`. Zod validates the unknown JSON response,
applies the transform, and passes the transformed `z.output<typeof userSchema>` value into the
Resultar success channel. The request can also retry request or HTTP `5xx` failures without retrying
invalid JSON or validation failures.

`requestJsonZod` is exported as the named adapter helper, and `requestJson` is an alias for
package-local ergonomics.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema parsing,
while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and Resultar
error mapping.

For a runnable server-backed version of this flow, see the
[request example](../../examples/request/README.md).
