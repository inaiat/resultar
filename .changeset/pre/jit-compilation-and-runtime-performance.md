---
"resultar": patch
"resultar-di": patch
"resultar-hono": patch
"resultar-request-typebox": patch
"resultar-config": patch
---

Implement transparent CSP-safe JIT compilation, static DI graph specialization, and V8 runtime performance optimizations (RFC 0011) with zero public API changes and automatic `RESULTAR_JIT=0` / strict-CSP fallback:

- **`resultar`**:
  - Unify `ResultTaskRuntimeContext` hidden-class property ordering, replace object instruction tags with V8 Smi numeric opcodes plus dedicated `OP_CATCH_TAG`/`OP_CATCH_TAGS`, specialize `pipe`/`flow`/`dual` by arity, pool `OkResultIterator` and continuation stacks, and remove boxing allocations in `tagged-match`.
  - Compile `$variable` message templates in `createTaggedError` once at class-creation time with shared frozen fingerprints and zero-tuple metadata copying, and cache `taggedEnum` constructors.
  - Add a lazy decision-tree JIT compiler for reusable `Match` matchers (`switch (v._tag)`, inlined built-in guards and nested object/array checks) plus a zero-allocation `Match.valueTags` fast path.
  - Add an unboxed `runTaskLoop` and tiered lazy JIT compilation for hot reusable `ResultTask` chains (`map`, `andThen`, `mapErr`, `catchAll`, `catchTag`, `catchTags`) with cooperative scheduler checkpoints, mid-chain async bailout, and `AbortSignal` preservation.
- **`resultar-di` & `resultar-hono`**:
  - Add static dependency subgraph specialization (Tier 0 pure singleton/value, Tier 1 scoped/transient sync JIT, Tier 2 full `TaskScope` for resources/streams), replace per-request `children` `Set` allocations with counter-based draining, skip empty `Map` cloning and `defaultResolvers` recomputation, and skip empty `withServices({})` wrapping in `createHonoServices`.
- **`resultar-request-typebox` & `resultar-config`**:
  - Cache compiled `TypeBox` `Compile(schema)` validators per schema in a `WeakMap` (with automatic `Value.Check` fallback under `RESULTAR_JIT=0` or uncompilable schemas) and lazily compile and cache Ajv validators once per `defineAppConfig` instance.
