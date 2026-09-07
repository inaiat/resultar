# RFC 0002: Lifetimes explícitos e escopos de requisição (resultar-di)

- Status: implementado no `resultar-di`; adapter Hono e cache concorrente continuam fora do pacote.
- Data: 2026-09-05.
- Contexto: migração do Replis e exemplo Hono em `examples/hono`.
- Referência: Awilix 13.0.5 instalado no Replis e documentação oficial consultada nesta data.

## Problema observado

O registro síncrono deve comunicar diretamente quanto tempo uma instância é compartilhada.
A API usa `singleton`, `scoped` e `transient`, cada um com nome, dependências e função de criação.
Scopes filhos compartilham os singletons da raiz; execuções de `module.use` criam raízes independentes.

Outro problema era exigir `ResultTask.runResult` em cada rota do exemplo. Os métodos agora retornam
`ResultAsync`, permitindo `await users.remove(id)`. Isso melhora a chamada HTTP, mas não cria um
escopo de DI nem cancelamento automático. São decisões independentes.

## Comparação com Awilix

| Funcionalidade Awilix                    | Situação no resultar-di                                           | Direção              |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------- |
| Valores, funções e classes               | `value`, `singleton`, `scoped`, `transient`; tokens via `Service` | Manter               |
| Singleton, scoped e transient            | Métodos síncronos dedicados; `lifetime` em `task` e `resource`    | Implementado         |
| Scopes filhos e registros locais         | `scope()` cria raiz; `scope.use()` cria filhos                    | Implementado         |
| Strict mode para lifetimes incompatíveis | Validação em runtime com lifetimes                                | Implementado         |
| Disposers                                | Recursos com finalização via ResultTask                           | Preservar            |
| `aliasTo`, `build`, `hasRegistration`    | Sem equivalentes dedicados                                        | Avaliar por uso real |
| `PROXY`, `CLASSIC`, injeções locais      | Lista explícita de dependências e closures                        | Manter explícito     |
| `loadModules`                            | Sem descoberta por arquivos                                       | Adiar                |

Essas funcionalidades estão descritas na [documentação do Awilix](https://github.com/jeffijoe/awilix#table-of-contents).
O [container](https://github.com/jeffijoe/awilix/blob/master/src/container.ts) mantém cache de singleton
na raiz e cache scoped por scope; transients não entram no cache. O dispose percorre o cache local
em paralelo e não fecha scopes filhos. No Resultar, manter finalização ordenada e causas compostas
continua sendo um requisito, inclusive para recursos transients.

## Separar as três escolhas

1. **Criação:** valor existente, função síncrona, inicialização task ou aquisição com release.
2. **Lifetime:** singleton da aplicação, scoped por operação/requisição, transient por resolução.
3. **Métodos:** `Result` síncrono, `ResultAsync` aguardável ou `ResultTask` lazy conforme o contrato.

Uma factory pode criar um singleton. Um resource também pode ser singleton ou scoped. `release`
não define quantas instâncias existirão; define como encerrar cada recurso adquirido.

`ResultTask` permanece lazy e não vira thenable. Serviços aguardáveis usam `ResultAsync`; operações
de I/O desses serviços devem propagar cancelamento explicitamente quando necessário. As rotas
aguardam operações antes de encerrar seu scope, sem disparar trabalho que fique sem dono.

## API implementada

Exemplo executável:

```ts
createModule()
  .resource("database", [], {
    lifetime: "singleton",
    acquire: connectDatabase,
    release: (database) => database.close(),
  })
  .singleton("cache", [], createCache)
  .scoped("users", ["database"], createUsersService)
  .transient("operation", [], createOperation);
```

Para serviços com dependências próprias, o token de classe elimina a repetição da lista de nomes:

```ts
interface UsersService {
  readonly find: (id: string) => ResultAsync<User, UserNotFoundError>;
}

class Users extends Service<UsersService>()("users", {
  make: ResultTask.gen(function* buildUsers() {
    const cache = yield* Cache;
    return createUsersService({ cache });
  }),
}) {}

createModule().singleton(Cache).scoped(Users);
```

`Service` preserva o identificador literal e o contrato do serviço. `yield* Cache` também aparece
no requisito de tipos do `make`; ao registrar `Users`, o resolver do módulo satisfaz esse requisito
por identificador, aplica a validação de lifetime e mantém a inferência do serviço disponível em
`use`. O método (`singleton`, `scoped` ou `transient`) continua sendo a única escolha de escopo.

`singleton`, `scoped` e `transient` escolhem o lifetime no próprio método, sem quarto argumento.
`task` e `resource` mantêm a opção `lifetime` e usam `scoped` por padrão. A função de criação
continua sendo uma factory; o método de registro comunica como sua instância será compartilhada.

Uma raiz de aplicação é aberta com `const application = module.scope()`. Cada
`application.use(...)` resolve um filho e o fecha ao terminar. O encerramento da raiz é explícito:
`await ResultTask.runPromise(application.close())`.

## Ownership e caches

- O módulo é uma descrição imutável. Cada execução de `module.use` cria seu próprio runtime raiz;
  o módulo não armazena instâncias singleton entre execuções.
- Singletons pertencem à raiz e são compartilhados entre suas requisições. Aquisição e finalização
  acontecem no scope da raiz, mesmo se a demanda vier de um filho.
- Cada scope filho recebe definições herdadas e um cache scoped próprio. Entradas locais tipadas,
  como usuário autenticado, tenant e requestId, ainda dependem de um adapter de framework.
- Transients são criados em cada resolução/injeção. Isso não significa uma nova instância em cada
  chamada de método. Cada aquisição com release pertence ao scope que a solicitou.
- `value` e substituições por valor continuam sendo referências externas, sem cleanup automático.
- Overrides de testes criam aplicações independentes. Overrides de requisição não podem alterar
  singletons já construídos nem contaminar o cache da raiz.
- Demandas concorrentes pelo mesmo singleton/scoped compartilham a aquisição em andamento.
  Falhas permitem retry; cancelar um consumidor não cancela a inicialização de outro.

## Validação de lifetimes

Adotar validação estrita por padrão: um singleton não captura scoped/transient e um scoped não
captura transient. A regra cobre cada par durante a resolução e falha com `Die(TypeError)` antes
de entregar o serviço incompatível.

As dependências e os nomes são validados durante a composição; os lifetimes são validados em
runtime para também proteger chamadas JavaScript. Isso impede que um singleton guarde o tenant da
primeira requisição. O [strict mode do Awilix](https://github.com/jeffijoe/awilix#strict-mode) orienta essa proteção.

## Integração Hono

Um adapter opcional mantém o runtime da aplicação e abre um filho por requisição. O caminho comum
da rota continua sendo `await users.remove(id)`, com contratos pequenos e tipados. A integração
não adiciona dependência obrigatória de Hono ao pacote base.

Fechar a raiz encerra seus recursos singleton. O adapter deverá parar de aceitar requisições e
aguardar os filhos antes de chamar `scope.close()`.
Para streaming/SSE, retornar um `Response` não significa que o uso dos recursos terminou: o scope
precisa acompanhar conclusão/cancelamento do corpo. Não implementar cleanup apenas no `finally`
de um middleware e declarar suporte a streaming sem validar esse comportamento.

## Critérios de entrega

- Duas requisições compartilham database singleton e recebem serviços scoped distintos. **Coberto pelo runtime.**
- Dentro de uma requisição, consumidores compartilham o mesmo scoped; transients são distintos. **Coberto pelo runtime.**
- Duas execuções da mesma aplicação não compartilham singleton por acidente. **Coberto pelo runtime.**
- Contextos de tenants diferentes não se misturam, mesmo com requisições concorrentes.
- Aquisição concorrente compartilha uma instância; falhas não deixam caches inutilizáveis.
- Falha parcial, erro da rota e interrupção liberam cada recurso exatamente uma vez.
- Um filho não encerra singleton da raiz. **Coberto pelo runtime.** O fechamento da raiz aguarda os filhos ativos.
- Testes de tipos preservam erros de aquisição/release, entradas locais e requisitos externos.

Aquisição concorrente compartilhada, retry, rollback parcial e espera pelos filhos estão implementados
e cobertos por testes de regressão.

O adapter Fetch foi implementado em `ServiceScope.fetch`, com testes de streaming, cancelamento,
falha do corpo, resposta vazia e falha do handler. O exemplo Hono usa um filho por request.
`withServices` fornece valores locais tipados e `merge` compõe módulos imutáveis sem colisões.
`service` e `resource` criam tokens sem classes; o método de registro escolhe o lifetime.
A inferência segue dependências selecionadas por até oito níveis; além disso usa uma união
conservadora para limitar o trabalho do compilador. `close` preserva erros de cleanup.
Aliases permanecem fora do escopo atual.
