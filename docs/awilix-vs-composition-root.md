# Awilix vs composition root Resultar

- Status: Note
- Data: 2026-09-05
- Escopo: DX de substituição de Awilix em consumidores Resultar
- Caso: `replis-api` (`createAppContainer` → `createAppServices`)

Revisão após RFC 0001: a substituição do container continua sem exigir API de DI. O lifecycle,
porém, é um caso concreto para `ResultTask.acquireRelease` + `scoped`, agora implementados como
recorte da Fase 3. O exemplo de lifecycle está em `examples/resultar/src/application-lifecycle.ts`;
a adoção pelos adapters reais do Replis ainda está pendente.

## Resumo

Awilix e Resultar resolvem problemas diferentes. Awilix é um container de DI. Resultar é o canal
de erro tipado. No `replis-api` o Awilix não injetava classes nem criava scope por request: ele
só montava factories singleton e chamava dois disposers.

A troca correta nesse grafo não é `ResultTask.service` em cada use case. É um composition root
explícito (`createAppServices`) que o Hono lê na borda HTTP. Resultar já cobria o restante
(`StrictResultAsync`, tagged errors, `safeTry`, `runPromise`).

Veredito depois da migração:

- caminho de produção: DX **melhor ou igual**;
- caminho de teste HTTP: DX **pior**, até estreitar o tipo que o Hono exige;
- Resultar **não** precisa de API nova para esta troca;
- não vale recriar Awilix, Layer ou lifetimes no core.

## O que o Awilix fazia no Replis

Três grupos de registro:

| Grupo | Exemplos | Papel |
| --- | --- | --- |
| Valores | `appConfig`, `logger` | `asValue` — já existiam fora do container |
| Infra | `surrealClient`, repos, jwt, hasher, S3, realtime, WhatsApp, schema | `asFunction(...).singleton()` |
| App | 12 use cases + helpers de boot | factories que liam o cradle via PROXY |

Os únicos ciclos de vida reais eram os disposers de `surrealClient` e `whatsAppClient`. Tudo o
mais era “chame a factory uma vez e cacheie”. As rotas não resolviam nada: faziam
`c.get("container").cradle.authUseCase.loginTenant(...)`. Os testes montavam um container mínimo
com `asValue`.

As factories já recebiam um objeto nomeado (`{ surrealClient }`, `ArenaUseCaseDependencies`). O
PROXY só preenchia essas chaves pelo nome do parâmetro.

## Comparativo de DX

| Tarefa | Awilix | Composition root |
| --- | --- | --- |
| Entender o grafo | Nomes no PROXY; a ordem é implícita | `createAppServices` mostra a ordem |
| Adicionar um singleton | `asFunction(createX).singleton()` e o nome do parâmetro tem que bater | Chamar a factory e devolver no objeto |
| Dependência faltando | Falha em runtime (`strict`) | Falha no compile na factory tipada |
| Rota HTTP | `c.get("container").cradle.authUseCase` | `c.get("app").authUseCase` |
| Dispose | `.disposer()` escondido | `services.dispose()` visível, em Resultar |
| Teste de rota | Mini-container + `asValue({} as never)` nos stubs | `as unknown as AppServices` |
| Auto-load de pastas | Disponível, não usado aqui | Não existe; o arquivo único basta |
| Lifetimes | `SINGLETON` / `SCOPED` / `TRANSIENT` | Tudo é singleton de processo; scope é o objeto passado na borda |

O Awilix ganhava cerimônia na hora de registrar o 21º serviço (uma linha). Em troca o TypeScript
não via o grafo, e um parâmetro com o nome errado só quebrava em runtime.

O composition root ganha grafo visível, dep faltando como erro de tipo, dispose Resultar e uma
dependência a menos. Adicionar o 21º serviço é uma linha a mais, explícita.

O que **não** mudou — e já era o DX Resultar:

- use cases devolvendo `StrictResultAsync`;
- tagged errors na borda HTTP;
- `sendResult` com `.match`;
- boot com `safeTry` / `tryResultAsync`.

## Onde o DX melhorou

### Grafo visível

`createAppServices` constrói na ordem: cliente Surreal, repositórios, jwt/hasher/storage,
realtime, schema, evento WhatsApp, cliente WhatsApp, use cases. Quem entra no arquivo vê o
acoplamento. No Awilix isso estava espalhado em nomes de registro.

### Dependência faltando é tipo

`createJwtService({ appConfig })` e `createHealthUseCase({ databaseHealthRepository })` já eram
tipados. Sem PROXY, a chamada no composition root é o ponto em que o compilador recusa um grafo
incompleto. O Awilix `strict` só reclamava ao resolver.

`arenaDeps` torna explícito o que o PROXY escondia: quase todos os use cases recebem o mesmo
bag `ArenaUseCaseDependencies`, não um construtor mínimo.

### Dispose alinhado ao resto do app

O shutdown deixa de ser `container.dispose()` genérico. `services.dispose()` fecha WhatsApp e
depois Surreal, os dois mesmo se o primeiro falhar, e devolve `StrictResultAsync<void, AppLifecycleError>`.

### Rotas um pouco mais curtas

```ts
c.get("container").cradle.authUseCase.loginTenant(body)
c.get("app").authUseCase.loginTenant(body)
```

O padrão continua um service locator no contexto Hono. Só perdeu um nível (`.cradle`).

## Onde o DX piorou

### Teste de rota perdeu o tipo

Este é o único regressão que deve ser tratada como problema, não como gosto:

```ts
const createTestApp = (
  healthUseCase: AppServices["healthUseCase"],
  logger: AppServices["logger"] = createAppLogger(),
): AppServices =>
  ({
    appConfig: loadAppConfig({}),
    healthUseCase,
    logger,
  }) as unknown as AppServices
```

O Awilix também pedia stubs (`as never` em `surrealClient` e afins), mas o que o teste
*registrava* continuava tipado. Agora o teste afirma que os serviços omitidos existem. O parâmetro
`healthUseCase` continua tipado: uma assinatura incompatível de `check` é rejeitada. A assertion
esconde a ausência dos outros serviços exigidos pela aplicação completa.

### O Hono carrega o processo inteiro

`createHonoApp(services: AppServices)` exige `surrealClient`, `schemaBootstrap`,
`connectSurrealClient` e `dispose`. Nenhuma rota usa isso. SSE só precisa de `realtimeEventBus`.
Auth só de `authUseCase` e `appConfig`. O cradle tinha o mesmo problema; a troca não corrigiu.

### Nome `app` colide com o Hono

`registerArenaTenantChatRoutes = (app) => { ... c.get("app") }` mistura o Hono app com o
composition root. `services` seria o nome certo da variável de contexto.

### A pasta ainda se chama `container`

Quem entra no repositório procura Awilix. O arquivo agora é `app-services.ts`.

## O que não deve ser feito

- Não voltar o Awilix. O composition root é o modelo certo para um grafo de singletons de
  processo.
- Não colocar `ResultTask.service` em cada use case agora. Os use cases já fecham sobre
  `arenaDeps` e devolvem `StrictResultAsync`. Tags não melhoram a rota HTTP.
- Não fazer auto-load de pasta. Um arquivo com ~20 factories é legível. Auto-wire por nome era a
  parte ruim do Awilix.
- Não adicionar `Layer`, lifetimes ou um runtime de scope no Resultar por causa deste app. O RFC
  0001 adia `Layer` até existir evidência de uso real. Dois disposers não são essa evidência.

`ResultTask.service` / `provideServices` / `runResult` já existem na 3.6 e bastam se um programa
quiser que o tipo impeça execução sem `Database` ou `Clock`. Isso é um segundo passo, não o
substituto do container HTTP.

## Melhorias recomendadas no consumidor

Ordem de valor:

1. **Superfície HTTP tipada**, sem o bag de infraestrutura.

   ```ts
   export type AppHttpServices = Pick<
     AppServices,
     | "appConfig"
     | "logger"
     | "authUseCase"
     | "healthUseCase"
     | "chatUseCase"
     | "realtimeEventBus"
     // só o que rota e middleware lêem
   >

   export const createHonoApp = (services: AppHttpServices): ReplisHonoApp => { /* ... */ }
   ```

   Esse `Pick` reduz o contrato, mas ainda exige todos os campos selecionados. Para testar apenas
   `/health`, extrair uma factory de rotas com dependências mínimas; testes da aplicação completa
   precisam de uma fixture completa e tipada de `AppHttpServices`.

2. **Factory de rota e fixture de teste** no lugar da assertion. Exemplo de API proposta para
   uma rota isolada, após extrair `createHealthRoutes`:

   ```ts
   createHealthRoutes({
     logger,
     healthUseCase: {
       check: () => okAsync({ database: "connected", status: "healthy" }),
     },
   })
   ```

3. **Rename mecânico:** pasta `container` → `composition` (ou `app-services.ts` na raiz de
   `infrastructure`), e `c.get("app")` → `c.get("services")`.

Opcional e de baixo valor: `const servicesOf = (c) => c.get("services")` nas rotas. O ruído hoje
é `c.get("app").chatUseCase`, não a falta de um DI.

## Implicações para o Resultar

Nenhuma API de DI é necessária para substituir Awilix neste formato. A melhoria de recursos é uma
frente distinta: `acquireRelease` + `scoped` preservam falhas de execução e release, conforme a
RFC 0001. A ordem HTTP → WhatsApp → banco e o controle de tarefas de restauração continuam sendo
responsabilidade da composição da aplicação; o recorte atual ainda não implementa fibers.

O que o core já oferece e o consumidor deve usar:

- `Result` / `StrictResult` para validação e regras puras;
- `ResultAsync` / `StrictResultAsync` para I/O e use cases que já fecham sobre deps;
- `createTaggedError` na borda;
- `tryResultAsync` / `safeTry` no boot e no dispose;
- `ResultTask` só quando o programa precisa declarar requisitos `R` e recebê-los na execução.

O que continua de fora do core, de propósito:

- container global;
- auto-wire por nome de parâmetro;
- lifetimes;
- `Layer`.

A evidência deste consumidor confirma a decisão do RFC 0001: tokens de serviço leves no
`ResultTask`, composition root na aplicação, sem DI runtime.

## Conclusão

Para escrever feature de domínio, o DX está melhor: grafo visível, dep faltando é tipo, dispose é
Resultar, uma dependência a menos.

Para escrever teste HTTP, o DX está pior até estreitar o tipo do Hono. Sem isso, a troca ficou
correta na arquitetura e frouxa na borda de teste — o mesmo service locator de antes, com um
cast mais feio.

Melhorar (1) e (2) no consumidor. O rename é higiene. O resto do Awilix não faz falta neste
projeto, e não deve ser reintroduzido no Resultar.
