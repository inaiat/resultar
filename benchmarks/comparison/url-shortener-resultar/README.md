# URL Shortener — Resultar

Cópia do encurtador originalmente chamado `url-shortener-flashify`, adaptada para os pacotes locais do Resultar. Não requer pacotes privados.

- `resultar`: resultados síncronos, erros com tag e workflows assíncronos lazy com `ResultTask`.
- `resultar-di`: módulos, singletons, serviços por requisição e recursos com descarte explícito.
- `resultar-config`: validação do ambiente com TypeBox.
- `resultar-fastify`: ciclo de vida da aplicação e dos serviços por requisição no Fastify nativo.
- MongoDB/Papr, ioredis e BullMQ: drivers públicos adaptados com `ResultTask.tryPromise`.

## Execução

Na raiz do workspace, execute `vp install` e `pnpm run build` para compilar as dependências locais. Depois:

```sh
pnpm --filter url-shortener-resultar run check:full
pnpm --filter url-shortener-resultar run build
pnpm --filter url-shortener-resultar start
```

O modo de desenvolvimento usa `pnpm --filter url-shortener-resultar dev`.
MongoDB e Redis locais podem ser iniciados com `docker compose -f benchmarks/comparison/docker-compose.yaml up -d`.

## Configuração

| Variável                        | Padrão                      |
| ------------------------------- | --------------------------- |
| `HOST`                          | `0.0.0.0`                   |
| `PORT`                          | `3000`                      |
| `DB_URL`                        | `mongodb://localhost:27017` |
| `DB_NAME`                       | `url_shortener_resultar`    |
| `DB_HEALTH_TIMEOUT_MS`          | `2000`                      |
| `STARTUP_READINESS`             | `true`                      |
| `REDIS_URL`                     | `redis://localhost:6379`    |
| `URL_ACCESS_WORKER_CONCURRENCY` | `4`                         |
| `REDIS_TTL_SECONDS`             | `3600`                      |
| `URL_CACHE_PREFIX`              | `url-shortener-resultar:`   |

MongoDB é a persistência principal. A inicialização verifica o banco com timeout e provisiona o validator Papr e os índices antes de servir. Redis é um cache opcional: falhas degradam para MongoDB. A fila `url-shortener-resultar-jobs` registra acessos em segundo plano. Cada worker processa até quatro jobs simultâneos por padrão, ajustáveis por `URL_ACCESS_WORKER_CONCURRENCY`. A rota `/health` indica que o servidor está ativo. Use `.env.example` como referência para a configuração local.

## Contrato HTTP

| Método | Caminho                              | Comportamento                                                          |
| ------ | ------------------------------------ | ---------------------------------------------------------------------- |
| POST   | `/api/v1`                            | Cria URL com `originalUrl`, `customAlias?` e `expiresAt?`; retorna 201 |
| GET    | `/api/v1/:shortCode`                 | Redireciona com 302; 404 se ausente e 410 se expirada                  |
| POST   | `/api/v1/:shortCode/delete`          | Exclusão lógica e invalidação do cache                                 |
| GET    | `/api/v1/stats?type=recent&limit=10` | Estatísticas recentes ou populares; limite inteiro de 1 a 100          |
| GET    | `/health`                            | Liveness                                                               |

As rotas executam tasks com `runResult()`. O mapa `httpErrors.statusByTag` em `src/app.ts` configura o handler HTTP de `resultar-fastify`. `@fastify/autoload` descobre os arquivos `*.route.ts` em desenvolvimento e `*.route.js` no build, em `application/routes`, sem prefixos derivados das pastas. Schemas e outros helpers não são carregados como plugins. O build preserva esse diretório e também exporta a factory em `dist/app.js`.
Os testes passam pelo mesmo bootstrap e rotas de produção, com ports substituídos por serviços em memória. A suíte inclui HTTP real em porta efêmera, isolamento por requisição, fallback de cache, provisionamento e descarte de recursos.

## Bootstrap e encerramento

`createApp(settings, options)` recebe a configuração validada e retorna uma instância nativa do Fastify. A factory registra a configuração de DI de `app-services.ts`, o tratamento de erros HTTP e o autoload. Quem usa a factory controla o ciclo de vida com `ready()`, `inject()`, `listen()` e `close()`.

`app-services.ts` concentra o módulo de `resultar-di`, os bindings, os valores locais por requisição e o startup. Os `overrides` substituem ports em testes. Os recursos próprios são adquiridos e liberados pelo módulo DI.

O executável `src/index.ts` valida a configuração uma vez, cria a aplicação e chama `listen()`. O escopo `acquireRelease` registra o fechamento antes de abrir a porta, preserva as falhas de inicialização e encerramento e trata `SIGINT` e `SIGTERM`.

## MongoDB

A coleção `urls` mantém validator estrito e sete índices contando `_id`: short code ativo único; alias ativo único quando string; índices de `isActive`, `expiresAt` e `createdAt`; índice parcial de `accessCount`/`lastAccessedAt` para URLs ativas.

Veja [o guia de comparação](../README.md).
