---
"resultar-fastify": minor
---

Allow individual Fastify routes to skip the Resultar request scope with
`config.resultar.requestScope: false`. These routes skip request locals, service
acquisition and request exposure while retaining access to application services.
