# Hono + Resultar DI

Uma aplicação de exemplo demonstrando injeção de dependências com [Resultar DI](../../packages/di/README.md) e rotas tipadas com [resultar-hono](../../packages/hono/README.md).

- [Serviços](src/services.ts): composição tipada com `singleton` e `scoped`.
- [Aplicação](src/app.ts): rotas Hono com bindings inferidos via `createHonoApp`.
- [Bootstrap](src/main.ts): execução no Node via `@hono/node-server`.

---

## Execução

Na raiz do monorepo:

```sh
pnpm install
pnpm --filter resultar-hono-example build:deps
```

### Iniciar aplicação

```sh
pnpm --filter resultar-hono-example start
# ou dentro de examples/hono:
pnpm start
```

---

## Endpoints

Por padrão, a aplicação escuta em `http://127.0.0.1:3000`:

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok","users":1}

curl http://127.0.0.1:3000/users/1
# {"id":"1","name":"Ada"}

curl -X DELETE http://127.0.0.1:3000/users/1
# 204 No Content

curl http://127.0.0.1:3000/health
# {"status":"ok","users":0}
```

PORT e HOST podem ser configurados via variáveis de ambiente.

---

## Composição e Ciclo de Vida

- `Cache` é **singleton** (uma única instância compartilhada durante toda a vida da aplicação).
- `Users` e `Health` são **scoped** (uma nova instância criada isoladamente para cada requisição HTTP).
- `createHonoApp` mantém um escopo de DI aberto até que a resposta (inclusive streaming de corpo) seja completamente consumida ou cancelada.
- O bootstrap instancia a aplicação e entrega `app.fetch` diretamente ao runtime (`Deno.serve` ou `@hono/node-server`), sem necessidade de tokens artificiais de router ou infraestrutura complexa.

---

## Validação

```sh
# Verificação de tipos e regras Resultar Check:
pnpm run check

# Smoke test (executa requisições via app.request):
pnpm run smoke
```
