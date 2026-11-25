# resultar-request

Fetch-first JSON request helpers for Resultar.

Use this package when a service calls another HTTP service and needs consistent JSON parsing,
payload validation, retry, and error mapping without coupling the request layer to a schema library.

`requestJson` builds a lazy, repeatable `ResultTask<T, E>`: construction starts no network I/O,
each run invokes `request(signal)` anew with the active Task `AbortSignal`, and retries reuse
`TaskClock` and Task interruption semantics.

## Install

```sh
pnpm add resultar-request resultar
```

```sh
npm install resultar-request resultar
```

## Feature Map

| Need                                                      | Option or API                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Lazy, repeatable `ResultTask<T, E>` HTTP call             | `requestJson`                                                                 |
| Start a Fetch/Undici-compatible request on each run       | `request` (`(signal: AbortSignal) => Promise<Response>`)                      |
| Cooperative cancellation across attempts and retry delays | Task runner `{ signal }`, `ResultTask.timeout`, fiber interruption, or racing |
| Validate unknown JSON without transforming it             | `validator`                                                                   |
| Validate and transform unknown JSON                       | `decode`                                                                      |
| Customize validation messages                             | `validationError`                                                             |
| Map transport failures into domain errors                 | `mapError`                                                                    |
| Retry selected failures with delay, backoff, and jitter   | `retry`                                                                       |
| Use TypeBox or Zod schemas                                | `resultar-request-typebox`, `resultar-request-zod`                            |

## `requestJson`

`requestJson` builds a lazy, repeatable `ResultTask<T, E>` directly without an `async` wrapper:

```ts
import { ResultTask } from "resultar";
import { requestJson, type RequestError } from "resultar-request";

type User = { id: string; email: string };

const isUser = (value: unknown): value is User =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "email" in value &&
  typeof value.id === "string" &&
  typeof value.email === "string";

const fetchUser = (id: string): ResultTask<User, RequestError> =>
  requestJson({
    request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
    validator: isUser,
    retry: { times: 2, delayMs: 100, backoff: 2 },
  });

const loadUserEmail = ResultTask.fn(function* (id: string) {
  const user = yield* fetchUser(id);
  return user.email;
});

const result = await loadUserEmail("123").runResult();
const label = result.match(
  (email) => email,
  (error) => error.message,
);
```

Task cancellation (runner `{ signal }`, `ResultTask.timeout`, fiber interruption, or racing)
aborts the `signal` passed to `request(signal)`, cancels pending retry sleeps immediately on
`TaskClock`, and surfaces Task interruption (`Cause.Interrupt` in `runExit()`, rejecting
`runResult()` with `AbortError`) without starting further attempts.

The core package accepts Fetch `Response` objects and Undici-shaped response objects structurally.
It does not import `undici`, `typebox`, `zod`, or `node:*` at runtime.

Without `mapError`, the result error channel is `RequestError`. Failure categories are recorded at
the stage where they occur: a `SyntaxError` or stream error thrown during `request()` or body text
reading is classified as `'request'` (not `'invalidJson'`), whereas only malformed JSON during
`response.json()` is classified as `'invalidJson'`. Unserializable HTTP metadata (such as circular
or `bigint` headers) is formatted safely and stays inside `Err<RequestError>`.

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

The TypeBox adapter installs TypeBox automatically and exports its builders as `t`.
The Zod adapter requires Zod as a peer dependency:

```sh
pnpm add resultar-request-typebox
pnpm add resultar-request-zod zod
```

## Decode

Use `decode` when validation should also transform the payload.

```ts
const userTask = requestJson({
  request: (signal) => fetch("https://example.com/users/123", { signal }),
  decode: (value) =>
    isUser(value)
      ? { success: true, value: { ...value, email: value.email.toLowerCase() } }
      : {
          success: false,
          errors: [{ message: "Expected user payload" }],
        },
});
```

Use `validationError` to customize the default validation failure message without replacing the
error type:

```ts
const userTask = requestJson({
  request: (signal) => fetch("https://example.com/users/123", { signal }),
  validator: isUser,
  validationError: ({ errors }) => `User response has ${errors.length} validation issue(s)`,
});
```

## Error Mapping

Use `mapError` when callers need domain-specific errors instead of `RequestError`.

```ts
const id = "123";

const userTask = requestJson({
  request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
  validator: isUser,
  mapError: {
    404: () => new Error("User not found"),
    http: ({ statusCode }) => new Error(`User API failed with status ${statusCode}`),
    invalidJson: ({ cause }) => new Error(`User API returned invalid JSON: ${cause.message}`),
    request: ({ cause }) => new Error(`User API request failed: ${cause.message}`),
    validation: ({ message }) => new Error(message),
  },
});
```

HTTP status-specific handlers win over the generic `http` handler.
The returned error type is inferred as the union of every error produced by the map, including
status-specific handlers.

## Retry and Cancellation

`requestJson` retries failed request factories using Resultar's `ResultTask` retry semantics and
active `TaskClock`.

```ts
const controller = new AbortController();

const userTask = requestJson({
  request: (signal) => fetch("https://example.com/users/123", { signal }),
  validator: isUser,
  retry: {
    times: 2,
    delayMs: 100,
    backoff: 2,
    jittered: 0.2,
    when: (context) =>
      context.reason === "request" || (context.reason === "http" && context.statusCode >= 500),
    onRetry: ({ attempt, reason }) => console.warn("retrying user request", { attempt, reason }),
  },
});

const result = await userTask.runResult({ signal: controller.signal });
```

`when` can narrow the default policy with sync or async logic. `onRetry` receives the failure context
plus attempt metadata and can also be asynchronous. `delayMs` can be a fixed number or a function;
`backoff` multiplies numeric delays exponentially across attempts, and `jittered` applies proportional
randomization to that delay.

Cancellation is checked before the first attempt, after async retry hooks settle, and while waiting
for retry delays. Once cancelled, no further attempts are scheduled—even if a custom `when` predicate
returns `true`. Pass the supplied `signal` to `fetch` or your HTTP client: the adapter cannot
forcibly stop an underlying transport that ignores `AbortSignal`.

Default retry policy:

- Retries request-stage failures (except recognized aborts).
- Retries HTTP `5xx` responses.
- Does not retry HTTP `4xx` responses.
- Does not retry invalid JSON.
- Does not retry validation failures.

## Error helpers and public types

`RequestError` is the default error. `RequestError.exception(cause, statusCode)`
normalizes unknown causes; `RequestError.integrationError(cause)` and
`integrationErrorHandler(cause)` use status 500. `baseRequestErrorHandler(cause)`
maps recognized timeout error names to 408 and other causes to 500.

`HttpResponseErrorCauseError` stores `body`, `headers`, and `statusCode` for an
unsuccessful HTTP response. `HttpClientRequestErrorCause` is a compatibility alias
of the same constructor. `isHttpResponseError(error)` narrows a `RequestError` to
one carrying that structured cause, so callers can inspect response metadata.
These helpers support custom integrations; `requestJson` already applies the
normal request/error pipeline.

Use `HttpErrorStatusByTag<Error>` to check that an HTTP status map has an entry
for every tag in an error union. The type works in any HTTP framework.

```ts
import type { HttpErrorStatusByTag } from "resultar-request";

type UserError = { readonly _tag: "UserNotFound" } | { readonly _tag: "UserConflict" };

const statusByTag = {
  UserNotFound: 404,
  UserConflict: 409,
} satisfies HttpErrorStatusByTag<UserError>;
```

Public type families include `RequestJsonInput` and its validator/decode/mapped
variants, `RequestJsonFactory`, `RequestJsonResponseData`, `FetchJsonResponseData`,
`UndiciJsonResponseData`, `RequestHeaders`, `RequestJsonValidator`,
`RequestJsonDecoder`, decode success/failure/result types, validation issue/reason
and error types, `RequestJsonMapError` / `RequestJsonMapErrorResult`, HTTP/request/
invalid-JSON/validation contexts, and `RequestJsonRetry` / `RequestJsonRetryContext`.
The [public inventory](../../docs/api-inventory.md#resultar-request) lists every
export; installed declarations give exact overloads. Zod and TypeBox adapters
re-export this surface and add their own schema input/output types.

## Requirements

- Node.js 24+
- ESM only
- A Fetch-compatible response or structurally compatible Undici response

For runnable TypeBox and Zod request workflows backed by a local HTTP server, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
