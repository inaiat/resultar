---
"resultar-fastify": patch
"resultar-hono": patch
---

Accept and forward native server/router options in `createFastifyApp` (`FastifyAppOptions`, such as `logger`, `loggerInstance`, and `requestIdHeader`) and `createHonoApp` (`HonoOptions`, such as `strict`, `router`, and `getPath`) while stripping Resultar service options before underlying framework initialization.
