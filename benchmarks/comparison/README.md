# Benchmarks de encurtamento de URL

Aplicações copiadas de `project-templates/benchmark` para comparar o mesmo contrato HTTP:

- `url-shortener-effect`: Effect Platform, Effect, MongoDB/Papr, Redis e BullMQ.
- `url-shortener-resultar`: versão adaptada para Resultar, `resultar-di`, `resultar-config` e `resultar-fastify`, com os drivers públicos.

As duas aplicações são privadas, pertencem ao workspace e usam o lockfile da raiz.
Node.js 24+ e pnpm 12. O tracing privado foi removido das duas cópias.
Os microbenchmarks existentes ficam na pasta pai, `benchmarks/`.

## Preparar e validar

Execute da raiz do repositório:

```sh
vp install
pnpm run build
pnpm --filter url-shortener-effect run typecheck
pnpm --filter url-shortener-effect run check
pnpm --filter url-shortener-effect exec vp test run
pnpm --filter url-shortener-effect run build
pnpm --filter url-shortener-resultar run check:full
pnpm --filter url-shortener-resultar run build
```

Os testes usam serviços em memória e mocks dos drivers, sem MongoDB ou Redis externos.
Para executar os servidores, suba MongoDB e Redis e configure o ambiente de cada aplicação.
O `docker-compose.yaml` da comparação disponibiliza os dois serviços nas portas padrão:

```sh
docker compose -f benchmarks/comparison/docker-compose.yaml up -d
pnpm --filter url-shortener-resultar start
# Em outra execução, com PORT=3001, para evitar conflito:
PORT=3001 pnpm --filter url-shortener-effect start
```

Cada aplicação tem `src/infrastructure/app-config.ts` para o ambiente e `app-services.ts` para compor `database/`, `papr/`, `cache/`, `queue/` e `repository/`. Use os arquivos `.env.example` para configurar os servidores.

| Configuração | Effect | Resultar |
| --- | --- | --- |
| Banco MongoDB | `url_shortener_effect` | `url_shortener_resultar` |
| Prefixo de cache Redis | `url-shortener-effect:` | `url-shortener-resultar:` |
| Fila BullMQ | `url-shortener-effect-jobs` | `url-shortener-resultar-jobs` |

As duas variantes usam as mesmas versões de MongoDB/Papr, ioredis e BullMQ. Os padrões são 2 s para a verificação do MongoDB, 1 s para conectar ao Redis, quatro jobs simultâneos por worker e TTL de cache de 3.600 s.

Ambas oferecem `POST /api/v1`, `GET /api/v1/:shortCode`,
`POST /api/v1/:shortCode/delete`, `GET /api/v1/stats` e `/health`.
Use o mesmo conjunto de dados, índices, portas de infraestrutura e carga ao comparar desempenho.
Os testes validam o contrato; nenhuma medição de throughput é produzida automaticamente.
Os resultados mais recentes da execução ABBA equalizada (2026-11-27, commit `9dd623e`) estão registrados em [../results/2026-11-27-url-shortener.md](../results/2026-11-27-url-shortener.md).
