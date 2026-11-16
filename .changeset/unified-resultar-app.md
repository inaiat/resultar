---
"resultar-app": minor
---

Add resultar-app as the unified entry point for Resultar workflows, dependency
injection and configuration. Reexport the existing implementations and types,
including the TypeBox t alias, preserving runtime identity and execution semantics.
Applications can install resultar-app and keep framework adapters as explicit
integrations. Migrate the Hono example to the unified entry point.
