# resultar-request-typebox

[Read the documentation online](https://inaiat.github.io/resultar/#/docs/packages/request-typebox)

TypeBox adapter for `resultar-request`.

Use this package when a request response should be validated with TypeBox while the transport and
Resultar error flow stay in `resultar-request`.

`requestJsonTypeBox` (also exported as `requestJson`) builds a lazy, repeatable `ResultTask<T, E>`
that runs your request factory on execution with the active Task `AbortSignal` and `TaskClock`.

For a schema-library-agnostic request, use
[`resultar-request`](https://www.npmjs.com/package/resultar-request) directly with its `validator`
or `decode` options. The sibling
[`resultar-request-zod`](https://www.npmjs.com/package/resultar-request-zod) package provides the
same request flow with Zod schemas instead of TypeBox.

## Install

```sh
pnpm add resultar-request-typebox resultar
```

```sh
npm install resultar-request-typebox resultar
```

Import `t` from `resultar-request-typebox` to build schemas alongside the request
helpers. It is a direct reexport of TypeBox's `Type`, including type utilities such
as `t.Static`. TypeBox is installed automatically as a dependency (`>=1.3.4 <2.0.0`);
no separate installation is needed when using `t`. Direct TypeBox imports remain
compatible; declare TypeBox in your application dependencies if you import it by name.

## `requestJsonTypeBox` and `requestJson`

Return `requestJsonTypeBox` (or its package-local `requestJson` alias) directly from service
functions without an `async` wrapper:

```ts
import { createTaggedError, ResultTask } from "resultar";
import { requestJsonTypeBox, t, type RequestJsonMapError } from "resultar-request-typebox";

const userSchema = t.Object(
  {
    id: t.String(),
    email: t.String(),
    plan: t.Union([t.Literal("free"), t.Literal("team")]),
  },
  { additionalProperties: false },
);

type User = t.Static<typeof userSchema>;

class UserApiError extends createTaggedError({
  name: "UserApiError",
  message: "User API $reason: $detail",
}).withProps<{
  readonly reason: "not-found" | "http" | "invalid-json" | "request" | "validation";
  readonly detail: string;
}>() {}

const mapUserError = {
  404: ({ statusCode }) => new UserApiError({ reason: "not-found", detail: `HTTP ${statusCode}` }),
  http: ({ statusCode }) => new UserApiError({ reason: "http", detail: `HTTP ${statusCode}` }),
  invalidJson: ({ cause }) =>
    new UserApiError({ cause, reason: "invalid-json", detail: cause.message }),
  request: ({ cause }) => new UserApiError({ cause, reason: "request", detail: cause.message }),
  validation: ({ errors }) =>
    new UserApiError({
      reason: "validation",
      detail: `${errors.length} validation issue(s)`,
    }),
} satisfies RequestJsonMapError;

const fetchUser = (id: string): ResultTask<User, UserApiError> =>
  requestJsonTypeBox({
    request: (signal) => fetch(`https://example.com/users/${id}`, { signal }),
    schema: userSchema,
    mapError: mapUserError,
    retry: { times: 2, delayMs: 100, backoff: 2 },
  });

const loadUserLabel = ResultTask.fn(function* (id: string) {
  const { email, plan } = yield* fetchUser(id);
  return `${email} (${plan})`;
});

const result = await loadUserLabel("123").runResult();
```

`t.Static<typeof userSchema>` is the success type, while Resultar keeps request, HTTP, invalid-JSON,
and validation failures in the typed error channel. `requestJsonTypeBox` is exported alongside the
package-local `requestJson` alias.

The package also re-exports the public `resultar-request` API, including `RequestError`, map-error
types, retry types, and structural response types.

The TypeBox and Zod adapters share the same transport behavior: the adapter supplies schema
validation, while `resultar-request` handles Fetch-compatible responses, JSON errors, retries, and
Resultar error mapping.

## Shared Request Options

| Option            | Purpose                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `request`         | `(signal: AbortSignal) => Promise<Response>` factory invoked on each Task execution and retry    |
| `schema`          | TypeBox schema used for runtime validation and `Static` success inference                        |
| `validationError` | Static or computed validation failure message                                                    |
| `mapError`        | Status-specific and category-specific domain error mapping                                       |
| `retry`           | Attempts, delay, backoff, jitter, `when`, and `onRetry` policy inherited from `resultar-request` |

Pass an `AbortSignal` at the execution boundary via `.runResult({ signal })` / `.runExit({ signal })`,
or compose with `ResultTask.timeout` and fiber interruption inside Task workflows.

## Requirements

- Node.js 24+
- ESM only
- `typebox` installed automatically as a runtime dependency (`>=1.3.4 <2.0.0`)

For a runnable server-backed version of this flow, see the
[request example](https://github.com/inaiat/resultar/tree/main/examples/request).
