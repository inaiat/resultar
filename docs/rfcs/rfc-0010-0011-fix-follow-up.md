# RFCs 0010 e 0011 — correções após a segunda revisão

**Status em 20/11/2026 — três pendências abertas.** O commit `7348f02` implementou as correções da primeira revisão na branch `feat/dx-docs-observability-tooling`. Os testes passaram, inclusive com JIT ligado e desligado e com o playground no Chrome. A segunda revisão identificou os três casos abaixo. A recomendação é manter o merge bloqueado até verificar os respectivos critérios de aceite. [Plano da primeira revisão](./rfc-0010-0011-fix-plan.md)

## P1 · Fastify aguarda indefinidamente após desconexão durante streaming

**Reprodução confirmada.** Um cliente enviou todo o corpo de um POST, recebeu o primeiro trecho da resposta e fechou a conexão enquanto o servidor ainda transmitia. Nesse ponto, `request.raw.complete` era verdadeiro e `request.raw.aborted` era falso. O fechamento da resposta deixou o contador incrementado por `beginChild()` sem o `endChild()` correspondente. Na mesma reprodução, `app.close()` concluiu em `cacb729` e ficou pendente com os hooks rápidos. [Hooks do Fastify](../../packages/fastify/src/fast-hooks.ts)

**Correção proposta.** Ao ativar uma requisição no caminho rápido, observar também o evento `close` de `reply.raw`. Encaminhar o fechamento prematuro, a resposta normal e o aborto para a mesma finalização idempotente. Remover o listener ao finalizar e garantir exatamente um `endChild()` por `beginChild()`, tanto para bindings estáticos quanto para resolução com locais por requisição.

**Teste de aceite.** Usar um servidor em porta efêmera e um cliente HTTP real. Sincronizar o cancelamento com a leitura do primeiro trecho de uma resposta que permanece aberta. Aguardar o fechamento do socket e exigir que `app.close()` conclua dentro do timeout do teste. Manter outra requisição ativa durante o cancelamento e verificar que o recurso singleton só é liberado, uma única vez, após o término dela. Executar para os dois caminhos rápidos e nos dois modos de JIT. [Testes de ciclo de vida](../../packages/fastify/tests/jit.test.ts)

## P1 · A cópia de um erro perde o discriminador e os metadados

**Reprodução confirmada.** Para uma classe criada com `createTaggedError({ name: 'Missing' })`, `Object.keys(new Missing())` devolvia `_tag`, `fingerprint`, `messageTemplate` e `name` em `cacb729`. Com os campos no protótipo, a lista passou a ser vazia e `{ ...error }` perdeu os quatro campos. Isso afeta, por exemplo, um consumidor que copia o erro antes de despachá-lo pelo discriminador. A seção 4.2 da RFC exige que `fingerprint` seja uma propriedade própria e enumerável. [Implementação](../../packages/resultar/src/tagged/tagged-error.ts) · [RFC 0011](./rfc-0011-jit-compilation-and-runtime-performance.md#42-constructor-allocation-elimination)

**Correção proposta.** Restaurar a inicialização dos campos na instância com os descritores de `cacb729`. A tupla congelada de `fingerprint` pode continuar compartilhada entre as instâncias da classe. Preservar o tratamento de `cause`, os metadados fornecidos pelo consumidor e o suporte a uma classe de erro base personalizada.

**Teste de aceite.** Para as quatro propriedades, conferir `Object.hasOwn`, os descritores, `Object.keys` e os valores copiados por spread. Exercitar uma classe padrão e outra com base personalizada. Conferir também o contrato de `toJSON()` e a identidade da tupla entre duas instâncias. Após o fix, repetir o cenário de desempenho `TaggedError + catchTag` e registrar o resultado junto à meta da RFC. [Testes de erros](../../packages/resultar/tests/tagged-error.test.ts)

## P2 · O playground pode executar um snippet diferente do selecionado

**Condição identificada na leitura do código.** Na primeira execução, o clique em **Executar** inicia o carregamento assíncrono do runner. O código consulta `state.playgroundCode` depois desse carregamento. Se o usuário trocar do snippet A para um link compartilhado B nesse intervalo, o runner pode receber B. A verificação de sequência ocorre após o despacho ao iframe e só descarta a saída. [Fluxo de execução](../../website/src/main.ts)

**Correção proposta.** Capturar o texto do editor no clique, antes do primeiro `await`. Assim que o import resolver, verificar se a execução ainda é a atual e só então despachar o texto capturado. Manter a verificação após o retorno do runner para que uma resposta antiga também não substitua a saída atual.

**Teste de aceite.** No Chrome, atrasar de forma controlada o carregamento inicial do módulo do runner, clicar em **Executar** em A, navegar pelo hash para B e liberar o carregamento. Observar o despacho ao iframe e verificar que a execução obsoleta foi cancelada. A ausência de saída no painel, sozinha, também ocorreria com o bug. Em seguida, clicar em **Executar** em B e confirmar um único despacho com o texto de B. [Testes do playground no navegador](../../website/tests/playground-browser.test.ts)

## Fechamento

- [ ] Cada cenário tem um teste que falha com o código de `7348f02` e passa com o respectivo fix.
- [ ] As mudanças de comportamento incluem os changesets dos pacotes afetados.
- [ ] Passaram `RESULTAR_JIT=1 pnpm run check:full`, `RESULTAR_JIT=0 pnpm run test` e `pnpm run test:website` com o bundle de produção e Chrome.
- [ ] O registro desta revisão inclui o commit validado, os resultados dos três cenários e a nova medição de `TaggedError + catchTag`.
