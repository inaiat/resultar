import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceDir = fileURLToPath(new URL("../../..", import.meta.url));
const exampleDir = fileURLToPath(new URL("..", import.meta.url));

interface CommandResult {
  readonly output: string;
  readonly status: number;
}

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly expectFailure?: boolean },
): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout}${result.stderr}`;
  const status = result.status ?? 1;

  if (result.error !== undefined) {
    throw result.error;
  }

  if (options.expectFailure !== true && status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${status}\n${output}`);
  }

  if (options.expectFailure === true && status === 0) {
    throw new Error(`${command} ${args.join(" ")} was expected to fail but passed\n${output}`);
  }

  return { output, status };
};

const pnpm = (
  args: readonly string[],
  options: { readonly cwd: string; readonly expectFailure?: boolean },
) => run("pnpm", args, options);

const assertIncludes = (output: string, expected: string, message: string): void => {
  if (!output.includes(expected)) {
    throw new Error(`${message}\n${output}`);
  }
};

const assertExcludes = (output: string, unexpected: string, message: string): void => {
  if (output.includes(unexpected)) {
    throw new Error(`${message}\n${output}`);
  }
};

const expectedRules = [
  "no-await-in-safe-try",
  "no-tagged-error-constructor-override",
  "no-throw",
  "no-try-catch-in-safe-try",
  "prefer-tagged-error",
  "tagged-error-name-match",
  "typed-catch-mapper",
  "yield-star-in-safe-try",
] as const;

type ExpectedRule = (typeof expectedRules)[number];
type RuleCounts = Record<ExpectedRule, number>;

interface CheckRun {
  readonly counts: RuleCounts;
  readonly label: string;
  readonly output: string;
  readonly total: number;
}

const checkScripts = [
  { label: "Oxlint", script: "check:oxlint" },
  { label: "ESLint", script: "check:eslint" },
  { label: "resultar-check CLI", script: "check:resultar-check" },
] as const;

const countText = (value: string, expected: string): number => value.split(expected).length - 1;

const normalizeResultarRuleIds = (output: string): string =>
  expectedRules.reduce(
    (current, rule) => current.replaceAll(`resultar(${rule})`, `resultar/${rule}`),
    output,
  );

const countRuleDiagnostics = (output: string): RuleCounts => {
  const normalized = normalizeResultarRuleIds(output);
  const entries = expectedRules.map((rule) => [
    rule,
    countText(normalized, `resultar/${rule}`),
  ] as const);

  return Object.fromEntries(entries) as RuleCounts;
};

const totalDiagnostics = (counts: RuleCounts): number =>
  expectedRules.reduce((total, rule) => total + counts[rule], 0);

const formatCounts = (counts: RuleCounts): string =>
  expectedRules.map((rule) => `${rule}: ${counts[rule]}`).join(", ");

const assertSameCounts = (base: CheckRun, candidate: CheckRun): void => {
  if (candidate.total !== base.total) {
    throw new Error(
      `${candidate.label} reported ${candidate.total} diagnostics, expected ${base.total} from ${base.label}.\n${candidate.output}`,
    );
  }

  for (const rule of expectedRules) {
    if (candidate.counts[rule] !== base.counts[rule]) {
      throw new Error(
        `${candidate.label} reported ${candidate.counts[rule]} ${rule} diagnostics, expected ${base.counts[rule]} from ${base.label}.\n${candidate.output}`,
      );
    }
  }
};

pnpm(["--filter", "resultar", "build"], { cwd: workspaceDir });
pnpm(["--filter", "resultar-check", "build"], { cwd: workspaceDir });

const runs = checkScripts.map(({ label, script }) => {
  const { output } = pnpm(["run", script], { cwd: exampleDir, expectFailure: true });
  const counts = countRuleDiagnostics(output);
  const total = totalDiagnostics(counts);

  assertExcludes(
    output,
    "src/resultar-clean.ts:",
    `Expected clean Resultar example file to have no ${label} diagnostics`,
  );

  return { counts, label, output, total };
});

const [baseRun, ...candidateRuns] = runs;

if (baseRun === undefined) {
  throw new Error("Expected at least one check run");
}

for (const rule of expectedRules) {
  if (baseRun.counts[rule] === 0) {
    throw new Error(`Expected ${baseRun.label} to report ${rule}\n${baseRun.output}`);
  }
}

assertIncludes(
  baseRun.output,
  "throwing new Error(...)",
  "Expected Oxlint plugin to report thrown native Error diagnostics",
);

for (const run of candidateRuns) {
  assertSameCounts(baseRun, run);
}

process.stdout.write(
  `Resultar lint adapter parity smoke passed (${baseRun.total} diagnostics: ${formatCounts(baseRun.counts)}).\n`,
);
