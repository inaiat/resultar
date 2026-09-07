# Plano: resultar-hono

Status: API inicial implementada em `packages/hono`, com exemplo em `examples/hono`.
O texto abaixo registra o plano original; a referência de uso atual é o [README do pacote](../packages/hono/README.md).
A migração do Replis e a validação de Bun não fazem parte desta entrega.

## Objetivo e limites

Reduzir a integração repetitiva entre Hono e resultar-di: inferir os serviços disponíveis nos
handlers, manter uma raiz por aplicação e um scope por resposta, e expor fechamento explícito.
O pacote será `resultar-hono`, em `packages/hono`, com um único entry point.
Não haverá `/node`, `/bun` ou `/deno`, abertura de portas, listeners de sinais ou abstração de servidor.

`resultar` mantém tarefas e finalização; `resultar-di` mantém resolução, lifetimes e o adapter Fetch;
`resultar-hono` conecta esse adapter ao Hono. Não copiar `runScopedResponse` para o novo pacote.
Usar Hono como peer dependency, respeitando as versões efetivamente verificadas nos testes.
A ausência de imports Node é um requisito; suporte declarado a runtimes depende de execução dos testes.

## API proposta

```ts
createHonoApp({ services, bindings }, (app) => {
  // app é uma instância real de Hono, com bindings inferidos.
  app.get(...);
});
```

O resultado é uma aplicação com:

- `fetch(request): Promise<Response>`: ponto de entrada para o servidor.
- `request(input, init?): Promise<Response>`: conveniência para testes, passando pelo mesmo scope.
- `close(): Promise<Result<void, CloseError>>`: fecha a raiz e preserva falhas de cleanup.

`CloseError` acima é uma variável de tipo derivada dos finalizers do módulo, não um novo erro genérico.
Se a tipagem atual de `scope.close()` não permitir preservar esse canal no wrapper, resolver isso
antes de estabilizar a assinatura; não substituir por `any` ou descartar a falha.
A API assíncrona pode ser usada com `await`, sem exigir `runResult` no bootstrap do consumidor.

O callback configura um Hono comum uma única vez. Isso evita duplicar todos os métodos do Hono
em um builder próprio ou alterar seu método fetch. O wrapper fornece o único ponto de execução
público, para impedir que uma chamada de teste contorne os scopes acidentalmente.
Registrar o módulo não instancia seus serviços. A raiz será criada após a configuração das rotas;
a inicialização dos providers continua sob demanda.

## Exemplo proposto

Reutilizando `createServices` do exemplo atual, com Cache singleton e Users/Health scoped:

```ts
// app.ts — proposta, ainda não executável até existir resultar-hono.
import { createHonoApp } from "resultar-hono";
import { createServices } from "./services-module.js";

export const createApplication = (services = createServices()) =>
  createHonoApp({ services, bindings: ["health", "users"] }, (app) => {
    app.get("/health", async (c) => {
      const result = await c.env.health.check();
      return result.match(
        (health) => c.json(health),
        () => c.json({ error: "Health unavailable" }, 503),
      );
    });

    app.delete("/users/:id", async (c) => {
      const result = await c.env.users.remove(c.req.param("id"));
      return result.match(
        () => c.body(null, 204),
        () => c.json({ error: "User not found" }, 404),
      );
    });
  });
```

Sem escrever `Hono<{ Bindings: ... }>` nem repetir os contratos dos serviços. Uma chave inválida
em `bindings` ou um acesso a um serviço não selecionado deve falhar no TypeScript.
`services-module.ts` conterá apenas a composição já existente; não haverá tokens App/Server
para ligar o router aos bindings.

```ts
// Teste da aplicação — proposta.
const app = createApplication();
try {
  const health = await app.request("/health");
  console.log(await health.json()); // Consumir o corpo também conclui o scope da resposta.

  const removed = await app.request("/users/1", { method: "DELETE" });
  console.log(removed.status); // 204: resposta sem corpo, scope já finalizado.
} finally {
  const closed = await app.close();
  closed.match(
    () => console.log("Recursos liberados"),
    (error) => console.error("Falha no encerramento", error),
  );
}
```

O servidor escolhido pelo consumidor recebe `app.fetch`. O ciclo de encerramento continua no
bootstrap: parar novas conexões, drenar ou cancelar respostas ativas e aguardar `app.close()`.
Não fechar a aplicação logo após chamar a função que começa a escutar a porta.
O exemplo Node conservará seu adaptador de servidor e tratamento de sinais fora do pacote.

## Semântica e decisões

1. Um router e uma raiz DI por aplicação; um scope filho por resposta. `request` e `fetch`
   percorrem exatamente a mesma integração, incluindo overrides e finalização.
2. O scope permanece vivo até consumo, cancelamento ou falha do corpo. Um middleware com
   `finally` depois de `await next()` não basta para streaming. Reutilizar `ServiceScope.fetch`.
3. `close` é idempotente, aguarda os consumidores conforme o contrato do DI e rejeita novas
   execuções após fechamento. Respostas sem consumo podem impedir o encerramento: o consumidor
   precisa consumir/cancelar os corpos, ou interromper a requisição.
4. Erros de domínio continuam em `result.match` no handler. `app.onError` trata erros que chegam
   ao Hono. Falhas de resolução anteriores ao router continuam rejeitando `fetch` com sua causa;
   erros de cleanup posteriores aos headers afetam o stream, sem tentar trocar seu status HTTP.
   Não criar mapeamento automático de erros de domínio para status.
5. Dependências externas não satisfeitas devem impedir a construção do adapter por tipos,
   conforme o contrato do DI. Valores específicos de requisição, como tenant autenticado,
   não serão inferidos de headers ou de middleware: isso exige uma API própria posterior.
6. V1 recebe somente Request e usa `c.env` para serviços selecionados. Bindings nativos externos,
   ExecutionContext/waitUntil, WebSocket e Hono RPC não são garantidos por esta primeira API.
   Não anunciar substituição completa de `Hono.fetch(request, env, executionCtx)`.
   Se esses usos forem necessários no Replis, revisar o contrato antes de migrá-los.
7. Os serviços selecionados são resolvidos para cada requisição, inclusive 404. Não prometer
   resolução por rota; selecionar por rota é trabalho futuro, apenas se houver necessidade real.

## Etapas de implementação

1. Provar os tipos com o módulo atual: inferência de bindings, preservação de erros de fechamento,
   rejeição de dependências externas ausentes, overrides e módulos combinados. Extrair helpers de
   tipos públicos do DI apenas se necessário, sem expor Graph ou detalhes do runtime ao consumidor.
2. Criar `packages/hono` com manifesto, exports ESM, build, README e dependências seguindo o
   padrão dos pacotes existentes. Implementar configuração do router, delegação para `scope.fetch`,
   conveniência request e fechamento com resultado tipado.
3. Verificar sucesso, 404, falhas de provider e handler, resposta sem corpo, streaming, cancelamento,
   abort, cleanup com falha, concorrência, fechamento repetido e chamadas após close. Comparar
   instâncias para provar singleton compartilhado e scoped isolado entre requisições.
4. Migrar o exemplo DI, preservando as rotas e o adaptador Node, removendo a ligação manual
   `services.http(...router.fetch...)` e os tokens que existiam apenas para essa ligação.
   Validar as requisições reais, interrupção e rollback de startup já cobertos pelo exemplo.
5. Validar o Replis com link local e executar check/build/testes antes de decidir migrá-lo.
   Conferir os bindings já usados, streaming e a ordem de fechamento do servidor e da raiz.
6. Verificar o pacote empacotado em consumidor isolado e executar a suíte Fetch nos runtimes
   disponíveis. Documentar explicitamente os ambientes ainda não verificados.

## Critérios de conclusão

O exemplo deve declarar DI e rotas sem repetir os tipos dos bindings, sem montar manualmente um
adapter Fetch e sem tokens artificiais para router/servidor. O bootstrap deve continuar mostrando
quem fecha a aplicação. Testes devem demonstrar que essa redução de código preserva isolamento,
streaming e finalização. Não criar outra API de rotas, runtime de DI ou adaptador de servidor.

## Referências

- [Hono App: fetch e request](https://hono.dev/docs/api/hono)
- [Hono Context: bindings e env](https://hono.dev/docs/api/context)
- [DI e integração Fetch existentes](../packages/di/README.md)
- [Implementação do ciclo de resposta](../packages/di/src/fetch.ts)
