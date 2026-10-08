---
"resultar": minor
"resultar-check": minor
---

Add root pipe, flow, identity, and constant helpers; share private direct/curried dispatch and pipeline execution. Add lazy ResultTask.fn, typed catchTag/catchTags recovery, and scoped acquireDisposable with awaited cleanup.

Protect task requirements from unknown/any types and unsafe assertions, and report unused suppression entries (both new rules default to suggestion). Analyze unsaved editor buffers with versioned UTF-16 fixes, channel/service hover, and conservative recovery/generator refactors. Add read-only overview and quickfixes CLI previews.

Preserve eager ResultAsync, repeatable lazy ResultTask, runners, and existing cause/cleanup policies. Fibers and task concurrency remain deferred.

Expand the executable checker examples to all 30 rules, covering requirement erasure, obsolete suppressions, parameterized generators, and native disposable scopes alongside zero-diagnostic corrected patterns. Compile all three fixture projects with the installed TypeScript compiler before the native CLI checks in smoke tests and CI.

Compose the checker configuration schema with the standard tsconfig schema, preserving editor completion and validation for TypeScript options alongside Resultar rules. Add JSON language-service tests to the checker validation suite.
