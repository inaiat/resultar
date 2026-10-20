# Requests for Comments (RFCs) — Resultar

This directory centralizes the architectural proposals, design decisions, and technical specifications of the **Resultar** ecosystem.

These records preserve design history, including earlier recommendations for eager
`ResultAsync` workflows. For v4 usage, start with the [gradual adoption guide](../gradual-adoption.md)
and [migration reference](../migrations/v4.md): `ResultTask` is the default for new async work;
`ResultAsync` and `StrictResultAsync` are the active in-flight `Result` types returned by `task.runResult()` (and exported from both `resultar` and `resultar/async`), while deprecated eager orchestration helpers live in the `resultar/async` compatibility subpath.

---

## RFC Index

| RFC | Title | Target Package | Status | Date |
| :---: | :--- | :---: | :---: | :---: |
| [**RFC 0001**](./rfc-0001-result-task-core.md) | **ResultTask and the next core architecture** | `resultar` | **Implemented (Phases 0–5 Done)** | 2026-09-04 |
| [**RFC 0002**](./rfc-0002-di-lifetimes-scopes.md) | **Explicit lifetimes and request scopes** | `resultar-di` | **Implemented** | 2026-09-05 |
| [**RFC 0003**](./rfc-0003-phase-3-remainder-and-validation.md) | **Phase 3 remainder, live lifecycle validation, and dependency health** | `resultar` | **Partially Implemented (§§2–4 Done; §1 Live Pilot Pending)** | 2026-09-07 |
| [**RFC 0004**](./rfc-0004-effect-v4-ergonomics-and-tooling.md) | **Functional ergonomics and developer tooling** | `resultar`, `resultar-check` | **Implemented (Awaiting Release)** | 2026-10-06 |

---

## Tracking Documents and Addenda

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
