---
"resultar": patch
"resultar-lint": major
"resultar-tsgo": patch
---

Rename the public no-discard command surface to the generic `resultar-lint` CLI.
`resultar-lint check` now runs the compiler-backed diagnostics, `resultar-lint doctor`
checks TypeScript patch status, and the legacy `resultar-no-discard` binary plus
`resultar-lint/no-discard` package subpath are no longer public entrypoints.
