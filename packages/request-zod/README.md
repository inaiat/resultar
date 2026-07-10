# resultar-request-zod

Zod adapter for `resultar-request`.

Use this package when a request response should be parsed with Zod while the transport and Resultar
error flow stay in `resultar-request`.

## Install

```sh
pnpm add resultar-request-zod zod
```

```sh
npm install resultar-request-zod zod
```

## `requestJson`

```ts
import { requestJson } from 'resultar-request-zod'
import { z } from 'zod'

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
})

const user = requestJson({
  request: () => fetch('https://example.com/users/123'),
  schema: userSchema,
})
```

The returned type is `ResultAsync<z.output<typeof userSchema>, RequestError>`. Zod transforms are
preserved because the adapter returns parsed output, not the original unknown JSON value.

`requestJsonZod` is exported as the named adapter helper, and `requestJson` is an alias for
package-local ergonomics.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.
