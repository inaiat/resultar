---
"resultar-fastify": minor
---

Add `createFastifyApp(options, configure)` to create a native Fastify instance, register the existing Resultar services plugin and configure routes synchronously. It preserves binding validation and lazy provider initialization; Fastify still owns startup, requests and shutdown. Simplify the Fastify example to match Hono's application factory.

Preserve selected service types on the returned `FastifyServicesApplication` so `InferRequestServices<typeof createApplication>` and `InferAppServices` derive declarations from the bindings or custom exposed views. The type metadata adds no runtime properties, and native route plugins and autoload remain compatible.

Allow both inference helpers to accept factory functions directly, preserving inference from application instances and callable service plugins.
