---
"resultar-config": minor
---

Reexport TypeBox's `Type` as `t` so configuration schemas and `defineAppConfig`
can be imported from `resultar-config` together. Preserve schema inference and
compatibility with direct TypeBox imports. Move TypeBox from a peer dependency to
a runtime dependency with range `>=1.3.4 <2.0.0`, so using `t` requires no separate
TypeBox installation.
Update the Hono example and configuration recipe to use the new alias.
