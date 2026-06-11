# Resultar TSGo

Local wrapper around `@typescript/native-preview` that exposes a `tsgo` binary and runs Resultar
no-discard validation after the native TypeScript 7 check succeeds.

Install it next to `@typescript/native-preview` so the project owns the TS7 native preview version:

```sh
pnpm add -D resultar-lint resultar-tsgo @typescript/native-preview
```

The wrapper resolves `@typescript/native-preview` from the project where `tsgo` is run first, then
falls back to the package-local copy used for development tests.
