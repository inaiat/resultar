# Resultar Requests And Validation Tooling

Use this reference for HTTP JSON integrations and Resultar-specific diagnostics. Verify package
versions and local README files before copying an example.

## Contents

- [Choose A Request Package](#choose-a-request-package)
- [Use The Schema-Agnostic Core](#use-the-schema-agnostic-core)
- [Use The TypeBox Adapter](#use-the-typebox-adapter)
- [Use The Zod Adapter](#use-the-zod-adapter)
- [Map Request Errors](#map-request-errors)
- [Apply Retry Correctly](#apply-retry-correctly)
- [Validate In The Preferred Order](#validate-in-the-preferred-order)
- [Configure The CLI And Language Server](#configure-the-cli-and-language-server)
- [Use Lint Adapters As Secondary Feedback](#use-lint-adapters-as-secondary-feedback)
- [Discover Repository Commands](#discover-repository-commands)

## Choose A Request Package

| Contract style                   | Package                    | Success type                 |
| -------------------------------- | -------------------------- | ---------------------------- |
| Custom type guard or decoder     | `resultar-request`         | Type guard or decoder output |
| TypeBox schema                   | `resultar-request-typebox` | `Static<typeof schema>`      |
| Zod schema, including transforms | `resultar-request-zod`     | `z.output<typeof schema>`    |

All three share the same transport implementation. The adapters add schema validation and re-export
the public `resultar-request` types. Install only the core and schema adapter the service needs.

Keep request payloads concrete. Do not widen a known response contract to `JsonRecord`,
`Record<string, unknown>`, or `unknown` after validation.

## Use The Schema-Agnostic Core

Use a type guard when validation does not transform the payload:

```ts
import { requestJson } from "resultar-request";

type User = { readonly email: string; readonly id: string };

const isUser = (value: unknown): value is User =>
  typeof value === "object" &&
  value !== null &&
  "email" in value &&
  typeof value.email === "string" &&
  "id" in value &&
  typeof value.id === "string";

const user = requestJson({
  request: () => fetch(`https://example.com/users/${userId}`),
  validator: isUser,
});
```

Use `decode` when validation also normalizes or transforms the response. The decoder must make
success and validation failure explicit; check the installed package types for the exact shape.

## Use The TypeBox Adapter

```ts
import { createTaggedError } from "resultar";
import {
  requestJson as requestJsonTypeBox,
  type RequestJsonMapError,
} from "resultar-request-typebox";
import { Type, type Static } from "typebox";

const userSchema = Type.Object(
  {
    email: Type.String(),
    id: Type.String(),
    plan: Type.Union([Type.Literal("free"), Type.Literal("team")]),
  },
  { additionalProperties: false },
);

type User = Static<typeof userSchema>;

class UserApiError extends createTaggedError({
  name: "UserApiError",
  message: "User API $reason: $detail",
}) {}

const mapUserError = {
  404: ({ statusCode }) => new UserApiError({ detail: `HTTP ${statusCode}`, reason: "not-found" }),
  http: ({ statusCode }) => new UserApiError({ detail: `HTTP ${statusCode}`, reason: "http" }),
  invalidJson: ({ cause }) =>
    new UserApiError({ cause, detail: cause.message, reason: "invalid-json" }),
  request: ({ cause }) => new UserApiError({ cause, detail: cause.message, reason: "request" }),
  validation: ({ errors }) =>
    new UserApiError({
      detail: `${errors.length} validation issue(s)`,
      reason: "validation",
    }),
} satisfies RequestJsonMapError;

const user = requestJsonTypeBox({
  request: () => fetch(`https://example.com/users/${userId}`),
  schema: userSchema,
  mapError: mapUserError,
  retry: {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
  },
});
```

The success channel is `User`, derived from `Static<typeof userSchema>`. Keep the named adapter
alias when a file uses more than one request helper or when the schema library should be obvious at
the call site.

## Use The Zod Adapter

```ts
import { createTaggedError } from "resultar";
import { requestJson as requestJsonZod, type RequestJsonMapError } from "resultar-request-zod";
import { z } from "zod";

const userSchema = z
  .object({
    email: z.string().email(),
    id: z.string(),
    seats: z.number().int().nonnegative(),
  })
  .transform((user) => ({
    ...user,
    email: user.email.toLowerCase(),
    seatLabel: `${user.seats} seats`,
  }));

type User = z.output<typeof userSchema>;

class UserApiError extends createTaggedError({
  name: "UserApiError",
  message: "User API $reason: $detail",
}) {}

const mapUserError = {
  404: ({ statusCode }) => new UserApiError({ detail: `HTTP ${statusCode}`, reason: "not-found" }),
  http: ({ statusCode }) => new UserApiError({ detail: `HTTP ${statusCode}`, reason: "http" }),
  invalidJson: ({ cause }) =>
    new UserApiError({ cause, detail: cause.message, reason: "invalid-json" }),
  request: ({ cause }) => new UserApiError({ cause, detail: cause.message, reason: "request" }),
  validation: ({ errors }) =>
    new UserApiError({
      detail: `${errors.length} validation issue(s)`,
      reason: "validation",
    }),
} satisfies RequestJsonMapError;

const user = requestJsonZod({
  request: () => fetch(`https://example.com/users/${userId}`),
  schema: userSchema,
  mapError: mapUserError,
  retry: {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
  },
});
```

Use `z.output`, not `z.input` or an independently maintained interface, because Zod transforms can
change the success type.

## Map Request Errors

Without `mapError`, request helpers return the package's `RequestError` union. Use that union for
infrastructure-local code. At an application boundary, use `mapError` to convert these categories
to concrete tagged errors:

- request creation, network, or fetch failure;
- status-specific HTTP failure, with numeric handlers taking precedence over `http`;
- invalid JSON;
- response validation or decode failure.

Preserve `cause` for request and JSON failures and preserve status, URL, validation details, and
other safe context needed for diagnosis. Do not map every category to a message-only `Error`.

## Apply Retry Correctly

```ts
const user = requestJsonZod({
  request: () => fetch(`https://example.com/users/${userId}`),
  schema: userSchema,
  retry: {
    times: 2,
    delayMs: ({ nextAttempt }) => nextAttempt * 100,
    jittered: 0.2,
  },
});
```

The default policy retries request failures and HTTP `5xx`, but not `4xx`, invalid JSON, or
validation failures. Retry requires a request factory; an already-created promise cannot be
restarted. Ensure each attempt receives a fresh request. The current request retry configuration
does not expose ResultAsync's internal retry signal, so do not claim that `requestJson`
automatically forwards policy cancellation. Supply an external fetch signal through the request
closure when the caller owns separate cancellation.

## Validate In The Preferred Order

1. Run the `resultar-check` CLI as the authoritative local and CI gate. It runs TypeScript first and
   then all Resultar rules over the project.
2. Configure the `resultar-check` TypeScript language-service plugin for equivalent diagnostics
   while editing, using the workspace TypeScript version.
3. Add Oxlint, ESLint, or Deno Lint only for optional low-latency AST-only feedback.
4. Run the repository's formatter, build, tests, static analysis, package smoke tests, and runnable
   examples.

Do not claim that an AST-only lint pass replaced the CLI. The adapters intentionally expose fewer
rules because they do not have TypeScript type information.

## Configure The CLI And Language Server

Install a project-local TypeScript 7+ and Resultar Check:

```sh
pnpm add -D resultar-check "typescript@>=7"
pnpm exec resultar-check
```

Add the plugin to `tsconfig.json` and tune rules only when project policy requires it:

```json
{
  "$schema": "./node_modules/resultar-check/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noDiscard": "error",
        "noUnsafeAwait": "error",
        "preferAndThen": "error",
        "preferMapErr": "error",
        "unsafeResultTypeAssertion": "error"
      }
    ]
  }
}
```

Use the workspace TypeScript SDK in the editor, make sure the plugin can resolve from the workspace
`node_modules`, then restart the TypeScript server. A working setup reports source `resultar` and
messages such as `[resultar/noDiscard]`. The corresponding lint rule ID is
`resultar/no-discard`.

Read `packages/check/README.md` for current VS Code, Zed/vtsls, and other editor setup. Use narrow
`ignoreFilePatterns` only for deliberate tests, scripts, generated files, or terminal process
boundaries.

## Use Lint Adapters As Secondary Feedback

Oxlint, ESLint, and Deno Lint adapters expose the shared syntax-only rules. Add the adapter that
matches the project's existing lint host after the CLI and language server are working. Keep rule
IDs aligned across surfaces, but expect type-aware rules such as unsafe error-channel narrowing to
remain CLI/language-server responsibilities.

When an agent encounters a diagnostic, fix the architecture first:

- handle or explicitly discard a returned Resultar value;
- replace nested `Result` from `map` with `andThen`;
- replace error-only recovery with `mapErr`;
- replace project-wide `try/catch` with `tryResult` or `tryResultAsync` when `noTryCatch` is enabled;
- wrap raw promise awaits in Resultar contexts;
- use `yield*` and avoid `try/catch` inside `safeTry`;
- preserve the inferred error channel instead of asserting it away.

## Discover Repository Commands

Inspect `package.json` scripts instead of assuming a package manager or command. In the Resultar
repository, the relevant root commands currently include:

```sh
pnpm fmt:check
pnpm build
pnpm check
pnpm test
pnpm analyze
pnpm smoke:package
pnpm test:examples
```

Run the narrowest useful command while iterating, then the complete relevant validation set before
claiming completion. Report pre-existing dependency, lockfile, or environment blockers separately
from failures introduced by the skill work.
