# Especificação e Pendências da Fase 1 — RFC 0001: ResultTask

- **Referência:** [rfc-0001-result-task-core.md](./rfc-0001-result-task-core.md)
- **Data:** 2026-09-07
- **Branch:** `feat/result-task-phase-1`
- **Fase:** Fase 1 (Núcleo Lazy & Combinadores Essenciais)
- **Status:** ✅ **Concluído**

---

## 1. Contexto e Objetivo

O [RFC 0001](./rfc-0001-result-task-core.md) define a **Fase 1** como a consolidação do núcleo funcional lazy de `ResultTask`:

> ### Fase 1: núcleo lazy
> - `ResultTask<A, E, R>` e TypeId nominal;
> - `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`;
> - `map`, `mapError`, `flatMap`, `catchAll`, `tap`;
> - `runExit`, `runResult`, `runPromise`;
> - `Exit` e `Cause` mínimos;
> - adapters para `Result` e `ResultAsync`.
>
> **Critério de saída:** workflows sequenciais substituem `ResultAsync.andThen` sem perder inferência e sem iniciar operações durante a construção.

A Fase 0 entregou a representação nominal, variância estrita e o loop de trampoline iterativo com complexidade de pilha $O(1)$. A Fase 1 completa o conjunto de combinadores canônicos, adaptadores bidirecionais com `ResultAsync` e suporte a pipelines funcionais (`pipe`).

---

## 2. Matriz de Requisitos da Fase 1

| Item do RFC | Descrição | Status |
| :--- | :--- | :---: |
| **1. Modelo e TypeId** | `ResultTask<out A, out E, out R>` e `ResultTaskTypeId`. | ✅ **Concluído** |
| **2. Construtores Mínimos** | `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`. | ✅ **Concluído** |
| **3. Boundaries de Execução** | `runExit`, `runResult`, `runPromise`. | ✅ **Concluído** |
| **4. Combinadores Básicos** | `map`, `flatMap`, `catchAll`, `andThen`. | ✅ **Concluído** |
| **5. Combinador `mapError`** | Mapeamento lazy do canal de erro `E -> E2` via trampoline $O(1)$. | ✅ **Concluído** |
| **6. Combinador `tap`** | Side-effect lazy em sucesso (suporte a `ResultTask`, Promise ou síncrono). | ✅ **Concluído** |
| **7. Combinador `tapError`** | Side-effect lazy em erro de domínio (`Fail`), preservando erro original. | ✅ **Concluído** |
| **8. Combinadores `as` e `match`** | `as(value)` e `match({ onSuccess, onFailure })` retornando `ResultTask`. | ✅ **Concluído** |
| **9. Adapter `fromResultAsync`** | Converte `ResultAsync` (ou factory lazy) em `ResultTask`. | ✅ **Concluído** |
| **10. Adapter `toResultAsync`** | Executa `ResultTask` no runtime padrão gerando `ResultAsync`. | ✅ **Concluído** |
| **11. Adapter `ResultAsync.fromTask`**| Método estático em `ResultAsync` para interoperabilidade direta. | ✅ **Concluído** |
| **12. Dual-API para `pipe`** | Suporte a chamadas data-first `(task, f)` e curried data-last `(f)(task)`. | ✅ **Concluído** |
| **13. Testes e Stack Safety** | Suíte de testes da Fase 1 cobrindo lazy semantics e chains 10k de `mapError`/`tap`. | ✅ **Concluído** |
