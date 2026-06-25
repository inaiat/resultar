# Resultar Check

TypeScript 7 diagnostics for Resultar.

`resultar-check` is the canonical Resultar diagnostics package and command. It runs TypeScript 7
first, then runs Resultar diagnostics over the same `tsconfig.json`. Oxlint integration and TS6
patching are no longer shipped as public lint surfaces.

Until TypeScript 7 exposes the stable programmatic type-checker API Resultar needs, the package keeps
a TypeScript 6 diagnostics API as an internal bridge. Projects should still standardize on the
TypeScript 7 `resultar-check` command.

## Install

For editor diagnostics and CLI checks, install `resultar-check` with a project-local TypeScript RC:

```sh
pnpm add -D resultar-check typescript@rc
```

Add one check script:

```json
{
  "scripts": {
    "check": "resultar-check -p tsconfig.json --noEmit"
  }
}
```

Configure Resultar rules in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-check",
        "noDiscard": "error",
        "preferMapErr": "error",
        "preferAndThen": "error"
      }
    ]
  }
}
```

`resultar-check` resolves a project-local `typescript@7` first, then `typescript-7`. If a project
cannot replace its `typescript` package yet and only needs the CLI path, use the compatibility alias:

```sh
pnpm add -D resultar-check typescript-7@npm:typescript@rc
```

## Editor Integration

`resultar-check` is a TypeScript language-service plugin. Editors must run a TypeScript server that
can resolve the local `resultar-check` package and see the `compilerOptions.plugins` entry above.

### Zed

Zed uses `vtsls` for TypeScript by default. Add this to your Zed settings when working in pnpm
monorepos or when the bundled TypeScript server does not activate the plugin:

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "autoUseWorkspaceTsdk": true
        },
        "typescript": {
          "tsserver": {
            "pluginPaths": ["./node_modules"]
          }
        }
      }
    }
  }
}
```

If diagnostics do not appear, temporarily add `"log": "normal"` under `typescript.tsserver`, restart
the TypeScript server, and check the Zed log. A working setup reports diagnostics whose source is
`resultar` and whose message starts with `[resultar/noDiscard]`.

If you use `typescript-language-server` in Zed instead of `vtsls`, pass the plugin through
`initialization_options.plugins` and set `location` to the project root, not `./node_modules`.
`typescript-language-server` resolves plugin packages from `${location}/node_modules`.

```json
{
  "lsp": {
    "typescript-language-server": {
      "initialization_options": {
        "plugins": [
          {
            "name": "resultar-check",
            "location": "/absolute/path/to/project"
          }
        ]
      }
    }
  }
}
```

### VS Code

Configure VS Code to use the workspace TypeScript version:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true
}
```

Then run `TypeScript: Select TypeScript Version` and choose the workspace version. In pnpm monorepos
where the plugin still does not activate, add this setting:

```json
{
  "typescript.tsserver.pluginPaths": ["./node_modules"]
}
```

## Rules

| Rule                                            | tsconfig option                    | Purpose                                                                            |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `resultar/no-discard`                           | `noDiscard`                        | Require `Result` and `ResultAsync` values to be handled or explicitly discarded.   |
| `resultar/prefer-map-err`                       | `preferMapErr`                     | Prefer `mapErr` when `orElse` only returns another `Err`.                          |
| `resultar/prefer-and-then`                      | `preferAndThen`                    | Prefer `andThen` / `asyncAndThen` when `map` returns a Resultar value.             |
| `resultar/typed-catch-mapper`                   | `typedCatchMapper`                 | Require catch conversion helpers to map caught values to typed errors.             |
| `resultar/no-unsafe-await`                      | `noUnsafeAwait`                    | Require raw Promise awaits in Resultar async contexts to use Resultar boundaries.  |
| `resultar/no-try-catch-in-safe-try`             | `noTryCatchInSafeTry`              | Avoid raw `try/catch` inside `safeTry` generators.                                 |
| `resultar/yield-star-in-safe-try`               | `yieldStarInSafeTry`               | Require `yield*` for Resultar values inside `safeTry`.                             |
| `resultar/unsafe-result-type-assertion`         | `unsafeResultTypeAssertion`        | Prevent assertions that narrow Resultar error channels.                            |
| `resultar/prefer-tagged-error`                  | `preferTaggedError`                | Prefer `createTaggedError` over plain `Error` subclasses or `err(new Error(...))`. |
| `resultar/tagged-error-name-match`              | `taggedErrorNameMatch`             | Require `createTaggedError({ name })` to match the class name.                     |
| `resultar/no-tagged-error-constructor-override` | `noTaggedErrorConstructorOverride` | Keep the generated tagged-error constructor intact.                                |
| `resultar/no-useless-recovery`                  | `noUselessRecovery`                | Flag recovery calls on `Result<T, never>` / `ResultAsync<T, never>`.               |

Each option accepts `"error"`, `"warning"`, `"suggestion"`, `"message"`, or `"off"`.
`noUnsafeAwait` defaults to `"off"` because it is an architectural rule and may require migration in
existing async code. Enable it explicitly when a project is ready to enforce Resultar async
boundaries. By default, `noUnsafeAwait` uses `noUnsafeAwaitMode: "resultar-context"` and checks
functions returning `ResultAsync` or `Promise<Result>`, plus `safeTry` bodies. Raw Promise awaits are
allowed in async catch helpers such as `tryAsync`, `tryResultAsync`, `tryCatchAsync`, and
`fromThrowableAsync`; inside `safeTry`, prefer `yield*` with Resultar values. Use
`noUnsafeAwaitMode: "all"` to also report framework/bootstrap awaits such as Fastify plugin
registration.

The default `noDiscard` mode is neverthrow-style `must-use`: it reports discarded Resultar
expressions and assigned `Result` values that are passed around but never consumed with `match`,
`unwrapOr`, `_unsafeUnwrap`, `isOk`, `isErr`, returned, or explicitly discarded. Use
`--mode direct` for the lower-noise expression-only check.

```sh
pnpm exec resultar-check -p tsconfig.json --noEmit
pnpm exec resultar-check -p tsconfig.json --noEmit --mode direct
```

## Deprecated Packages

`resultar-lint` and `resultar-tsgo` are compatibility wrappers. New projects should install
`resultar-check` directly and use plugin name `"resultar-check"`.
