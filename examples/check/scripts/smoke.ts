import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const launcher = join(dirname(require.resolve("resultar-check/schema.json")), "dist", "cli.js");

const expectedRules = [
  "no-await-in-safe-try",
  "no-discard",
  "no-promise-in-result-success",
  "no-tagged-error-constructor-override",
  "no-throw",
  "no-try-catch",
  "no-try-catch-in-safe-try",
  "no-unsafe-await",
  "no-unknown-result-error",
  "no-useless-recovery",
  "prefer-and-then",
  "prefer-catch-reason",
  "prefer-first-success-of",
  "prefer-map",
  "prefer-map-err",
  "prefer-result-for-each",
  "prefer-tagged-error",
  "tagged-error-name-match",
  "typed-catch-mapper",
  "unsafe-result-type-assertion",
  "yield-star-in-safe-try",
  "yield-star-in-result-task-gen",
] as const;

type ExpectedRule = (typeof expectedRules)[number];

const expectedCounts = {
  "no-await-in-safe-try": 1,
  "no-discard": 4,
  "no-promise-in-result-success": 2,
  "no-tagged-error-constructor-override": 1,
  "no-throw": 3,
  "no-try-catch": 2,
  "no-try-catch-in-safe-try": 1,
  "no-unsafe-await": 5,
  "no-unknown-result-error": 2,
  "no-useless-recovery": 2,
  "prefer-and-then": 2,
  "prefer-catch-reason": 1,
  "prefer-first-success-of": 1,
  "prefer-map": 2,
  "prefer-map-err": 1,
  "prefer-result-for-each": 1,
  "prefer-tagged-error": 3,
  "tagged-error-name-match": 1,
  "typed-catch-mapper": 1,
  "unsafe-result-type-assertion": 2,
  "yield-star-in-safe-try": 1,
  "yield-star-in-result-task-gen": 1,
} satisfies Record<ExpectedRule, number>;

interface Finding {
  readonly file: string;
  readonly message: string;
  readonly rule: string;
  readonly severity: string;
}

interface CommandResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

const run = (project: string, json = false): CommandResult => {
  const result = spawnSync(
    process.execPath,
    [launcher, "--project", project, ...(json ? ["--json"] : [])],
    { cwd: exampleDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
};

const diagnosticsRun = run("tsconfig.json", true);

if (diagnosticsRun.status === 0) {
  throw new Error("Expected the diagnostics catalog to fail resultar-check");
}

if (diagnosticsRun.stderr.trim() !== "") {
  throw new Error(`Expected no TypeScript compiler errors\n${diagnosticsRun.stderr}`);
}

const findings = diagnosticsRun.stdout
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line) as Finding);

const counts = Object.fromEntries(expectedRules.map((rule) => [rule, 0])) as Record<
  ExpectedRule,
  number
>;

for (const finding of findings) {
  if (!finding.file.endsWith("/src/index.ts")) {
    throw new Error(`Unexpected diagnostic outside src/index.ts: ${JSON.stringify(finding)}`);
  }

  if (finding.severity !== "error") {
    throw new Error(`Expected error severity: ${JSON.stringify(finding)}`);
  }

  if (finding.rule in counts) {
    counts[finding.rule as ExpectedRule] += 1;
  } else {
    throw new Error(`Unexpected Resultar rule: ${JSON.stringify(finding)}`);
  }
}

for (const rule of expectedRules) {
  if (counts[rule] !== expectedCounts[rule]) {
    throw new Error(
      `Expected ${expectedCounts[rule]} resultar/${rule} diagnostics, received ${counts[rule]}\n${diagnosticsRun.stdout}`,
    );
  }
}

const cleanRun = run("tsconfig.clean.json");

if (cleanRun.status !== 0) {
  throw new Error(`Expected the clean fixture to pass\n${cleanRun.stdout}${cleanRun.stderr}`);
}

const summary = expectedRules.map((rule) => `${rule}: ${counts[rule]}`).join(", ");

process.stdout.write(
  `Native resultar-check example passed (${findings.length} diagnostics across ${expectedRules.length} rules: ${summary}).\n`,
);
