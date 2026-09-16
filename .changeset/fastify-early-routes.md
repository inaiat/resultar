---
"resultar-fastify": patch
---

Attach request services to earlier-registered child routes, such as Swagger UI routes, whose request constructors predate the services decorator. Preserve request isolation and resource cleanup.
