# resultar-request-typebox

TypeBox adapter for `resultar-request`.

Use this package when a request response should be validated with TypeBox while the transport and
Resultar error flow stay in `resultar-request`.

## Install

```sh
pnpm add resultar-request-typebox typebox
```

```sh
npm install resultar-request-typebox typebox
```

## `requestJson`

```ts
import { requestJson } from 'resultar-request-typebox'
import { Type, type Static } from 'typebox'

const userSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
})

type User = Static<typeof userSchema>

const user = requestJson({
  request: () => fetch('https://example.com/users/123'),
  schema: userSchema,
})
```

The returned type is `ResultAsync<User, RequestError>`. `requestJsonTypeBox` is exported as the
named adapter helper, and `requestJson` is an alias for package-local ergonomics.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.
