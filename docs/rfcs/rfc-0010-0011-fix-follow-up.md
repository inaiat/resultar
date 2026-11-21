# RFCs 0010 e 0011 — correções após a segunda revisão

**As três pendências da segunda revisão foram corrigidas e validadas em 20/11/2026**, incluindo o caso equivalente em `resultar-nestjs`. Os testes reproduziram as falhas em `7348f02` e passaram com as correções locais sobre `1b553ed`. Os 12 cenários da revisão final, os 5 da revalidação e os 2 bloqueadores de ciclo de vida (finalizadores assíncronos/extensos no relógio virtual e cancelamentos sobrepostos/reentrantes no Fetch) foram todos corrigidos e validados. [Registro da revisão final](./rfc-0010-0011-fix-plan.md#pendências-da-revalidação)

## P1 · Fastify aguarda indefinidamente após desconexão durante streaming

**Reprodução confirmada.** Um cliente enviou todo o corpo de um POST, recebeu o primeiro trecho da resposta e fechou a conexão enquanto o servidor ainda transmitia. Nesse ponto, `request.raw.complete` era verdadeiro e `request.raw.aborted` era falso. O fechamento da resposta deixou o contador incrementado por `beginChild()` sem o `endChild()` correspondente. Na mesma reprodução, `app.close()` concluiu em `cacb729` e ficou pendente com os hooks rápidos. O mesmo padrão também existia no tracker rápido sobre Fastify em `resultar-nestjs`. [Hooks do Fastify](../../packages/fastify/src/fast-hooks.ts) · [Dispatcher rápido do NestJS](../../packages/nestjs/src/fast-request.ts)

**Correção aplicada.** Ao ativar uma requisição no caminho rápido (`executeFastPlan` em `resultar-fastify` e `createFastTracker` em `resultar-nestjs`), registramos um finalizador idempotente em `request[fastActiveKey]` e escutamos também `reply.raw.once("close", finalize)` (além de `onResponse` e `onRequestAbort`, com guarda `if (rawReply.closed) finalize()`). O finalizador limpa o slot da requisição, remove o listener de `close` e chama `bridge.endChild()` exatamente uma vez — tanto para bindings estáticos quanto para `locals` dinâmicos por requisição.

**Teste de aceite.** [Testes de ciclo de vida do Fastify](../../packages/fastify/tests/jit.test.ts) e [Testes de ciclo de vida do NestJS](../../packages/nestjs/tests/jit.test.ts) abrem servidor real em porta efêmera (`127.0.0.1:0`), mantêm uma requisição `/hold` ativa, executam um `/ping` normal concorrente (validando que `onResponse` + `close` não decrementam duas vezes), enviam um `POST /stream` completo via `node:http`, desconectam o cliente logo após o primeiro trecho (`chunk-1\n`) de um `PassThrough` aberto, aguardam `reply.raw` `close` e comprovam que `app.close()` conclui apenas após `/hold` terminar, liberando o singleton `pool` exatamente uma vez. Executado para `static` e `dynamic` e em `RESULTAR_JIT=1` e `0`.
- **Antes do fix (`7348f02`):** `4/4` falharam com timeout em `app.close()` em `resultar-fastify` e `4/4` falharam em `resultar-nestjs`.
- **Após o fix:** `7/7` passaram em `resultar-fastify` (`36–52 ms` por cenário) e `7/7` passaram em `resultar-nestjs` (`36–56 ms`); `bench:fastify-http` manteve `97.4%` (Tier 0), `96.6%` (Tier 1) e `95.3%` (Tier 1 deep 8-service) do Fastify puro.

## P1 · A cópia de um erro perde o discriminador e os metadados

**Reprodução confirmada.** Para uma classe criada com `createTaggedError({ name: 'Missing' })`, `Object.keys(new Missing())` devolvia `_tag`, `fingerprint`, `messageTemplate` e `name` em `cacb729`. Com os campos no protótipo, a lista passou a ser vazia e `{ ...error }` perdeu os quatro campos. A seção 4.2 da RFC exige que `fingerprint` seja uma propriedade própria e enumerável. [Implementação](../../packages/resultar/src/tagged/tagged-error.ts) · [RFC 0011](./rfc-0011-jit-compilation-and-runtime-performance.md#42-constructor-allocation-elimination)

**Correção aplicada.** Restaurada a inicialização de `_tag`, `fingerprint`, `messageTemplate` (class fields) e `this.name = options.name` diretamente na instância, removendo `Object.defineProperties(GeneratedTaggedError.prototype, ...)` e mantendo a tupla congelada `sharedFingerprint` compartilhada entre instâncias, o caminho rápido de `super(message)` com 1 argumento quando `cause === undefined`, o tratamento de `cause`, os metadados readonly do consumidor e o suporte a `extends` com classe base personalizada.

**Teste de aceite.** [Testes de erros](../../packages/resultar/tests/tagged-error.test.ts) validam `Object.hasOwn`, os descritores (`{ configurable: true, enumerable: true, writable: true }`), `Object.keys`, o spread `{ ...error }`, `toJSON()`, `cause` e a identidade da tupla congelada `fingerprint` entre duas instâncias, tanto em classes padrão (`Missing`, `StaticMessageError`, `UserNotFoundError`) quanto com base personalizada (`ForbiddenError extends AppError`).
- **Antes do fix (`7348f02`):** `2/2` novos testes falharam (`Object.hasOwn(missingA, '_tag') === false` e `Object.hasOwn(forbiddenA, '_tag') === false`).
- **Após o fix:** `20/20` passaram em `packages/resultar/tests/tagged-error.test.ts`.
- **Nova medição `TaggedError + catchTag` (Node.js v26.13.1, Apple Silicon, `effect@4.1.4`, `BENCH_ITERATIONS=4000`):**
  - Suíte completa (`bench:effect`, **10/10** cenários vencidos): `736,267 op/s` (`1.36 µs`, `±0.47%`) vs `449,880 op/s` (`2.22 µs`, `±0.75%`) = **1.64×** (segunda rodada completa: `706,029` vs `494,507 op/s` = **1.43×**, 10/10 vencidos).
  - 3 repetições isoladas (`BENCH_FILTER=TaggedError BENCH_ITERATIONS=4000`): **1.86×** (`706.7k ±0.59%` vs `380.6k ±1.91%`), **1.80×** (`723.8k ±0.72%` vs `402.6k ±0.97%`) e **1.66×** (`709.1k ±1.13%` vs `426.7k ±1.03%`) — mediana **1.80×**, atendendo à meta `>= 1.5×` da RFC 0011 (§9.3).
  - `bench:match` (`createTaggedError` 3-var template): `864,181 op/s` (`JIT=1`) vs `852,555 op/s` (`JIT=0`), sem regressão frente aos `861k op/s` anteriores.

## P2 · O playground pode executar um snippet diferente do selecionado

**Condição identificada na leitura do código.** Na primeira execução, o clique em **Executar** iniciava o carregamento assíncrono do runner e lia `state.playgroundCode` apenas depois do `await import(...)`. Se o usuário trocasse do snippet A para um link compartilhado B nesse intervalo, o runner despachava B para o iframe e só descartava a saída após o retorno. [Fluxo de execução](../../website/src/main.ts)

**Correção aplicada.** `executePlayground()` captura o texto atual do editor antes do primeiro `await`, verifica `if (state.playgroundRunSeq !== seq) return;` imediatamente após resolver `import("./playground-runner.js")` (antes de chamar `runPlaygroundCode(code)`), despacha apenas o `code` capturado e mantém a verificação de sequência após o retorno do runner.

**Teste de aceite.** [Testes do playground no navegador](../../website/tests/playground-browser.test.ts) usam um gate no servidor estático para segurar a resposta do chunk `assets/playground-runner-*.js`, observam diretamente criação de `<iframe>`, montagem no DOM via `MutationObserver`, handshake `ready` e mensagens `result` vindas do sandbox, clicam em **Executar** em A, navegam pelo hash para B, liberam o módulo e comprovam `0` criações/montagens/execuções no iframe obsoleto; em seguida clicam em **Executar** em B e confirmam exatamente `1` despacho executando apenas o texto de B.
- **Antes do fix (`7348f02`):** falhou no Chrome real (`createIframeCount === 1`, com `results=[{"runId":"pg-1-...","logs":"TARGET_SNIPPET_B_RAN Ok(42)"}]` executado sem clique em B).
- **Após o fix:** `7/7` passaram em `pnpm run test:website` (`createIframeCount === 0` após troca de hash e `1` único despacho com B após clicar em Executar).

## Fechamento

- [x] Cada cenário tem um teste que falha com o código de `7348f02` e passa com o respectivo fix.
- [x] As mudanças de comportamento incluem os changesets dos pacotes afetados ([.changeset/fix-rfc-0010-0011-follow-up.md](../../.changeset/fix-rfc-0010-0011-follow-up.md) cobrindo `resultar`, `resultar-fastify` e `resultar-nestjs`).
- [x] Passaram `RESULTAR_JIT=1 pnpm run check:full`, `RESULTAR_JIT=0 pnpm run test`, `pnpm run build`, `pnpm run smoke:package`, `pnpm run test:examples`, `pnpm run test:docs`, `pnpm run test:agents`, `check:vscode`/`build:vscode`/`test:vscode` e `pnpm run test:website` com o bundle de produção e Chrome.
- [x] O registro desta revisão inclui o commit de base validado (`1b553ed` sobre `7348f02`), os resultados red-green dos três cenários (+ espelho em `resultar-nestjs`) e a nova medição de `TaggedError + catchTag`.
