# Executable coding-agent evaluations

`evals.json` retains the broad qualitative scenarios. `cases.mjs` supplies a bounded executable
contract for each scenario: tagged boundaries, retries, observation semantics, request validation,
checker configuration, composition repair, and lazy resource ownership. Narrative requirements
outside those contracts still need human review. The runner is `scripts/eval-agents.mjs` at the
workspace root.

## Verify the graders in CI

```sh
pnpm test:agents
```

This builds packages and the current native checker, then checks seven reference solutions and
seven deliberately broken variants. Each reference must pass; each broken variant must fail
compilation, checker validation, or runtime assertions. It makes no model calls and reports
`kind: "grader-validation"`, with no agent-performance metrics. A passing reference suite is not
proof that an AI can use the library correctly.

The published guide's core example is compiled during package build; package smoke checks its
presence and verifies that private continuation helpers do not leak into declarations.

## Evaluate generated code

After `pnpm build` and `pnpm --filter resultar-check native:build:current`:

```sh
pnpm eval:agents --candidate-dir /absolute/path/to/submissions --output /tmp/candidate-report.json
```

Place one generated `solution.mts` in each numbered directory (`1/solution.mts` through
`7/solution.mts`). Public support types are defined by each case. The runner checks generated code
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
- guide files (empty in `without-skill` mode);
- attempt number, previous generated code, and feedback from the prior attempt.

Return `{ "code": "...solution.mts...", "model": "provider/model", "usage": { ... } }`.
Only `code` is required. The runner accepts a single source file and keeps grading/configuration
outside the adapter response. Compilation, the native checker and runtime tests each have deadlines;
generation attempts are bounded (three by default, at most ten).

Reports preserve every attempt, diagnostic feedback, optional provider usage/model metadata,
first-attempt pass rate, final pass rate, total attempts, and elapsed time. Use repeated runs with
identical model settings to compare skill variants; seven contracts are a regression suite, not a
statistically robust benchmark. Reference solutions and mutation logic are never included in adapter
requests. Behavioral tests are written into each temporary project only after generation returns.
