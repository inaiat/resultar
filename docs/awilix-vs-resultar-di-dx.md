# Revisão de DX: Awilix e resultar-di

Data: 2026-09-05. Escopo: implementação local após introduzir Service e registros por classe.

## Veredito

O resultar-di tem uma boa direção de API, mas ainda não supera o Awilix no conjunto.
Os métodos de lifetime são claros; dependências com yield* têm navegação de símbolos no editor.
O custo total de criar um serviço ainda inclui contrato, token, make e adaptação da factory.
Além disso, há falhas demonstráveis de tipos, ownership e concorrência.

A afirmação anterior de que os checks e smokes passavam era correta, mas esses testes não
demonstravam todas as garantias anunciadas. Passar os testes existentes não basta para declarar
o runtime pronto.

## Referência de comparação

Foi inspecionado main:replis-api/src/infrastructure/container/app-container.ts no repositório
local do Replis. Ele já usa InferCradleFromResolvers, PROXY, strict, factories singleton e
disposers. Portanto, inferir os tipos dos serviços registrados não é uma vantagem exclusiva nossa.

O Awilix documenta funções e classes comuns, scopes com registros locais, injeções locais,
aliases e inferência do cradle. Esses recursos reduzem o custo de adoção de código existente.
Fonte: [documentação oficial](https://github.com/jeffijoe/awilix#readme).

Sua implementação também verifica ciclos e mantém a pilha de resolução para erros de dependência
e lifetime. Fonte: [container.ts](https://github.com/jeffijoe/awilix/blob/master/src/container.ts).

## Comparação prática

| Situação | Avaliação do resultar-di |
| --- | --- |
| Ler o lifetime no registro | Bom: singleton(Token), scoped(Token), transient(Token). |
| Identificar dependências no serviço | Bom: yield* Token oferece referência direta ao símbolo. |
| Adicionar uma factory já existente | Mais cerimônia: lista explícita ou wrapper Service com make. |
| Separar contrato e implementação | Possível, mas o token atual junta contrato e implementação padrão. |
| Testar com mocks | override por nome é tipado, mas ainda falta uso consistente de tokens. |
| Executar serviço numa rota | await users.remove(id) é simples, mas vem de ResultAsync e também funciona com outro DI. |
| Abrir scope por request | Falta adapter e API para valores locais de tenant/requestId/usuário. |
| Garantir singleton e cleanup | Ainda insuficiente: reproduções abaixo. |
| Inspecionar erros no grafo | Faltam erros específicos, caminho de resolução e detecção de ciclos. |
| Validar requisitos antes de executar | Parcial: a remoção atual compara nomes sem validar contratos. |

## Problemas reproduzidos

Foi executado um fixture temporário com imports do código local de DI e do build atual do core.
O fixture completo passou com TypeScript strict, sem casts para esconder erros de tipos.
Os resultados abaixo são de execução real; não foram inferidos apenas pela leitura.

### P1 — Nome igual pode satisfazer contrato incompatível

Se Cache exige read(): string e Users faz yield* Cache, isto compila:

    createModule().value("cache", 123).scoped(Users)

A chamada do método termina em TypeError: cache.read is not a function.
RegisteredServiceRequirements remove a tag verificando apenas o identificador.
Correção necessária: conferir o contrato e a identidade escolhida para tokens, incluindo
registros por valor, overrides e composição de módulos.

Local: packages/di/src/module.ts, RegisteredServiceRequirements e registro de classes.

### P1 — use remove requisito sem fornecer o serviço ao callback

Isto compila sem exigir services na execução:

    createModule().singleton(Cache).use([], () =>
      ResultTask.gen(function* () {
        return (yield* Cache).read()
      })
    )

Resultado: MissingServiceError: Missing ResultTask service: cache.
O resolver só envolve make do token; o callback de use não recebe esse contexto.
Correção necessária: fornecer os requisitos prometidos ou mantê-los no tipo do callback.
A mesma análise deve cobrir task, resource e finalizers, não apenas registros de classe.

Local: packages/di/src/module.ts, UseTask e makeScope.

### P1 — Singleton com acquireRelease é encerrado pelo primeiro filho

Foi registrado um Database singleton cujo make usa ResultTask.acquireRelease.
O release muda open para false.

Resultado observado:

    primeiro use: open=true; releases após terminar=1
    segundo use: open=false; releases=1

A instância fica no cache da raiz, mas o finalizer pertence ao scope de execução do primeiro uso.
Correção necessária: unificar o dono do cache e dos finalizers. A restrição documental de usar
resource separado não protege uma API que aceita esse make sem erro.

Local: packages/di/src/module.ts, RuntimeScope.resolve e registerLifetime.

### P1 — Demandas concorrentes criam dois singletons

Dois runPromise executaram scope.use simultaneamente sobre o mesmo root e token assíncrono.

Resultado observado:

    IDs retornados=[1, 2]; construções=2

O cache só é preenchido após a criação. Isso também expõe factories síncronas ao intervalo
assíncrono da resolução de tasks.
Correção necessária: compartilhar inicialização em andamento, definir retry após falha e
cancelamento dos consumidores, e testar shutdown durante aquisição.

Local: packages/di/src/module.ts, RuntimeScope.resolve.

### P1 — Resolver apaga erros e requisitos próprios

Um resolver que retorna ResultTask.fail("resolver-failure") produz um workflow atribuível a:

    ResultTask<string, never, never>

Resultado real: Failure(Fail("resolver-failure")).
provideServiceResolver preserva E da task original e ignora E/R da task retornada pelo resolver.
Correção necessária: preservar erros, requisitos e releases do resolver, e validar o valor
devolvido para cada tag. A API pública atual aceita valores sem relação com o contrato pedido.

Local: packages/resultar/src/result-task.ts, ResultTaskServiceResolver e provideServiceResolver.

### P1 — Defeito durante release interrompe os finalizers restantes

Dois resources foram adquiridos. O release do segundo retorna ResultTask.sync que lança Error.

Resultado observado:

    eventos=["second release"]

O release do primeiro não executa. RuntimeScope.close usa catchAll, que não captura Die.
Correção necessária: drenar todos os finalizers preservando Fail/Die/Interrupt e causas compostas,
usando a semântica do core. Capturar apenas a criação da task de release não resolve.

Local: packages/di/src/module.ts, RuntimeScope.close.

## Outras lacunas identificadas por inspeção

- RuntimeScope.resolve não mantém caminho de resolução nem detecta ciclos. Os tokens agora
  permitem grafos que não dependem da ordem de registro, tornando essa proteção necessária.
- close altera o estado do root e retira finalizers ao construir a task, antes de executá-la.
  Isso contraria a expectativa de laziness e merece teste específico.
- ServiceClass declara new() retornando o contrato, mas ServiceBase só possui membros estáticos.
  A API deve distinguir um token de uma classe de implementação; o construtor atual promete mais
  do que entrega.
- O exemplo Hono abre um filho para a vida do servidor. Ele demonstra scopes, mas não isolamento
  por request. O adapter precisa cobrir tenant, concorrência, erros e conclusão/cancelamento de SSE.
- A união de requisitos e erros é conservadora para o módulo inteiro. Um grafo pequeno selecionado
  pode exigir ambientes de serviços não utilizados, dificultando testes isolados.

## Ordem recomendada para superar a DX atual

1. Corrigir os seis casos reproduzidos e adicionar regressões de tipos e runtime.
2. Tornar tokens consistentes em registro, seleção, override e valores fornecidos externamente.
   Escolher uma política explícita de identidade; nomes iguais não devem esconder contratos errados.
3. Reduzir cerimônia: inferir o contrato a partir de make para serviços simples e oferecer um caminho
   curto para factories existentes. Manter contrato explícito quando ele ajuda mocks e implementações.
   Classes devem ser uma opção, sem exigir classe vazia em todo serviço.
4. Adicionar erros com o caminho de dependências e validação de ciclos. Não prometer inspeção
   completa de um grafo dinâmico de generators sem executar o código ou produzir metadados.
5. Criar adapter Hono com scope por request e entradas locais tipadas; adaptar ResultAsync na borda
   preservando await no método de domínio.
6. Adicionar composição de módulos e testes de inferência em grafos maiores. Avaliar aliases depois
   que uma aplicação demonstrar necessidade.

Exemplo de direção proposta, ainda não implementada:

    const root = createModule().singleton(Cache).scoped(Users).scope()
    const result = await root.use(Users, users => users.find("1"))
    const testing = module.override(Users, fakeUsers)

Esse formato exigiria seleção por token e suporte explícito a ResultAsync no callback e na borda
de execução. Não basta tornar o callback async; seu scope deve durar até a operação terminar.

## Critério de sucesso

Superar a DX significa adicionar um serviço com pouco código, receber erros úteis antes da
produção e confiar que o lifetime declarado corresponde ao comportamento real.
O próximo investimento deve ser a correção dessas garantias, seguido de menos cerimônia e
integração por request. O registro mais curto, sozinho, não demonstra superioridade.
