# RFC 0012 — correções pendentes para a v5

Na revisão de 21/11/2026, quatro casos bloquearam a recomendação de publicar o `resultar-check` da v5. Os oito comandos de validação da RFC passaram. As falhas apareceram ao compilar e executar pequenos projetos consumidores. Os itens 1 a 3 afetam `resultar-check migrate-v5`. O item 4 afeta o `--fix` do checker normal, inclusive em projetos que já usam v5. [RFC 0012, §7](./rfc-0012-v5-async-model-unification.md)

## 1. P1 — Preservar a função chamada ao renomear `requestJsonTask`

```ts
import { ResultTask } from "resultar";
import { requestJsonTask } from "resultar-request";

async function lookup() {
  const requestJson = (..._args: unknown[]) => ResultTask.ok(0);
  const response = requestJsonTask({
    request: async () => new Response("42"),
    validator: (v: unknown): v is number => typeof v === "number",
  });
  return response.runPromise();
}

console.log(await lookup());
```

Na v4.1.1, o programa imprime `42`. O migrador troca o import e a chamada para `requestJson`. Dentro de `lookup`, esse nome resolve para a função local. O código migrado passa em `tsc --noEmit` e imprime `0`.

**Correção proposta.** Em `migrateRequestImport`, preserve o nome local quando a renomeação capturaria outro símbolo em algum ponto de uso. Neste exemplo, basta gerar `import { requestJson as requestJsonTask } from 'resultar-request'` e manter a chamada. A mesma regra atende aos adaptadores Zod e TypeBox que usam a tabela de renomeação. [Implementação do migrador](../../packages/check/native/internal/analyzer/migrate_v5.go)

- [x] O projeto migrado compila e imprime `42`. A função local continua disponível pelo nome original.

## 2. P1 — Tratar chaves computadas em `match` sem interromper a migração

```ts
import { ResultTask } from "resultar";

const onFailure = "error" as const;
const value = await ResultTask.err("declined")
  .runResult()
  .match({
    ok: () => "",
    [onFailure]: (e) => e.toUpperCase(),
  });
console.log(value);
```

A v4.1.1 imprime `DECLINED`. Tanto o preview quanto o `--fix` encerram a análise do projeto com código 2 e `panic: Unhandled case in Node.Text: KindComputedPropertyName`.

**Correção proposta.** Em `formatNormalizedResultMatchArg`, verifique o tipo do nó antes de chamar `Text()`. O migrador pode normalizar uma chave literal conhecida. Para uma expressão como `[getKey()]`, encaminhe a chamada para revisão manual se a reescrita puder adiar a avaliação da chave. [Normalização e análise dos argumentos](../../packages/check/native/internal/analyzer/migrate_v5.go)

- [x] Preview e `--fix` terminam e também analisam os demais arquivos. Quando o migrador pede revisão, os dois modos identificam o mesmo caso. A migração concluída imprime `DECLINED`.
- [x] Um teste com `[getKey()]` verifica que a chave continua sendo avaliada uma vez, antes da instrução seguinte à chamada, ou que o migrador preserva a expressão e pede revisão.

## 3. P1 — Preservar o ramo de erro quando os handlers vêm de uma variável

```ts
import { ResultTask } from "resultar";

const handlers = {
  ok: (v: never) => String(v),
  error: (e: string) => e.toUpperCase(),
};
console.log(await ResultTask.err("declined").runResult().match(handlers));
```

O migrador gera `.runResult().then(r => r.match(handlers))`. A v4.1.1 imprime `DECLINED`. Na v5, o `Result.match` síncrono espera a propriedade `err`. O TypeScript reporta `TS2741` e o ramo de erro lança `TypeError` em execução. Uma segunda passagem gera zero edições.

**Correção proposta.** Antes de mover o `match` para dentro de `.then(...)`, verifique o tipo do objeto referenciado. Para o formato legado `{ ok, error }`, uma migração que preserva o comportamento é `new ResultAsync(task.runResult()).match(handlers)`, com import de `resultar/async`. Se o formato for ambíguo, registre revisão manual. Alterar a declaração compartilhada de `handlers` pode quebrar seus outros consumidores. [Implementação de `migrateRunResultChain`](../../packages/check/native/internal/analyzer/migrate_v5.go)

- [x] O exemplo migrado compila e imprime `DECLINED`. Um teste adicional com `{ ok, err }` cobre o formato que já pode ser passado ao `Result.match` síncrono.

## 4. P1 — Preservar o retorno inferido de uma função que entrega uma Task

```ts
import { ResultTask } from "resultar";

let runs = 0;
const task = ResultTask.sync(() => ++runs);
async function factory() {
  return await task;
}

const pending = await factory();
console.log(runs);
console.log(await pending.runPromise());
```

O contrato inferido de `factory` é `Promise<ResultTask<number>>`. O consumidor recebe a Task, observa `runs === 0` e só então a executa. O checker troca o retorno por `return await task.runResult()`, antecipa a execução e faz o consumidor receber um `Result`. A chamada seguinte a `runPromise()` falha na compilação e em execução.

**Correção proposta.** Em `classifyAwaitSurrounding`, trate um retorno sem anotação como intenção desconhecida quando faltar evidência de que o consumidor espera um `Result`. Nesse caso, emita apenas o diagnóstico. Quando o contrato de Task estiver estabelecido, remover o `await` redundante preserva a execução sob controle do chamador. [Regra `no-await-result-task`](../../packages/check/native/internal/analyzer/v5_rules.go)

- [x] Após `resultar-check --fix`, o exemplo compila e imprime `0` e depois `1`. O teste também cobre um retorno explicitamente tipado como `Promise<Result<...>>`, para o qual executar a Task é apropriado.

## Notas da versão

- [x] Corrigir a seção 9 da RFC e o changeset. Ambos dizem que os helpers estáticos de orquestração foram removidos. O pacote oferece `ResultAsync.retry` e `ResultAsync.withResource` pelo import `resultar/async`. Documentar que os helpers eager da v4 seguem disponíveis nesse subpath como APIs depreciadas durante a v5.x, conforme o guia de migração. [Registro da implementação](./rfc-0012-v5-async-model-unification.md) · [Changeset](https://github.com/inaiat/resultar/blob/ba1b3819c0c772e02fff538fd96db0527f79c752/.changeset/v5-async-model-unification.md) · [Guia de migração](../migrations/v5.md)

## Como validar o fechamento

1. Para os itens 1 a 3, compile cada consumidor com `tsc --noEmit` em modo estrito e execute-o contra a v4.1.1. Guarde a saída como referência. Rode `resultar-check migrate-v5 --project tsconfig.json --json` e confirme que o preview preserva os arquivos.
2. Aplique `--fix` sobre a mesma entrada v4. Confira as edições e os casos manuais com o preview. Após resolver os casos manuais, compile e execute contra o pacote v5 construído. Compare a saída com a v4.1.1 e confirme que outra passagem produz zero edições.
3. Para o item 4, use a v5 antes e depois de `resultar-check --project tsconfig.json --fix`. Verifique a contagem de execuções no ponto em que a função devolve a Task e após o chamador executá-la.
4. Acrescente os casos às suítes do migrador e da regra, registre a mudança de comportamento no changeset de `resultar-check` e repita os oito comandos da seção 7 da RFC. [Testes do migrador](../../packages/check/native/cmd/resultar-check/migrate_v5_test.go) · [Testes das regras v5](../../packages/check/native/internal/analyzer/v5_rules_test.go)
