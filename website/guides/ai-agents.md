# AI & Coding Agents

Resultar is designed to work reliably with coding agents — **Claude Code**, **Codex**, **Cursor**, **Antigravity**, **Windsurf**, and custom LLM workflows — without relying on stale training data or web scraping.

Install [`resultar-check`](../../packages/check/README.md) as a development dependency to give your agent the offline guides, executable recipes and type-aware diagnostics.

## What ships inside `node_modules/resultar-check`

```sh
pnpm add -D resultar-check
```

Start at `dist/llms.txt` in the checker package. The runtime and checker have independent releases. Compare the versions in `dist/agent/versions.json` with your installed packages before using a recipe.

| Installed path                                              | Purpose                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `node_modules/resultar-check/dist/llms.txt`                 | Compact index pointing to every bundled agent guide, manual, recipe, and version manifest                                      |
| `node_modules/resultar-check/dist/agent/SKILL.md`           | Core execution contracts (`Result`, lazy `ResultTask`, `resultar/async` compat) and progressive doc routing                    |
| `node_modules/resultar-check/dist/agent/references/`        | Focused reference sheets: `api.md`, `anti-patterns.md`, `patterns.md`, `services.md`, `integrations.md`, `review-checklist.md` |
| `node_modules/resultar-check/dist/agent/manual/`            | Full bundled `DOCUMENTATION.md`, `README.md`, package READMEs, `coming-from-effect.md`, `api-inventory.md`, and `recipes.md`   |
| `node_modules/resultar-check/dist/agent/examples/`          | Compiled and behavior-tested workflow and contract recipes (`workflow.mts`, `contracts.mts`)                                   |
| `node_modules/resultar-check/dist/agent/versions.json`      | Exact companion package versions (`resultar-di`, `resultar-fastify`, `resultar-request`, etc.) matched to the guide            |
| `node_modules/resultar-check/dist/agent/agents/openai.yaml` | OpenAI / Codex agent skill metadata                                                                                            |

> For tools that fetch web documentation instead of reading `node_modules`, point them to the raw hosted index at [`https://inaiat.github.io/resultar/llms.txt`](https://inaiat.github.io/resultar/llms.txt) or browse the [llms.txt Index](../../llms.txt) in these docs.

## Setup by coding agent

### Claude Code, Codex, Antigravity & `AGENTS.md`

Add a short block to your repository's `AGENTS.md` (or `CLAUDE.md`) so the agent reads the installed skill first and verifies edits with `resultar-check`:

```md
## Resultar

- Read `node_modules/resultar-check/dist/agent/SKILL.md` and `node_modules/resultar-check/dist/llms.txt` before writing or refactoring Resultar code.
- Truth order: installed `node_modules/<package>/dist/*.d.ts` first, then companion package READMEs, then `node_modules/resultar-check/dist/agent/SKILL.md`.
- Keep synchronous logic in `Result<T, E>` and new async workflows in lazy `ResultTask<T, E, R>` (execute at boundaries via `await task.runResult()`, never `await task`).
- After edits, run `pnpm exec resultar-check --project tsconfig.json` and fix all reported compiler and Resultar diagnostics.
```

If your agent supports local skill folders (such as Claude Code, Codex, or Antigravity), you can also load `node_modules/resultar-check/dist/agent/SKILL.md` directly as a skill.

### Cursor (one-command setup)

`resultar-check` scaffolds Cursor rules, VS Code/Cursor tasks, and the LSP extension recommendation automatically:

```sh
pnpm exec resultar-check init --editor cursor --project tsconfig.json
```

This creates:

- `.cursor/rules/resultar-check.mdc` — workspace rule instructing Cursor agents to use Resultar v5 contracts and run `resultar-check`;
- `.vscode/tasks.json` — `resultar-check` and `resultar-check: fix` tasks with a problemMatcher;
- `.vscode/extensions.json` — recommends `inaiat.resultar-check` for inline `T / E / R` hover and quick fixes.

Use `--editor all` to configure Zed, VS Code, and Cursor together, and run `pnpm exec resultar-check doctor --editor all` to verify the setup.

## Deterministic verification loop with `resultar-check`

Prompting alone is not enough — give your agent a fast, machine-readable compiler gate. [`resultar-check`](../../packages/check/README.md) runs TypeScript-Go type checking and all 43 native Resultar rules in a single pass (~140 ms on 120 files):

```sh
# 1. Orient the agent: list exported Result/ResultTask APIs, tagged errors, and DI services
pnpm exec resultar-check overview --project tsconfig.json --json

# 2. Verify edits with streaming JSON Lines diagnostics
pnpm exec resultar-check --project tsconfig.json --json

# 3. Preview proposed edits for a specific file without writing
pnpm exec resultar-check quickfixes --project tsconfig.json --file src/workflow.ts --json

# 4. Auto-apply safe semantic corrections (never auto-adds `void` discards)
pnpm exec resultar-check --fix --project tsconfig.json

# 5. Upgrade a v4 codebase to v5 mechanically and list manual review items
pnpm exec resultar-check migrate-v5 --project tsconfig.json
```

Key agent-safety properties of `resultar-check`:

- **Catches common LLM mistakes immediately**: accidental `await task` (`RESULTAR010`), discarded `Result`/`ResultTask`/`Fiber` (`RESULTAR001`), `Promise<ResultTask<...>>` leaks (`RESULTAR002`), missing `yield*` or `return yield*` inside `ResultTask.gen` / `ResultTask.fn`, unscoped `acquireRelease`, and invalid DI lifetimes.
- **Separates safe fixes from intentional discards**: JSONL diagnostics label every quick fix as `kind: "correction"` or `kind: "intentional-discard"`. `--fix` only applies safe corrections so an agent never silently papers over a bug with `void task`.
- **Fast codebase discovery**: `overview --json` gives agents exact `success`, `error`, and `requirements` channels across exported functions, tagged errors, and services without grepping the entire repository.

## Truth hierarchy

When documentation and installed types appear to disagree, agents should always resolve truth in this order:

1. Installed declarations (`node_modules/<package>/dist/*.d.ts`)
2. Companion package READMEs and `node_modules/resultar-check/dist/agent/versions.json`
3. Complete guide (`DOCUMENTATION.md`) and [Public API Inventory](../../docs/api-inventory.md)
4. Agent skill (`skills/resultar/SKILL.md` and `references/*`)
5. RFCs under `docs/rfcs/` (design history only, never usage truth)

## Agent reference guides

Browse every guide bundled inside `node_modules/resultar-check/dist/agent/`:

| Guide                                                                      | What it covers                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [llms.txt Index](../../llms.txt)                                           | Complete machine-readable map of docs, packages, examples, and freshness rules                                |
| [Agent Skill (`SKILL.md`)](../../skills/resultar/SKILL.md)                 | Execution contracts, boundary rules, and progressive reference routing                                        |
| [API Semantics](../../skills/resultar/references/api.md)                   | Semantic constraints across `Result`, `ResultTask`, `Match`, `Cause`, `Fiber`, `Clock`, `Retry`, and subpaths |
| [Anti-Patterns & Rules](../../skills/resultar/references/anti-patterns.md) | Checker configuration, `--fix`, `migrate-v5`, repair patterns, and all 43 native diagnostics                  |
| [Production Patterns](../../skills/resultar/references/patterns.md)        | Rich tagged errors, `memoize`, `onExit`, `runFork` workers, bounded concurrency, and `VirtualClock` testing   |
| [Services & HTTP](../../skills/resultar/references/services.md)            | `serviceTag`, `resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, and `resultar-request`   |
| [Integrations](../../skills/resultar/references/integrations.md)           | HTTP route mapping, database session ownership, and event/queue consumer bridges                              |
| [Review Checklist](../../skills/resultar/references/review-checklist.md)   | Pre-commit verification checklist for generated Resultar changes                                              |
| [Executable Recipes](../../docs/recipes.md)                                | Compiled, behavior-tested reference contracts                                                                 |

## Executable agent evaluations

The repository includes a 15-case executable evaluation harness ([`skills/resultar/evals/README.md`](../../skills/resultar/evals/README.md)) that tests generated TypeScript code against built declarations, `resultar-check`, and behavioral runtime assertions:

```sh
# Validate all 15 reference and broken-variant graders in CI
pnpm test:agents

# Grade a candidate submission directory or connect a custom LLM adapter
pnpm eval:agents --adapter /path/to/adapter.mjs --guidance with-skill --attempts 3
```
