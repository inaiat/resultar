# Resultar Check Example

This package exercises the native TypeScript-Go implementation of `resultar-check`.

It deliberately keeps three independent projects:

- [`src/index.ts`](src/index.ts) is a catalog of invalid Resultar patterns and must fail with every
  supported diagnostic rule;
- [`src/resultar-clean.ts`](src/resultar-clean.ts) contains the corresponding recommended patterns
  and must pass without compiler or Resultar diagnostics;
- [`src/contracts.ts`](src/contracts.ts) enables `preferResultAsyncMode: "all"` and rejects raw
  Promise repository contracts and inferred implementations while accepting `StrictResultAsync`
  and explicit native boundary suppressions.

## Run

From the repository root:

```sh
pnpm example:check
```

The smoke first compiles all three projects with the workspace's installed TypeScript compiler
(`tsc --noEmit`, inherited from their project options), then verifies Resultar diagnostics through
the native CLI. This also runs in CI through the workspace `test:examples` command.

To check TypeScript compatibility independently after building the workspace dependencies:

```sh
pnpm --filter resultar-check-example check:types
```

The native package tests also analyze TypeScript snippets with the compiler. Their isolated fixtures
exercise rule behavior, while this example imports the real Resultar package types. The catalog's
deliberately unsupported async generators use `@ts-expect-error`; Resultar-specific violations such
as requirement-erasing assertions are checked by the native analyzer.

To inspect the human-readable diagnostics:

```sh
pnpm --filter resultar-check-example check
```

To inspect JSON Lines output or only verify the clean fixture:

```sh
pnpm --filter resultar-check-example check:json
pnpm --filter resultar-check-example check:clean
```

The same fixture can demonstrate CI formats directly:

```sh
pnpm --filter resultar-check-example exec resultar-check --project tsconfig.json --format sarif
pnpm --filter resultar-check-example exec resultar-check --project tsconfig.json --format junit
```

The diagnostics catalog covers:

- must-use handling for `Result`, `ResultAsync`, and lazy `ResultTask` values;
- safe sync, async, and generator boundaries;
- `map`, `andThen`, recovery, fallback, and collection simplifications;
- concrete error and requirement channels, safe type assertions, and typed catch mappers;
- tagged-error construction and naming conventions;
- Promise safety, `ResultAsync` service contracts, raw `await`, and exact ignored-call paths;
- `yield*` composition in `safeTry`, `ResultTask.gen`, and parameterized `ResultTask.fn`;
- DI lifetimes, `acquireRelease` / `acquireDisposable` scope ownership, plain generator returns,
  and typed `sync` failures;
- `no-unknown-task-requirements` for aliased `any` / `unknown` requirements;
- assertions that remove services or deferred scope errors, including `as unknown as` bridges;
- `unused-suppression` for obsolete rules, partially used directives, wildcards, and unknown IDs.

The clean fixture preserves concrete service requirements through `ResultTask.fn`, satisfies them
with `provideService`, closes pending scopes with `scoped`, acquires native disposables in an owned
scope, and retains a justified suppression only at an explicit terminal throwing boundary.

The smoke test builds the Resultar package, the `resultar-check` launcher, and the native binary for
the current platform. It then verifies that:

- all 30 native rules report their exact expected finding counts;
- all three fixture projects compile with the installed TypeScript version;
- every configured severity is `error`;
- TypeScript-Go reports no compiler diagnostics;
- the clean fixture exits successfully.
- the all-mode contract fixture reports exactly two errors.

Rule configuration lives in [`tsconfig.json`](tsconfig.json). The
[`tsconfig.clean.json`](tsconfig.clean.json) project inherits the same configuration and changes only
the included source file.
[`tsconfig.contracts.json`](tsconfig.contracts.json) enables the stricter async contract policy.

## Limitations

This is a diagnostics fixture, not application code: `src/index.ts` is intentionally invalid and
must keep failing, while only `src/resultar-clean.ts` shows the recommended patterns. The catalog
covers the 30 implemented native rules; it does not promise future rules, auto-fixes, or IDE
integrations.
