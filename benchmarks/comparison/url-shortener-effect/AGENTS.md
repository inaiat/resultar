# Repository Guidelines

## Project Structure & Module Organization

The service uses Effect Platform. Place HTTP handlers and Effect Schema contracts in `src/application`, domain models and use cases in `src/domain`, and cache, persistence, queue, and configuration in `src/infrastructure`. `src/index.ts` launches the scoped Node HTTP server. `src/app.ts` composes the HTTP layer used by the runtime and tests. Keep generated output in `dist/` and coverage in `coverage/`.

Validate the optional `expiresAt` creation field as an absolute ISO 8601 timestamp with a timezone at the HTTP boundary.
Keep stats query validation in the HTTP API schema and apply the active and expiration filters,
sorting, and limit in the MongoDB repository.

## Build, Test, and Development Commands

- `vp install` from the workspace root: install from the shared workspace lockfile with Node.js 24+.
- `pnpm dev`: rebuild and restart the Effect server in Vite+ watch mode.
- `pnpm start`: run the compiled server with tracing disabled.
- `pnpm build`: bundle the Node entry point into `dist/` with `vp pack`.
- `pnpm typecheck | lint | lint:fix | fmt`: run TypeScript 7 and Vite+ checks.
- `pnpm test | coverage | validate`: run Vitest, coverage, and the full quality gate.

## Coding Style & Naming Conventions

Use idiomatic TypeScript with ES modules, 2-space indentation, and explicit names for Effect services (`UrlCacheService`, `UrlCacheLive`). Keep route handlers in `*.route.ts`, services in `*.service.ts`, repositories in `*.repository.ts`, and schema objects in `*.schema.ts`. Prefer Effect `Layer` composition over manual singletons and favor immutable helpers in `src/domain/helpers`. Always run `pnpm fmt` to apply the canonical formatting and `pnpm lint` for oxlint rules.

## Testing Guidelines

Use `vite-plus/test` for Vitest APIs. HTTP tests share the production API layer through Effect's Fetch-compatible handler and use mock infrastructure from `tests/helpers`. Keep the Vitest UI and coverage provider on the exact version bundled by Vite+.

## Commit & Pull Request Guidelines

History shows Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Keep summaries imperative, present tense, and under 72 characters, then add detail lines when multiple modules change. Pull requests should call out the intent, reference tracking issues, list validation commands (`pnpm validate`, `pnpm coverage`, etc.), and include screenshots or trace links whenever docs, Swagger, or observability layers change.

## Security & Configuration Tips

Effect configuration lives in `src/infrastructure/app-config.ts` and Layer composition lives in `src/infrastructure/app-services.ts`. Run automated tests with dependency mocks. For local servers, see `.env.example`. Keep the MongoDB timeout, Redis options, and BullMQ worker concurrency aligned with the Resultar benchmark, using separate storage names and queues. Avoid committing `.env` files and scrub logs for sensitive data. Tracing is disabled in this benchmark.

## MongoDB benchmark contract

Papr provisions the strict MongoDB validator for `urls` at startup. The seven indexes include the default ObjectId index, active-only unique short codes and aliases (string aliases only), individual indexes on `isActive`, `expiresAt` and descending `createdAt`, and a partial descending index on `accessCount` and `lastAccessedAt` for active URLs.
