# Phase 2 Specification and Pending Items — RFC 0001: ResultTask

- **Reference:** [rfc-0001-result-task-core.md](./rfc-0001-result-task-core.md)
- **Date:** 2026-09-07
- **Branch:** `feat/result-task-phase-2`
- **Phase:** Phase 2 (Generator and Services)
- **Status:** ✅ **Done**

---

## 1. Context and Objective

The [RFC 0001](./rfc-0001-result-task-core.md) defines **Phase 2** as the expansion of the model with linear generators and typed dependency injection:

> ### Phase 2: generator and services
> - `ResultTask.gen`;
> - nominal yieldable contract;
> - service tags;
> - `service`, `provideService`, `provideServices`, and `provideServiceResolver`;
> - missing-service errors as runtime defects;
> - composite-requirements inference tests.
>
> **Exit criterion:** an application workflow can declare and provide database, logger, and clock without capturing those dependencies via closure.

---

## 2. Phase 2 Requirements Matrix

| RFC Item | Description | Status |
| :--- | :--- | :---: |
| **1. Nominal Yieldable Contract** | Nominal symbols `ServiceTagTypeId` and `ResultTaskYieldTypeId` via `unique symbol`. | ✅ **Done** |
| **2. Standalone Helpers** | `serviceTag` and `isServiceTag` exposed in the main package. | ✅ **Done** |
| **3. Result Interop in `gen`** | Supports `yield* result` (`ok` and `err`) directly in the generator, propagating the error into `E`. | ✅ **Done** |
| **4. MissingServiceError** | Explicit error class treated as a `Die` cause, guaranteeing `finally` execution in LIFO order. | ✅ **Done** |
| **5. Provision Instance Methods** | `task.provideService`, `task.provideServices`, `task.provideServiceResolver`. | ✅ **Done** |
| **6. Static Dual API for `pipe`** | Data-first and curried overloads for `provideService`, `provideServices`, and `provideServiceResolver`. | ✅ **Done** |
| **7. Composite Requirements Inference** | Accumulation of $R$ across `yield*`, selective/total elimination, and release of `runResult(task)`. | ✅ **Done** |
| **8. Test and Typing Suite** | Full tests covering generator linearity, `finally`, and TypeScript type tests. | ✅ **Done** |
