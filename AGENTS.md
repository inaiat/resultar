# AGENTS.md — resultar workspace

- Runtime: Node.js 24+, pnpm 11, ESM-only. Install with `pnpm install`.
- Validate with `pnpm run check:full`, `pnpm run build`, `pnpm run smoke:package`, `pnpm run test:examples`.
- Truth order: installed `node_modules` types first, then `packages/*/README.md`,
  then `DOCUMENTATION.md`, then `skills/resultar/`, then `docs/rfcs/*`
  (design history, not usage truth).
- Coding-agent guide: `skills/resultar/SKILL.md`. Remaining work: `docs/rfcs/rfc-0003-*.md`.
- Every behavior change ships with a changeset (`pnpm changeset`) and targeted tests.
- Never change eager-to-lazy semantics within the current major. No shims or deprecated aliases:
  migrate every caller and remove the old path.
