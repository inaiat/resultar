# Requests for Comments (RFCs) — Resultar

This directory centralizes the architectural proposals, design decisions, and technical specifications of the **Resultar** ecosystem.

---

## RFC Index

| RFC | Title | Target Package | Status | Date |
| :---: | :--- | :---: | :---: | :---: |
| [**RFC 0001**](./rfc-0001-result-task-core.md) | **ResultTask and the next core architecture** | `resultar` | **In Progress (Phases 0, 1, and 2 Done)** | 2026-09-04 |
| [**RFC 0002**](./rfc-0002-di-lifetimes-scopes.md) | **Explicit lifetimes and request scopes** | `resultar-di` | **Implemented** | 2026-09-05 |
| [**RFC 0003**](./rfc-0003-phase-3-remainder-and-validation.md) | **Phase 3 remainder, live lifecycle validation, and dependency health** | `resultar` | **Draft** | 2026-09-07 |

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
