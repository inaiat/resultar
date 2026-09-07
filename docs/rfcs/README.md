# Requests for Comments (RFCs) — Resultar

Este diretório centraliza as propostas arquiteturais, decisões de design e especificações técnicas do ecossistema **Resultar**.

---

## Índice de RFCs

| RFC | Título | Pacote Alvo | Status | Data |
| :---: | :--- | :---: | :---: | :---: |
| [**RFC 0001**](./rfc-0001-result-task-core.md) | **ResultTask e a próxima arquitetura do core** | `resultar` | **Em Andamento (Fases 0 e 1 Concluídas)** | 2026-09-04 |
| [**RFC 0002**](./rfc-0002-di-lifetimes-scopes.md) | **Lifetimes explícitos e escopos de requisição** | `resultar-di` | **Implementado** | 2026-09-05 |

---

## Documentos de Acompanhamento e Adendos

- [**Resolução das Pendências da Fase 0 — RFC 0001**](./rfc-0001-fase-0-pendencias.md): Registro da resolução do estouro de stack via trampoline iterativo, benchmarks de 10k cadeias e tipagem nominal `ResultTaskTypeId`.
- [**Especificação e Pendências da Fase 1 — RFC 0001**](./rfc-0001-fase-1-pendencias.md): Especificação dos combinadores lazy (`mapError`, `tap`, `tapError`, `match`, `as`), interoperabilidade com `ResultAsync` e pipelines funcionais.

---

## Ciclo de Vida de um RFC

1. **Proposta (Draft):** Criação do documento descrevendo motivação, API proposta, análise de alternativas e plano de transição.
2. **Revisão e Prova de Conceito (Fase 0):** Provas de conceito mínimas, stack-safety, benchmarks preliminares e validação de tipos com TypeScript.
3. **Implementação (In Progress):** Execução das fases incrementais descritas no plano de entrega.
4. **Concluído (Implemented):** Incorporado na release oficial e integrado à documentação pública dos pacotes.
