---
"resultar-request-typebox": minor
---

Reexport TypeBox's `Type` as `t` from the public entry point, allowing request helpers,
schema builders and `t.Static` inference to be used from one import. Preserve direct
TypeBox import compatibility and eager/lazy request behavior. Update documentation
and the request example; TypeBox remains a peer dependency.
