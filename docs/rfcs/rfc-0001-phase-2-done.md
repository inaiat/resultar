# Especificação e Pendências da Fase 2 — RFC 0001: ResultTask

- **Referência:** [rfc-0001-result-task-core.md](./rfc-0001-result-task-core.md)
- **Data:** 2026-09-07
- **Branch:** `feat/result-task-phase-2`
- **Fase:** Fase 2 (Generator e Serviços)
- **Status:** ✅ **Concluído**

---

## 1. Contexto e Objetivo

O [RFC 0001](./rfc-0001-result-task-core.md) define a **Fase 2** como a expansão do modelo com generators lineares e injeção de dependências tipada:

> ### Fase 2: generator e serviços
> - `ResultTask.gen`;
> - contrato yieldable nominal;
> - service tags;
> - `service`, `provideService`, `provideServices` e `provideServiceResolver`;
> - erros de serviço ausente como defeito de runtime;
> - testes de inferência de requisitos compostos.
>
> **Critério de saída:** um workflow de aplicação pode declarar e prover database, logger e clock sem capturar essas dependências por closure.

---

## 2. Matriz de Requisitos da Fase 2

| Item do RFC | Descrição | Status |
| :--- | :--- | :---: |
| **1. Contrato Yieldable Nominal** | Símbolos nominais `ServiceTagTypeId` e `ResultTaskYieldTypeId` via `unique symbol`. | ✅ **Concluído** |
| **2. Standalone Helpers** | `serviceTag` e `isServiceTag` expostos no pacote principal. | ✅ **Concluído** |
| **3. Result Interop em `gen`** | Suporte a `yield* result` (`ok` e `err`) diretamente no generator, propagando o erro para `E`. | ✅ **Concluído** |
| **4. MissingServiceError** | Classe de erro explícita tratada como causa `Die`, garantindo execução de `finally` em LIFO. | ✅ **Concluído** |
| **5. Métodos de Instância de Provisão** | `task.provideService`, `task.provideServices`, `task.provideServiceResolver`. | ✅ **Concluído** |
| **6. Dual-API Estático para `pipe`** | Sobrecargas data-first e curried para `provideService`, `provideServices` e `provideServiceResolver`. | ✅ **Concluído** |
| **7. Inferência de Requisitos Compostos** | Acúmulo de $R$ em `yield*`, eliminação seletiva/total e liberação de `runResult(task)`. | ✅ **Concluído** |
| **8. Suíte de Testes e Tipagem** | Testes completos cobrindo linearidade de generators, `finally`, e type tests em TypeScript. | ✅ **Concluído** |
