# Requests for Comments (RFCs) — Resultar

This directory centralizes the architectural proposals, design decisions, and technical specifications of the **Resultar** ecosystem.

These records preserve design history, including earlier recommendations for eager
`ResultAsync` workflows. For v5 usage, start with the [gradual adoption guide](../gradual-adoption.md)
and [v5 migration guide](../migrations/v5.md): `Result` handles synchronous values, `ResultTask` is
the unified lazy async workflow primitive (`task.runResult()` returns native `Promise<Result<...>>`),
and opt-in eager `ResultAsync` compatibility lives in `resultar/async`.

---

## RFC Index

|                                   RFC                                    | Title                                                                                        |                                                              Target Package                                                              |                             Status                             |    Date    |
| :----------------------------------------------------------------------: | :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------: | :--------: |
|              [**RFC 0001**](./rfc-0001-result-task-core.md)              | **ResultTask and the next core architecture**                                                |                                                                `resultar`                                                                |               **Implemented (Phases 0–5 Done)**                | 2026-09-04 |
|            [**RFC 0002**](./rfc-0002-di-lifetimes-scopes.md)             | **Explicit lifetimes and request scopes**                                                    |                                                              `resultar-di`                                                               |                        **Implemented**                         | 2026-09-05 |
|      [**RFC 0003**](./rfc-0003-phase-3-remainder-and-validation.md)      | **Phase 3 remainder, live lifecycle validation, and dependency health**                      |                                                                `resultar`                                                                | **Partially Implemented (§§2–4 Done; §1 Live Pilot Pending)**  | 2026-09-07 |
|      [**RFC 0004**](./rfc-0004-effect-v4-ergonomics-and-tooling.md)      | **Functional ergonomics and developer tooling**                                              |                                                       `resultar`, `resultar-check`                                                       |               **Implemented (Awaiting Release)**               | 2026-10-06 |
|   [**RFC 0005**](./rfc-0005-contract-safety-http-and-ai-validation.md)   | **Contract safety, HTTP cancellation, and AI validation**                                    |                                                  `resultar-check`, `resultar-request*`                                                   | **Closed (Software Implemented; V1 Deferred; V2 in RFC 0003)** | 2026-11-11 |
|       [**RFC 0006**](./rfc-0006-task-cancellation-and-recovery.md)       | **Task cancellation, resource cleanup, and recovery diagnostics**                            |                                                       `resultar`, `resultar-check`                                                       |         **Implemented (Validated; Awaiting Release)**          | 2026-11-14 |
|        [**RFC 0007**](./rfc-0007-task-promise-defect-boundary.md)        | **Direct Promise adaptation with defect semantics**                                          |                                                       `resultar`, `resultar-check`                                                       |         **Implemented (Validated; Awaiting Release)**          | 2026-11-15 |
|         [**RFC 0008**](./rfc-0008-declarative-configuration.md)          | **Declarative configuration and dependency injection**                                       |                                                            `resultar-config`                                                             |             **Implemented (Awaiting Publication)**             | 2026-11-16 |
| [**RFC 0009**](./rfc-0009-inference-scopes-and-application-lifecycle.md) | **Inference, typed scope closure, and application lifecycle**                                |                                               `resultar`, `resultar-di`, `resultar-check`                                                |   **Implemented (Recipe-only Lifecycle; Awaiting Release)**    | 2026-11-16 |
|  [**RFC 0010**](./rfc-0010-dx-observability-concurrency-and-tooling.md)  | **Core DX, lean concurrency, opt-in observability, subpath tree-shaking, and tooling**       |                                               `resultar`, `resultar-app`, `resultar-check`                                               |         **Implemented (Validated; Awaiting Release)**          | 2026-11-19 |
|  [**RFC 0011**](./rfc-0011-jit-compilation-and-runtime-performance.md)   | **Transparent JIT compilation, static graph specialization, and V8 runtime performance**     |     `resultar`, `resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request-typebox`, `resultar-config`     |         **Implemented (Validated; Awaiting Release)**          | 2026-11-20 |
|         [**RFC 0012**](./rfc-0012-v5-async-model-unification.md)         | **v5 unified async model, `ResultTask` / `ResultAsync` decoupling, and ecosystem alignment** | `resultar`, `resultar-app`, `resultar-check`, `resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request*` |         **Implemented (Validated; Awaiting Release)**          | 2026-11-20 |

---

## Tracking Documents and Addenda

- [RFC 0012 correction plan](./rfc-0012-fix-plan.md) records four checker regressions affecting v5 adoption, their acceptance criteria, and the release-note correction.

- [RFC 0010 and RFC 0011 correction plan](./rfc-0010-0011-fix-plan.md) tracks the open findings from the review of `cacb729`, regression tests, and performance acceptance criteria.

- [**Resolution of Phase 0 Items — RFC 0001 (Done)**](./rfc-0001-phase-0-done.md): Record of resolving the stack overflow via iterative trampoline, 10k-chain benchmarks, and nominal `ResultTaskTypeId` typing.
- [**Phase 1 Specification and Completed Items — RFC 0001 (Done)**](./rfc-0001-phase-1-done.md): Specification of the lazy combinators (`mapError`, `tap`, `tapError`, `match`, `as`), interoperability with `ResultAsync`, and functional pipelines.
- [**Phase 2 Specification and Completed Items — RFC 0001 (Done)**](./rfc-0001-phase-2-done.md): Specification of `ResultTask.gen`, the nominal yieldable contract, service tags, and resolution of $R$ requirements.

- [**Phase 2 Review — RFC 0001**](./rfc-0001-phase-2-review.md): Confirmed fixes and resolution of tasks F2-R1 (incompatible provider rejection) and F2-R2 (full inference of the curried resolver).

---

## RFC Lifecycle

1. **Proposal (Draft):** Creation of the document describing motivation, proposed API, alternatives analysis, and transition plan.
2. **Review and Proof of Concept (Phase 0):** Minimal proofs of concept, stack safety, preliminary benchmarks, and type validation with TypeScript.
3. **Implementation (In Progress):** Execution of the incremental phases described in the delivery plan.
4. **Done (Implemented):** Incorporated into the official release and integrated into the packages' public documentation.
