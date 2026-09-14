---
"resultar-fastify": patch
---

Keep request service scopes alive when Fastify signals a generic abort after a complete HTTP request body. Real client disconnects and response transport errors still cancel the scope, and explicit native timeout reasons remain forwarded. Add real-network JSON and streaming-response regression tests.
