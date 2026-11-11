# Executable coding-agent evaluations

`evals.json` retains the broad qualitative scenarios. `cases.mjs` supplies a bounded executable
contract for each scenario: tagged boundaries, retries, observation semantics, request validation,
checker configuration, composition repair, and lazy resource ownership. Narrative requirements
outside those contracts still need human review. The runner is `scripts/eval-agents.mjs` at the
workspace root.

The scenarios include existing eager compatibility contracts. Their fixed support types and graders
may intentionally require eager `ResultAsync` / `StrictResultAsync` contracts and helpers from `resultar`;
preserve their execution contracts when evaluating a submission. They do not make Async the default
for new v4 workflows. New code uses `ResultTask`, explicit runners, and structural Task factories
for eager adapters. `Result.gen` / `Result.fn` support sync and async bodies with modern
plain-value returns; legacy `safeTry` supports both forms with final-Result returns. All runtime
and type exports come from the single `resultar` package entrypoint.

The original seven compatibility fixtures remain unchanged. New cases add lazy HTTP
bridging, DI lifetime/local isolation, matching/redaction, numeric retry policies, and
complete failure-channel inspection, and raw driver Promise-to-Task repository contracts. Fixtures are version-specific. Existing
Async exports and deprecated aliases in `resultar` remain supported. Report semantic conflicts, such
as equating modern `Result.gen` with legacy final-Result `safeTry`, without changing fixed graders.

## Verify the graders in CI

```sh
pnpm test:agents
```

This builds packages and the current native checker, then checks fifteen reference solutions and
fifteen deliberately broken variants. Each reference must pass; each broken variant must fail
compilation, checker validation, or runtime assertions. It makes no model calls and reports
`kind: "grader-validation"`, with no agent-performance metrics. A passing reference suite is not
proof that an AI can use the library correctly.

The published guide's workflow and contract recipes compile during package build.
`vp run test:docs` verifies the generated public API inventory, published recipe source,
native checker defaults, bundled links, and recipe behavior. Package smoke also verifies
that private continuation helpers do not leak into declarations.

## Evaluate generated code

After `pnpm build` and `pnpm --filter resultar-check native:build:current`:

```sh
pnpm eval:agents --candidate-dir /absolute/path/to/submissions --output /tmp/candidate-report.json
```

Place one generated `solution.mts` in each numbered directory (`1/solution.mts` through
`15/solution.mts`). Public support types are defined by each case. The runner checks generated code
in fresh temporary projects against the workspace's built public declarations. It does not install
dependencies or contact a model provider. Temporary projects isolate fixtures, not OS permissions;
run untrusted submissions in an appropriately isolated execution environment.

## Connect a generation adapter

```sh
pnpm eval:agents --adapter /absolute/path/to/adapter.mjs --guidance with-skill --attempts 3 --output /tmp/with-skill.json
pnpm eval:agents --adapter /absolute/path/to/adapter.mjs --guidance without-skill --attempts 3 --output /tmp/without-skill.json
```

The Node adapter reads one JSON request from stdin and writes exactly one JSON response to stdout.
Send adapter logs to stderr. Provider selection, credentials and any model charges are controlled
by that adapter; CI never runs it. The request contains:

- scenario and executable contract;
- support-module source and installed package versions;
- entrypoint and API semantics plus scenario-specific references/manuals (empty in `without-skill` mode);
- reports record the selected guidance files and character count for reproducibility;
- attempt number, previous generated code, and feedback from the prior attempt.

Return `{ "code": "...solution.mts...", "model": "provider/model", "usage": { ... } }`.
Only `code` is required. The runner accepts a single source file and keeps grading/configuration
outside the adapter response. Compilation, the native checker and runtime tests each have deadlines;
generation attempts are bounded (three by default, at most ten).

Reports preserve every attempt, diagnostic feedback, optional provider usage/model metadata,
first-attempt pass rate, final pass rate, total attempts, and elapsed time. Use repeated runs with
identical model settings to compare skill variants; these contracts are a regression suite, not a
statistically robust benchmark. Reference solutions and mutation logic are never included in adapter
requests. Behavioral tests are written into each temporary project only after generation returns.
