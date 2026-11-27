# URL Shortener — Effect

Cópia do template `project-templates/benchmark/url-shortener-effect` para comparação com a implementação Resultar em `../url-shortener-resultar`.

A aplicação usa Effect 4, Effect Platform Node, MongoDB/Papr, ioredis e BullMQ. Os testes exercitam o contrato HTTP e a composição dos serviços com mocks dos drivers.

## Execução

Instale da raiz do workspace com `vp install` e use o lockfile compartilhado:

```sh
pnpm --filter url-shortener-effect run typecheck
pnpm --filter url-shortener-effect run check
pnpm --filter url-shortener-effect exec vp test run
pnpm --filter url-shortener-effect run build
PORT=3001 pnpm --filter url-shortener-effect start
```

`dev` usa Vite+ em modo watch. Para iniciar o MongoDB e o Redis locais, execute na raiz:

```sh
docker compose -f benchmarks/comparison/docker-compose.yaml up -d
```

## Configuração

| Variável                        | Padrão                      |
| ------------------------------- | --------------------------- |
| `HOST`                          | `0.0.0.0`                   |
| `PORT`                          | `3000`                      |
| `DB_URL`                        | `mongodb://localhost:27017` |
| `DB_NAME`                       | `url_shortener_effect`      |
| `DB_HEALTH_TIMEOUT_MS`          | `2000`                      |
| `REDIS_URL`                     | `redis://localhost:6379`    |
| `URL_ACCESS_WORKER_CONCURRENCY` | `4`                         |
| `REDIS_TTL_SECONDS`             | `3600`                      |
| `URL_CACHE_PREFIX`              | `url-shortener-effect:`     |

O startup verifica o MongoDB antes de provisionar o schema e os índices. Redis é opcional e o cache usa MongoDB como fallback. A fila `url-shortener-effect-jobs` registra acessos em segundo plano. O arquivo `.env.example` contém os exemplos de ambiente. Os testes usam camadas em memória e mocks.

## Contrato HTTP

- `POST /api/v1`: cria URL com `originalUrl`, `customAlias?` e `expiresAt?` (ISO 8601 com timezone).
- `GET /api/v1/:shortCode`: redireciona com 302, retorna 404 se ausente ou 410 se expirada.
- `POST /api/v1/:shortCode/delete`: exclusão lógica.
- `GET /api/v1/stats`: URLs ativas e não expiradas; `type=recent|popular`, `limit=1..100`, padrões `recent` e `10`.
- `/health` e `/live`: liveness.

A coleção `urls` recebe validator Papr e sete índices contando `_id`: short code ativo único, alias ativo único quando string, `isActive`, `expiresAt`, `createdAt` e índice parcial de `accessCount`/`lastAccessedAt` para URLs ativas.

O servidor registra logs de nível `error` ou superior. Veja [o guia de comparação](../README.md).
