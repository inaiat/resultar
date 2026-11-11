# AGENTS.md — resultar workspace

- Runtime: Node.js 24+, pnpm 12, ESM-only. Install with `pnpm install`.
- Validate with `pnpm run check:full`, `pnpm run build`, `pnpm run smoke:package`, `pnpm run test:examples`, `pnpm run test:docs`, and `pnpm run test:agents`.
- After public API or recipe changes: build, then `pnpm run docs:generate`; commit the generated inventory/recipes.
- Truth order: installed `node_modules` types first, then `packages/*/README.md`,
  then `DOCUMENTATION.md`, then `skills/resultar/`, then `docs/rfcs/*`
  (design history, not usage truth).
- Coding-agent guide: `skills/resultar/SKILL.md`. Remaining work: `docs/rfcs/rfc-0003-*.md`.
- Every behavior change ships with a changeset (`pnpm changeset`) and targeted tests.
- Never change eager-to-lazy semantics within the current major.
- The deprecated APIs documented in `docs/migrations/v4.md` are intentional:
  preserve their original signatures and behavior for gradual consumer migration.
  Prefer the replacement names in new workspace code; do not remove the old paths
  or change generator/tap behavior as part of this release. Do not add other shims.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
