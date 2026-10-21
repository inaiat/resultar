# AGENTS.md — resultar workspace

- Runtime: Node.js 24+, pnpm 11, ESM-only. Install with `pnpm install`.
- Validate with `pnpm run check:full`, `pnpm run build`, `pnpm run smoke:package`, `pnpm run test:examples`.
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
