# Phase 1 Specification and Pending Items — RFC 0001: ResultTask

- **Reference:** [rfc-0001-result-task-core.md](./rfc-0001-result-task-core.md)
- **Date:** 2026-09-07
- **Branch:** `feat/result-task-phase-1`
- **Phase:** Phase 1 (Lazy Core & Essential Combinators)
- **Status:** ✅ **Done**

---

## 1. Context and Objective

The [RFC 0001](./rfc-0001-result-task-core.md) defines **Phase 1** as the consolidation of the lazy functional core of `ResultTask`:

> ### Phase 1: lazy core
> - `ResultTask<A, E, R>` and nominal TypeId;
> - `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`;
> - `map`, `mapError`, `flatMap`, `catchAll`, `tap`;
> - `runExit`, `runResult`, `runPromise`;
> - minimal `Exit` and `Cause`;
> - adapters for `Result` and `ResultAsync`.
>
> **Exit criterion:** sequential workflows replace `ResultAsync.andThen` without losing inference and without starting operations during construction.

Phase 0 delivered the nominal representation, strict variance, and the iterative trampoline loop with $O(1)$ stack complexity. Phase 1 completes the set of canonical combinators, bidirectional adapters with `ResultAsync`, and functional pipeline (`pipe`) support.

---

## 2. Phase 1 Requirements Matrix

| RFC Item | Description | Status |
| :--- | :--- | :---: |
| **1. Model and TypeId** | `ResultTask<out A, out E, out R>` and `ResultTaskTypeId`. | ✅ **Done** |
| **2. Minimal Constructors** | `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`. | ✅ **Done** |
| **3. Execution Boundaries** | `runExit`, `runResult`, `runPromise`. | ✅ **Done** |
| **4. Basic Combinators** | `map`, `flatMap`, `catchAll`, `andThen`. | ✅ **Done** |
| **5. `mapError` Combinator** | Lazy mapping of the error channel `E -> E2` via the $O(1)$ trampoline. | ✅ **Done** |
| **6. `tap` Combinator** | Lazy side effect on success (supports `ResultTask`, Promise, or synchronous). | ✅ **Done** |
| **7. `tapError` Combinator** | Lazy side effect on domain error (`Fail`), preserving the original error. | ✅ **Done** |
| **8. `as` and `match` Combinators** | `as(value)` and `match({ onSuccess, onFailure })` returning `ResultTask`. | ✅ **Done** |
| **9. `fromResultAsync` Adapter** | Converts `ResultAsync` (or a lazy factory) into `ResultTask`. | ✅ **Done** |
| **10. `toResultAsync` Adapter** | Runs `ResultTask` on the default runtime, producing `ResultAsync`. | ✅ **Done** |
| **11. `ResultAsync.fromTask` Adapter**| Static method on `ResultAsync` for direct interoperability. | ✅ **Done** |
| **12. Dual API for `pipe`** | Supports data-first `(task, f)` and curried data-last `(f)(task)` calls. | ✅ **Done** |
| **13. Tests and Stack Safety** | Phase 1 test suite covering lazy semantics and 10k `mapError`/`tap` chains. | ✅ **Done** |
