---
---

Return native Fastify from the URL shortener factory and let the executable own configuration, listening, signals, and cleanup with ResultTask. Colocate service bindings, request locals, startup and Fastify service types in app-services.ts. Remove the ad hoc infrastructure plugin option and verify ownership through actual DI resources and production HTTP routes. Add lifecycle regression tests without changing resultar-fastify.
