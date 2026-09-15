---
"resultar-hono": minor
---

Preserve selected bindings in the `createHonoApp` return type and export
`InferRequestServices` for application instances and factory functions. Separate route
files can derive their Hono environment from `typeof createApplication` without repeating
service tokens. The existing `HonoApplication<CloseError>` contract remains supported;
inference adds no runtime metadata or lifecycle changes.

Align the guides with the runnable examples: `main.ts` exports `AppHono`, route files
import that type, and the factory's bindings define the exposed services. Document the
matching Fastify declaration and self-contained services/routes/main layout.
