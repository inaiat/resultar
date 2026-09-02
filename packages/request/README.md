# resultar-request

Fetch-first JSON request helpers for Resultar.

Use this package when a service calls another HTTP service and needs consistent JSON parsing,
payload validation, retry, and error mapping without coupling the request layer to a schema library.

## Install

```sh
pnpm add resultar-request resultar
```

```sh
npm install resultar-request resultar
```

## Feature Map

| Need | Option or API |
| --- | --- |
| Start a Fetch/Undici-compatible request | `request` |
| Validate unknown JSON without transforming it | `validator` |
| Validate and transform unknown JSON | `decode` |
| Customize validation messages | `validationError` |
| Map transport failures into domain errors | `mapError` |
| Retry selected failures with delay and jitter | `retry` |
| Use TypeBox or Zod schemas | `resultar-request-typebox`, `resultar-request-zod` |

## `requestJson`

`requestJson` executes a request, parses the response body as JSON, validates or decodes the payload,
and returns a `ResultAsync`.

```ts
import { requestJson } from 'resultar-request'

type User = { id: string; email: string }

const isUser = (value: unknown): value is User =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  'email' in value &&
  typeof value.id === 'string' &&
  typeof value.email === 'string'

const user = requestJson({
  request: () => fetch('https://example.com/users/123'),
  validator: isUser,
})
```

The core package accepts Fetch `Response` objects and Undici-shaped response objects structurally.
It does not import `undici`, `typebox`, `zod`, or `node:*` at runtime.

Without `mapError`, the result error channel is `RequestError`. It distinguishes request creation,
HTTP status, invalid JSON, and validation failures while preserving the original cause and response
context where available.

## Schema Adapters

`resultar-request` is the schema-library-agnostic core. Use its `validator` or `decode` options when
you already have a custom type guard or decoder. When the response contract is described by a
schema library, use one of the optional adapters instead:

- [`resultar-request-typebox`](https://www.npmjs.com/package/resultar-request-typebox) validates
  responses with TypeBox and derives the success type with `Static<typeof schema>`.
- [`resultar-request-zod`](https://www.npmjs.com/package/resultar-request-zod) parses responses with
  Zod and preserves the schema's transformed `z.output<typeof schema>` type.

Both adapters use this package for transport, JSON parsing, retries, and error mapping. They also
re-export the public request API, so you can keep using `RequestError`, retry types, and map-error
types from the adapter package.

Install the adapter and its peer schema library together:

```sh
pnpm add resultar-request-typebox typebox
pnpm add resultar-request-zod zod
```

## Decode

Use `decode` when validation should also transform the payload.

```ts
const user = requestJson({
  request: () => fetch('https://example.com/users/123'),
  decode: (value) =>
    isUser(value)
      ? { success: true, value: { ...value, email: value.email.toLowerCase() } }
      : {
          success: false,
          errors: [{ message: 'Expected user payload' }],
        },
})
```

Use `validationError` to customize the default validation failure message without replacing the
error type:

```ts
const user = requestJson({
  request: () => fetch('https://example.com/users/123'),
  validator: isUser,
  validationError: ({ errors }) => `User response has ${errors.length} validation issue(s)`,
})
```

## Error Mapping

Use `mapError` when callers need domain-specific errors instead of `RequestError`.

```ts
const id = '123'

const result = requestJson({
  request: () => fetch(`https://example.com/users/${id}`),
  validator: isUser,
  mapError: {
    404: () => new Error('User not found'),
    http: ({ statusCode }) => new Error(`User API failed with status ${statusCode}`),
    invalidJson: ({ cause }) => new Error(`User API returned invalid JSON: ${cause.message}`),
    request: ({ cause }) => new Error(`User API request failed: ${cause.message}`),
    validation: ({ message }) => new Error(message),
  },
})
```

HTTP status-specific handlers win over the generic `http` handler.
The returned error type is inferred as the union of every error produced by the map, including
status-specific handlers.

## Retry

`requestJson` can retry failed request factories using Resultar retry semantics.

```ts
const result = requestJson({
  request: () => fetch('https://example.com/users/123'),
  validator: isUser,
  retry: {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
    when: (context) =>
      context.reason === 'request' ||
      (context.reason === 'http' && context.statusCode >= 500),
    onRetry: ({ attempt, reason }) => console.warn('retrying user request', { attempt, reason }),
  },
})
```

`when` can narrow the default policy with sync or async logic. `onRetry` receives the failure context
plus attempt metadata and can also be asynchronous. `delayMs` can be a fixed number or a function;
`jittered` applies proportional randomization to that delay.

Default retry policy:

- Retries request failures.
- Retries HTTP `5xx` responses.
- Does not retry HTTP `4xx` responses.
- Does not retry invalid JSON.
- Does not retry validation failures.

Retries require `request` to be a function. A promise request source cannot be retried because it has
already started.

## Requirements

- Node.js 24+
- ESM only
- A Fetch-compatible response or structurally compatible Undici response

For runnable TypeBox and Zod request workflows backed by a local HTTP server, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
