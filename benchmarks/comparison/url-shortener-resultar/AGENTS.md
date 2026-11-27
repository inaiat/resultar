# URL Shortener — Resultar

Siga também o AGENTS.md da raiz. Esta cópia usa exclusivamente pacotes públicos e os pacotes locais do Resultar; preserve essa propriedade.

- Node.js 24+, ESM, pnpm 12 e Vite+ do workspace. Instale da raiz; use o lockfile compartilhado.
- Domínio em `src/domain`, HTTP/TypeBox em `src/application/routes`, drivers e composição em `src/infrastructure`.
- Serviços e métodos assíncronos retornam `ResultTask`; execute apenas nas fronteiras HTTP, bootstrap e callbacks dos drivers.
- Use `resultar-di` para módulos e recursos; `resultar-fastify` mantém as requisições vivas e descarta o root ao fechar.
- Mongo/Papr, Redis e BullMQ são drivers públicos. Recursos próprios têm release explícito; overrides externos são emprestados.
- Mantenha os drivers em `infrastructure/database`, `papr`, `cache` e `queue`. Alinhe o timeout do MongoDB, as opções do Redis e a concorrência do BullMQ com a variante Effect. Use bancos, prefixos de cache e filas distintos.
- No startup, verifique o MongoDB com timeout e provisione o schema e os índices antes de servir. A rota GET /health indica liveness. Redis é opcional; preserve fallback para MongoDB e tracking best-effort.
- Não acesse bancos reais nos testes: substitua ports ou construtores. Preserve contrato HTTP, teste HTTP real, logger por requisição e descarte.
- Alterações no contrato atualizam README.md, AGENTS.md e llms.txt.
- Valide com `pnpm --filter url-shortener-resultar run check:full`, `run check:fallow`, `run build` e `exec tsc --noEmit` da raiz.

- `createApp(settings, options)` recebe configuração validada e devolve o Fastify nativo. O executável aplica `acquireRelease` antes de chamar `listen()`.
- Mantenha módulo DI, bindings, locals, startup e tipagem de serviços Fastify em `app-services.ts`; handlers de sinais pertencem ao executável `index.ts`, não à factory reutilizável.
- No executável, registre os sinais antes de executar o workflow. Use acquireRelease e interrupção cooperativa para fechar o servidor uma única vez, inclusive durante startup.
- Carregue rotas com @fastify/autoload em application/routes, apenas arquivos _.route.ts/_.route.js e sem prefixos de diretório. Preserve as entradas de rotas no build e o teste do artefato compilado em Node sem loader TypeScript.
- Componha infraestrutura exclusivamente pelo módulo DI com value, singleton e resource. Não exponha infrastructure.plugins no bootstrap. Nos testes, observe finalizers dos recursos DI e substitua ports emprestados ou construtores dos drivers.
