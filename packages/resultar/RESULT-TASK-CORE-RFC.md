# RFC 0001: ResultTask e a próxima arquitetura do core

- Status: Draft
- Data: 2026-09-01
- Escopo: pacote `resultar`
- Compatibilidade pretendida: evolução incremental antes de uma eventual major

## Resumo

Este RFC propõe separar os três conceitos que hoje estão parcialmente sobrepostos no core:

```ts
Result<A, E> // resultado síncrono já calculado
ResultTask<A, E, R> // descrição lazy de um programa
ResultAsync<A, E> // PromiseLike<Result<A, E>> para compatibilidade
```

`Result` continua sendo o tipo de dado pequeno e direto que identifica o projeto. A nova abstração
`ResultTask` passa a concentrar execução assíncrona, cancelamento, concorrência, retry, timeout,
recursos e dependências. `ResultAsync` permanece disponível durante a migração e pode, com o tempo,
ser implementado como uma fachada de execução de `ResultTask`.

A inspiração principal vem do Effect v4: programas são valores lazy; execução pertence a um
runtime; recursos vivem em escopos; concorrência é estruturada; dependências são explícitas; e a
ergonomia de `yield*` não implica que tipos distintos sejam estruturalmente intercambiáveis.

O objetivo não é transformar Resultar em uma implementação reduzida do Effect. O objetivo é adotar
as ideias que resolvem limitações concretas do core atual sem perder a API simples de Resultar.

## Motivação

Hoje `ResultAsync<A, E>` armazena diretamente uma `Promise<Result<A, E>>`. Em muitos construtores a
Promise começa a executar antes de qualquer chamada explícita de runtime. Os combinadores são
implementados encadeando `then`, `catch`, `Promise.all` e controladores de abort locais.

Esse modelo funciona bem para composição simples, mas cria limites conforme o pacote ganha
operações de produção:

- uma instância não representa um programa reutilizável, mas uma execução já iniciada;
- cancelamento é cooperativo e específico de cada helper;
- `race`, `timeout`, retry, callbacks e recursos têm protocolos próprios;
- não existe um escopo único que conheça todos os finalizers e tarefas filhas;
- não existe um ponto central para clock, scheduler, logs, métricas ou tracing;
- falha esperada, interrupção e defeito de implementação não têm uma representação comum;
- `Result` e `ResultAsync` repetem uma parte relevante de tipos e combinadores;
- o arquivo assíncrono concentra modelo, execução, concorrência, resource safety e API pública.

Adicionar mais helpers diretamente a `ResultAsync` aumenta essa complexidade sem resolver a causa:
a Promise é simultaneamente a descrição e a execução.

## Objetivos

1. Preservar `Result<A, E>` como valor explícito, pequeno e independente de runtime.
2. Introduzir uma representação lazy para workflows síncronos e assíncronos.
3. Tornar cancelamento, timeout, concorrência e cleanup propriedades do runtime.
4. Permitir dependências tipadas sem exigir um container de DI global.
5. Manter falhas esperadas no canal `E` e distinguir interrupções e defeitos.
6. Manter `yield*` como uma ergonomia segura para código linear.
7. Migrar sem quebrar imediatamente usuários de `ResultAsync`.
8. Reduzir duplicação e tornar o core internamente modular.

## Não objetivos

- Implementar `Stream`, STM, cache, cluster, RPC ou uma plataforma completa.
- Reproduzir toda a API do Effect.
- Exigir serviços/contexto para usos simples.
- Adicionar um runtime global implícito.
- Remover `ResultAsync` na primeira entrega.
- Mudar o significado de `Ok`, `Err` ou dos tagged errors existentes.
- Capturar automaticamente bugs de programação como falhas esperadas em `E`.

## Princípios de desenho

### Result é dado; ResultTask é programa

Construir um `Result` calcula ou recebe um valor imediatamente. Construir um `ResultTask` apenas
descreve trabalho. O trabalho começa somente em uma operação explícita de execução.

```ts
const result = parsePort(input)
// parsePort já executou

const task = ResultTask.tryPromise({
  try: () => fetchUser(id),
  catch: (cause) => new FetchUserError({ cause }),
})
// fetchUser ainda não executou

const resolved = await ResultTask.runResult(task)
```

### O caminho simples continua simples

Nenhum serviço ou runtime customizado deve ser necessário para:

```ts
const task = ResultTask.succeed(1).map((value) => value + 1)
const result = await ResultTask.runResult(task)
```

### Políticas são valores

Retry, backoff, jitter e repetição devem ser descritos por valores reutilizáveis em vez de grandes
objetos de opções acoplados a uma única operação.

### Recursos pertencem a escopos

Aquisição e release devem ser registrados no mesmo contexto de execução. O runtime deve executar
finalizers em sucesso, falha, defeito, interrupção ou timeout.

### Tipos diferentes continuam diferentes

`Result`, `ResultAsync`, `ResultTask`, `Fiber` e referências de serviço podem suportar `yield*`, mas
não devem ser estruturalmente aceitos como se fossem o mesmo tipo. Cada conversão fora de um
generator deve ser explícita.

## API pública proposta

Os nomes abaixo são uma direção de API, não uma lista congelada para a primeira implementação.

### Modelo

```ts
declare const ResultTaskTypeId: unique symbol

export interface ResultTask<out A, out E = never, out R = never> extends Pipeable {
  readonly [ResultTaskTypeId]: {
    readonly success: (_: never) => A
    readonly error: (_: never) => E
    readonly requirements: (_: never) => R
  }

  [Symbol.iterator](): ResultTaskIterator<ResultTask<A, E, R>>
}
```

`A` é o valor de sucesso, `E` é uma falha esperada e `R` representa requisitos da execução.

O construtor real e a função interna de execução não fazem parte da interface pública. Isso permite
alterar a representação do programa sem quebrar consumidores.

### Construtores mínimos

```ts
ResultTask.succeed<A>(value: A): ResultTask<A>
ResultTask.fail<E>(error: E): ResultTask<never, E>
ResultTask.fromResult<A, E>(result: Result<A, E>): ResultTask<A, E>
ResultTask.sync<A>(evaluate: () => A): ResultTask<A>

ResultTask.try<A, E>(options: {
  readonly try: () => A
  readonly catch: (cause: unknown) => E
}): ResultTask<A, E>

ResultTask.tryPromise<A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>
  readonly catch: (cause: unknown) => E
}): ResultTask<A, E>
```

`sync` é usado para computações que não devem lançar. Se lançar, isso é um defeito. `try` e
`tryPromise` são boundaries explícitos que convertem causas externas para `E`.

### Composição

```ts
ResultTask.map(task, f)
ResultTask.mapError(task, f)
ResultTask.flatMap(task, f)
ResultTask.andThen(task, f) // alias orientado à API atual
ResultTask.catchAll(task, f)
ResultTask.catchTag(task, tag, f)
ResultTask.tap(task, f)
ResultTask.tapError(task, f)
ResultTask.match(task, handlers)
ResultTask.as(task, value)
```

A API deve suportar `pipe`. Métodos de instância podem existir por ergonomia, mas a implementação
canônica deve viver em funções de módulo para reduzir duplicação e facilitar tree shaking.

### Generator

```ts
const createAccount = (input: Input) =>
  ResultTask.gen(function* () {
    const email = yield* validateEmail(input.email)
    const users = yield* Users
    const account = yield* users.create(email)
    yield* Audit.record({ type: 'AccountCreated', accountId: account.id })
    return account
  })
```

O retorno normal do generator deve ser o valor `A`, não `ok(A)`. Falhas produzidas por tasks
interrompem o generator e são acumuladas no tipo `E`.

Compatibilidade com o estilo atual pode ser oferecida durante a migração, mas a forma acima deve ser
a API recomendada para `ResultTask.gen`.

Para manter a mesma linguagem entre os modelos eager e lazy, `Result.gen` é um alias exato de
`safeTry`. O nome legado continua disponível, mas novos exemplos de workflows `Result` podem usar
`Result.gen` ao lado de `ResultTask.gen`. A semântica permanece diferente: `Result.gen` executa o
generator imediatamente e retorna `Result` ou `ResultAsync`, enquanto `ResultTask.gen` cria uma
descrição lazy e retorna o valor de sucesso quando executada.

### Execução

```ts
ResultTask.runResult(task): Promise<Result<A, E>>
ResultTask.runResult(task, { services, signal }): Promise<Result<A, E>>
ResultTask.runExit(task): Promise<Exit<A, E>>
ResultTask.runPromise(task): Promise<A>
ResultTask.runFork(task): Fiber<A, E>
```

Sem requisitos `R`, `services` é opcional. Se `R` não for `never`, TypeScript deve exigir os serviços
restantes.

`runResult` é o boundary padrão de Resultar. `runPromise` rejeita em `Err`, interrupção ou defeito e
é destinado a integração com APIs Promise. `runExit` preserva toda a informação da execução.

### Serviços e contexto

A primeira versão deve usar tokens leves, sem um sistema de Layer completo:

```ts
interface ServiceTag<Identifier, Service> {
  readonly key: symbol
  readonly identifier: Identifier
}

const Database = ResultTask.service<Database, 'Database'>('Database')

const program: ResultTask<User, DatabaseError, typeof Database> = ResultTask.gen(function* () {
  const database = yield* Database
  return yield* database.findUser('u1')
})

const runnable = ResultTask.provideService(program, Database, databaseLive)
```

Requisitos devem compor sem criar dependência de um singleton global. Uma API de `Layer` só deve
ser considerada depois que casos reais demonstrarem a necessidade de construir grafos de serviços
com ciclo de vida próprio.

### Scope e recursos

```ts
const connection = ResultTask.acquireRelease({
  acquire: ResultTask.tryPromise({
    try: () => pool.connect(),
    catch: (cause) => new ConnectionError({ cause }),
  }),
  release: (connection, exit) => ResultTask.sync(() => connection.release(exit)),
})

const query = ResultTask.scoped(
  ResultTask.gen(function* () {
    const db = yield* connection
    return yield* db.query(sql)
  }),
)
```

Regras:

- finalizers executam em ordem LIFO;
- cada finalizer executa no máximo uma vez;
- interrupção não deve impedir cleanup;
- o `Exit` da região fica disponível ao finalizer;
- falha no release não deve ser silenciosamente descartada em `runExit`;
- `runResult` deve aplicar uma política documentada quando use e release falham juntos.

### Schedule

```ts
const policy = Schedule.exponentialBackoff(100).jittered().compose(Schedule.recurs(4))

const resilient = ResultTask.retry(loadUser, policy)
```

Entrega mínima:

```ts
Schedule.recurs(times)
Schedule.spaced(duration)
Schedule.exponentialBackoff(base)
Schedule.jittered(schedule)
Schedule.whileInput(schedule, predicate)
```

`Clock` deve ser injetável pelo runtime para que retry e timeout sejam determinísticos em testes.

### Concorrência estruturada

```ts
const fiber = yield * ResultTask.forkChild(task)
const value = yield * Fiber.join(fiber)
yield * Fiber.interrupt(fiber)
```

Regras:

- fibers filhas pertencem ao scope pai;
- encerrar o scope interrompe filhos ainda ativos;
- `race` interrompe perdedores e aguarda seus finalizers;
- `timeout` é um race especializado;
- `all` e `forEach` recebem uma política uniforme de concorrência;
- o runtime não promete cancelamento preemptivo de código JavaScript síncrono;
- integração externa continua dependendo de `AbortSignal` cooperativo.

API inicial:

```ts
ResultTask.all(input, { concurrency, mode })
ResultTask.forEach(items, f, { concurrency, discard })
ResultTask.race(left, right)
ResultTask.timeout(task, duration, onTimeout)
ResultTask.forkChild(task)
```

`mode` deve distinguir pelo menos fail-fast de validação acumulada. A API atual de
`combineWithAllErrors` pode ser expressa sobre essa distinção.

## Modelo de saída e erros

Falhas esperadas continuam em `E`. O runtime precisa distinguir outros dois estados:

```ts
export type Cause<E> =
  | { readonly _tag: 'Fail'; readonly error: E }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly reason?: unknown }
  | { readonly _tag: 'Sequential'; readonly left: Cause<E>; readonly right: Cause<E> }
  | { readonly _tag: 'Parallel'; readonly left: Cause<E>; readonly right: Cause<E> }

export type Exit<A, E> =
  | { readonly _tag: 'Success'; readonly value: A }
  | { readonly _tag: 'Failure'; readonly cause: Cause<E> }
```

Esse modelo não precisa aparecer no fluxo cotidiano. Ele existe para preservar informação em
cleanup, concorrência e observabilidade.

Conversão padrão:

- `Fail<E>` vira `Err<E>` em `runResult`;
- `Die` rejeita a Promise de `runResult`;
- `Interrupt` rejeita com `AbortError` em `runResult`;
- `runExit` nunca rejeita por estados modelados pelo runtime;
- múltiplas causas permanecem disponíveis em `runExit`.

Uma alternativa seria incluir `AbortError` automaticamente no tipo `E`. Este RFC não recomenda
essa direção: interrupção é uma propriedade da execução e não uma falha de domínio de toda função.
Boundaries que desejarem modelar cancelamento como domínio podem usar um combinador explícito.

## Representação interna inicial

A primeira implementação não precisa começar com um bytecode ou interpretador complexo. Uma
função lazy sobre um contexto de runtime é suficiente:

```ts
interface RuntimeContext<R> {
  readonly services: ServiceMap<R>
  readonly signal: AbortSignal
  readonly scope: Scope
  readonly clock: Clock
  readonly scheduler: Scheduler
}

type TaskExecutor<A, E, R> = (context: RuntimeContext<R>) => Promise<Exit<A, E>>
```

Cada combinador cria um novo executor sem iniciar a execução. Se profiling mostrar custo excessivo
de Promises ou recursão, a representação pode evoluir para instruções interpretadas sem alterar a
interface pública.

O runtime deve ser o único componente autorizado a:

- criar o `AbortController` raiz;
- abrir e fechar o scope raiz;
- criar fibers;
- registrar finalizers;
- consultar clock e scheduler;
- transformar `Exit` no tipo pedido pelo boundary.

## Relação com Result

`Result` continua eager, sem contexto e sem cancelamento. Ele deve permanecer apropriado para
parsing, validação e regras de domínio puras.

Conversões explícitas:

```ts
ResultTask.fromResult(result)
ResultTask.runSync(task) // somente se o tipo provar que a task é síncrona; opcional
```

Não é necessário mover todos os helpers de `Result` para `ResultTask`. Helpers de collections,
matching e tagged errors podem compartilhar primitivas internas, preservando APIs adequadas a cada
abstração.

## Relação com ResultAsync

`ResultAsync` permanece eager e awaitable durante a migração. Isso preserva o comportamento de:

```ts
const resultAsync = tryResultAsync(() => request())
const result = await resultAsync
```

Novas conversões propostas:

```ts
ResultTask.fromResultAsync(resultAsync) // captura uma execução já iniciada
ResultTask.toResultAsync(task) // inicia imediatamente usando runtime padrão
ResultAsync.fromTask(task) // alias de compatibilidade
```

`ResultAsync` não deve ser usado como representação interna de `ResultTask`, porque isso removeria
a propriedade lazy. O sentido correto é `ResultTask -> execução -> ResultAsync`.

### Matriz de compatibilidade

| API atual                  | Curto prazo  | API recomendada nova                                   |
| -------------------------- | ------------ | ------------------------------------------------------ |
| `ok`, `err`, `Result`      | manter       | sem mudança                                            |
| `okAsync`, `errAsync`      | manter       | `ResultTask.succeed`, `ResultTask.fail` para programas |
| `tryResultAsync`           | manter eager | `ResultTask.tryPromise`                                |
| `ResultAsync.retry`        | manter       | `ResultTask.retry` + `Schedule`                        |
| `ResultAsync.timeout`      | manter       | `ResultTask.timeout`                                   |
| `ResultAsync.race*`        | manter       | `ResultTask.race` e fibers estruturadas                |
| `ResultAsync.withResource` | manter       | `acquireRelease` + `scoped`                            |
| `safeTry` assíncrono       | manter       | `ResultTask.gen`                                       |
| `runPromise(ResultAsync)`  | manter       | overload ou nome explícito para `ResultTask`           |

Nenhuma função atual deve mudar silenciosamente de eager para lazy dentro da mesma major. Essa
mudança seria observável mesmo quando os tipos continuassem compilando.

## Organização de módulos

Estrutura de destino sugerida:

```text
packages/resultar/src/
  result/
    model.ts
    constructors.ts
    combinators.ts
    collections.ts
    match.ts
  task/
    model.ts
    constructors.ts
    combinators.ts
    generator.ts
    runtime.ts
    exit.ts
    cause.ts
    fiber.ts
    scope.ts
    schedule.ts
    services.ts
  async/
    result-async.ts
    adapters.ts
  errors/
    tagged-error.ts
    tagged-match.ts
    abort-error.ts
  internal/
    pipe.ts
    type-utils.ts
```

Essa estrutura é um destino, não um pré-requisito para começar. A primeira implementação pode
entrar em `src/task/` e reutilizar o core atual por imports. Mover arquivos existentes deve ocorrer
separadamente, depois que a API nova estiver estável, para manter diffs revisáveis.

## Estratégia de implementação

### Fase 0: contratos e provas de conceito

- adicionar testes de tipos para lazy evaluation e inferência de `A`, `E` e `R`;
- validar o desenho de `ResultTask.gen` com TypeScript 7;
- medir o custo de uma cadeia longa de `flatMap`;
- decidir nomes públicos antes de exportar pelo entrypoint principal;
- implementar inicialmente em um subpath experimental, se necessário.

Critério de saída: exemplos representativos compilam, lazy evaluation está provada por testes e a
representação escolhida não causa stack overflow em chains longas.

### Fase 1: núcleo lazy

- `ResultTask<A, E, R>` e TypeId nominal;
- `succeed`, `fail`, `fromResult`, `sync`, `try`, `tryPromise`;
- `map`, `mapError`, `flatMap`, `catchAll`, `tap`;
- `runExit`, `runResult`, `runPromise`;
- `Exit` e `Cause` mínimos;
- adapters para `Result` e `ResultAsync`.

Critério de saída: workflows sequenciais substituem `ResultAsync.andThen` sem perder inferência e
sem iniciar operações durante a construção.

### Fase 2: generator e serviços

- `ResultTask.gen`;
- contrato yieldable nominal;
- service tags;
- `service`, `provideService` e `provideServices`;
- erros de serviço ausente como defeito de runtime;
- testes de inferência de requisitos compostos.

Critério de saída: um workflow de aplicação pode declarar e prover database, logger e clock sem
capturar essas dependências por closure.

### Fase 3: scope e interrupção

- scope raiz e scopes filhos;
- registro LIFO de finalizers;
- `acquireRelease` e `scoped`;
- propagação de `AbortSignal`;
- `Fiber`, `forkChild`, `join` e `interrupt`;
- `race` e `timeout` sobre fibers.

Critério de saída: nenhum loser de race ou timeout continua sem dono, e finalizers executam em todos
os estados de saída.

### Fase 4: schedule e collections

- `Schedule` mínimo;
- retry sobre schedule e clock injetável;
- `all`, `forEach` e validação acumulada;
- limites uniformes de concorrência;
- interrupção fail-fast com cleanup dos itens ativos.

Critério de saída: helpers atuais de produção têm equivalentes sobre as mesmas primitivas de
runtime, sem protocolos de cancelamento independentes.

### Fase 5: integração e estabilização

- documentação e cookbook;
- benchmarks contra `ResultAsync` e Effect v4;
- migração dos pacotes `resultar-request-*` como consumidores piloto;
- subpath estável ou export pelo pacote principal;
- deprecações somente quando houver caminho mecânico de migração;
- decisão sobre a próxima major.

Critério de saída: pelo menos um consumidor real usa `ResultTask`; API, performance e mensagens de
erro foram validadas fora de testes unitários.

## Estratégia de testes

### Semântica

- construir uma task não executa efeitos;
- cada chamada de `run*` executa novamente a task;
- `map` e `flatMap` preservam short-circuit;
- `catchTag` remove corretamente variantes de `E`;
- defeitos não aparecem como `Err<E>` por acidente.

### Interrupção e concorrência

- timeout interrompe a task e aguarda finalizers;
- race interrompe todos os losers;
- interrupção do pai alcança filhos;
- concorrência limitada nunca excede o limite;
- fail-fast para de iniciar novos itens;
- validação acumulada preserva ordem determinística dos erros.

### Recursos

- release em sucesso, `Err`, defeito e interrupção;
- release exatamente uma vez;
- ordem LIFO;
- múltiplas causas preservadas;
- finalizer assíncrono concluído antes de `runExit` resolver.

### Tipos

- união de erros em `flatMap`;
- remoção de tagged errors em recovery;
- requisitos acumulados e removidos por `provideService`;
- `never` não degrada inferência;
- `yield*` não torna `ResultTask` estruturalmente compatível com outros yieldables;
- record e tuple inference em `all`.

### Compatibilidade

- API pública atual continua coberta pelo guard test;
- `ResultAsync` continua awaitable e eager;
- adapters não executam uma task mais de uma vez;
- pacotes request continuam com as assinaturas existentes.

## Performance e limites

Os benchmarks precisam observar:

- construção de tasks sem execução;
- chains de 10, 100 e 10.000 `map`/`flatMap`;
- execução sequencial;
- `all` com concorrência 1, limitada e unbounded;
- custo de `ResultTask.gen`;
- custo de scope/finalizer;
- memória retida após interrupção;
- comparação com `ResultAsync` atual, Promise manual e Effect v4.

Metas iniciais:

- nenhuma operação deve iniciar durante construção;
- chains longas não podem estourar a stack;
- overhead deve ser documentado, não escondido;
- o caminho de `Result` puro não deve pagar pelo runtime;
- tree shaking deve permitir usar `Result` sem incluir todo o módulo de task.

## Riscos

### Escopo grande demais

Context, fibers, cause, scope e schedule juntos podem transformar uma melhoria do core em uma
reescrita longa. A mitigação é publicar por fases, começando pelo núcleo lazy e validando cada nova
primitiva com um consumidor real.

### Confusão entre ResultAsync e ResultTask

Durante a transição haverá duas abstrações assíncronas. A documentação deve usar uma regra clara:

- recebeu ou precisa expor uma Promise já iniciada: `ResultAsync`;
- está descrevendo um workflow reutilizável: `ResultTask`.

### Complexidade de tipos

Adicionar `R`, generator inference e tagged recovery pode aumentar tempo de compilação. Benchmarks
de TypeScript e fixtures de inferência precisam fazer parte da Fase 0.

### API inspirada demais no Effect

Copiar nomes e conceitos sem uma necessidade concreta dilui a identidade do Resultar. Cada módulo
novo deve responder a um problema já presente no core ou em consumidores reais.

### Semântica de defeitos e interrupção

Converter tudo para `Err` parece simples, mas perde a distinção entre domínio, bug e cancelamento.
Por outro lado, expor `Cause` em toda API deixaria o caminho comum pesado. `Exit` deve permanecer um
boundary avançado, enquanto `runResult` oferece a experiência cotidiana.

## Questões em aberto

1. O nome final deve ser `ResultTask`, `TaskResult` ou outro?
2. `R` deve representar service tags em união ou um shape de serviços em interseção?
3. O primeiro release deve usar um subpath como `resultar/task`?
4. Métodos de instância serão parte da API canônica ou apenas funções pipeable?
5. `runResult` deve rejeitar em interrupção ou retornar um `Err<AbortError>` explícito?
6. Como representar simultaneamente falha de use e falha de release no boundary simplificado?
7. `ResultTask.gen` deve aceitar `Result` diretamente via `yield*` ou exigir `fromResult`?
8. `Schedule` entra no core ou em um subpath/package opcional?
9. Qual parte do runtime deve ser pública para testes e integração de tracing?

## Decisões preliminares recomendadas

- usar `ResultTask` como nome de trabalho;
- manter `Result` sem terceiro parâmetro;
- não alterar eager/lazy silenciosamente dentro da major atual;
- expor primeiro por `resultar/task` ou export experimental equivalente;
- usar TypeId nominal e um contrato yieldable estreito;
- começar com executor lazy por função e manter a representação privada;
- incluir `Exit`/`Cause` no runtime, mas não no caminho cotidiano;
- tratar `AbortSignal`, `Scope` e `Clock` como capacidades fundamentais;
- adiar `Layer` até existir evidência de uso real;
- migrar um pacote request como prova antes de estabilizar a API.

## Primeiro slice implementável

O menor pull request que valida a arquitetura deve conter somente:

```ts
ResultTask<A, E>
ResultTask.succeed
ResultTask.fail
ResultTask.fromResult
ResultTask.tryPromise
ResultTask.map
ResultTask.flatMap
ResultTask.catchAll
ResultTask.runResult
ResultTask.runExit
```

Além disso:

- TypeId nominal;
- lazy evaluation testada;
- execução repetível testada;
- `Exit` mínimo com `Success`, `Fail` e `Die`;
- nenhum serviço, fiber, schedule ou scope ainda;
- benchmark simples contra `ResultAsync` atual;
- export experimental, sem deprecações.

Esse slice responde à pergunta arquitetural principal — separar descrição de execução melhora o
core? — antes de comprometer o projeto com todo o runtime.

## Referências

- [Effect v4: `Effect` como descrição lazy de um workflow](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts)
- [Effect v4: migração para o trait `Yieldable`](https://github.com/Effect-TS/effect/blob/main/migration/yieldable.md)
- [Effect v4: guia geral de migração](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
- Implementação atual de `Result`: `packages/resultar/src/result.ts`
- Implementação atual de `ResultAsync`: `packages/resultar/src/result-async.ts`
- Roadmap atual: `packages/resultar/TASKS.md`
