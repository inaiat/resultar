---
"resultar": minor
"resultar-di": minor
---

Infer literal service identifiers with `ResultTask.service<Contract>()("name")` while retaining the direct overload.

Add `Service.require<Contract>()("name")` and optional `Service` dependency maps through `requires`. Construction factories receive inferred readonly dependencies and return a lazy ResultTask. Existing generator-only definitions, token identity, typed requirements and scope lifetimes remain supported.

Require Resultar 3.9 or newer in the DI package's JSR import map so the curried service primitive is available.

Make the Fastify and Hono examples self-contained, with class services using explicit `requires` maps, a repository, cache and function-based health service. Import the primary DI API through each framework integration and keep matching file layouts for services, routes and server startup. Omit optional bindings in both examples to expose all registered services.
