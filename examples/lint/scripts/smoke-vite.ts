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
  "no-discard",
  "prefer-map-err",
  "prefer-and-then",
  "typed-catch-mapper",
  "no-try-catch-in-safe-try",
  "yield-star-in-safe-try",
  "unsafe-result-type-assertion",
  "prefer-tagged-error",
  "tagged-error-name-match",
  "no-tagged-error-constructor-override",
  "no-useless-recovery",
] as const;

pnpm(["--filter", "resultar", "build"], { cwd: workspaceDir });
pnpm(["--filter", "resultar-lint", "build"], { cwd: workspaceDir });

const check = pnpm(["run", "check:vite-rules"], { cwd: exampleDir, expectFailure: true });

for (const rule of expectedRules) {
  assertIncludes(
    check.output,
    `resultar(${rule})`,
    `Expected Vite+ Oxlint output to include the Resultar ${rule} rule id`,
  );
}

assertIncludes(
  check.output,
  "Ignored Result",
  "Expected Vite+ Oxlint output to report the ignored Result value",
);
assertIncludes(
  check.output,
  "Ignored ResultAsync",
  "Expected Vite+ Oxlint output to report the ignored ResultAsync value",
);
assertIncludes(
  check.output,
  "assigned to `unhandled`",
  "Expected Vite+ Oxlint output to report the must-use assignment diagnostic",
);
assertExcludes(
  check.output,
  "resultar-clean.ts",
  "Expected clean Resultar example file to have no Vite+ diagnostics",
);

process.stdout.write("Resultar Vite+ example smoke passed.\n");
