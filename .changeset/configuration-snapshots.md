---
"resultar-config": minor
---

Add lazy TypeBox environment configuration modules with isolated snapshots, finite-number validation, safe aggregated ConfigError issues and exact DI graph inference.

Use the configuration module in the Hono example, validating PORT before listening
and sharing the validated snapshot with request services. Include isolated-source
and invalid-startup smoke coverage.

Add `AppConfigModule.load()` for direct typed configuration loading as a lazy
ResultTask, with a fresh isolated snapshot per execution. Simplify Hono startup
and document how to reuse the validated value in application services.
