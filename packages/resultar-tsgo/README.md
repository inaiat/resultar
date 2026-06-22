# Resultar TSGo

Local wrapper around `typescript@rc` installed as `typescript-7` that exposes a `tsgo` binary and
runs Resultar lint validation after the native TypeScript 7 check succeeds.

Install it next to the `typescript-7` alias so the project owns the TS7 release-candidate version:

```sh
pnpm add -D resultar-lint resultar-tsgo typescript-7@npm:typescript@rc
```

The wrapper resolves `typescript-7` from the project where `tsgo` is run first, then falls back to
the package-local copy used for development tests.

Configure `resultar-lint` in the checked `tsconfig.json` to choose which rules fail the wrapper:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "resultar-lint",
        "noDiscard": "error",
        "preferMapErr": "error",
        "preferAndThen": "error",
        "typedCatchMapper": "error"
      }
    ]
  }
}
```

See `examples/tsgo-lint` for a smoke test that enables every current Resultar rule and verifies the
wrapper reports all of them.
