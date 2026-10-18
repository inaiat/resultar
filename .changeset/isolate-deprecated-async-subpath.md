---
"resultar": major
"resultar-check": patch
"resultar-check-darwin-arm64": patch
"resultar-check-darwin-x64": patch
"resultar-check-linux-arm64": patch
"resultar-check-linux-x64": patch
"resultar-check-win32-arm64": patch
"resultar-check-win32-x64": patch
---

Organize the deprecated eager API in `src/resultar-async` and expose it through
`resultar/async` within the existing Resultar package. Keep one installation and
release, with shared Result, Task, tagged-error and retry-policy identities.

Prefer the Async subpath for eager constructors, generators and functional helpers,
while preserving the existing root imports and compatibility module paths. Keep
Task lazy, preserve explicit bridges in both directions and recognize the supported
helpers in diagnostics. Existing eager execution and terminal behavior are retained.
