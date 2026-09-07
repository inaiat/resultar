# Exemplo Deno com resultar-hono

O exemplo executável está em [examples/hono](../examples/hono/README.md).

- [Aplicação e rotas](../examples/hono/src/app.ts): bindings inferidos pelo resultar-hono.
- [Serviços](../examples/hono/src/services.ts): cache singleton e serviços scoped.
- [Bootstrap Deno](../examples/hono/src/main.deno.ts): instanciação e inicialização direta com Deno.serve.

O bootstrap instancia a aplicação e passa `app.fetch` diretamente para `Deno.serve`,
sem necessidade de cerimônia de infraestrutura. A integração com Resultar DI e o escopo
de ciclo de vida por requisição permanecem encapsulados na aplicação Hono.

Para executar, após instalar as dependências na raiz do monorepo:

```sh
pnpm --filter resultar-hono-example build:deps
cd examples/hono
deno task start
```

Configure PORT e HOST no ambiente. O padrão é http://127.0.0.1:3000.
Ctrl+C inicia o encerramento gracioso. Não há deadline automático para streams persistentes.

Referência: [encerramento gracioso no Deno](https://docs.deno.com/examples/http_server_graceful_shutdown/).
