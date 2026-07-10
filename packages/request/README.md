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

## Error Mapping

Use `mapError` when callers need domain-specific errors instead of `RequestError`.

```ts
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
  },
})
```

Default retry policy:

- Retries request failures.
- Retries HTTP `5xx` responses.
- Does not retry HTTP `4xx` responses.
- Does not retry invalid JSON.
- Does not retry validation failures.

Retries require `request` to be a function. A promise request source cannot be retried because it has
already started.
