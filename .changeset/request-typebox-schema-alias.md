---
"resultar-request-typebox": minor
---

Reexport TypeBox's `Type` as `t` from the public entry point, allowing request helpers,
schema builders and `t.Static` inference to be used from one import. Preserve direct
TypeBox import compatibility and eager/lazy request behavior. Update documentation
and the request example. Move TypeBox from a peer dependency to a runtime dependency
with range `>=1.3.4 <2.0.0`, so using `t` requires no separate TypeBox installation.
