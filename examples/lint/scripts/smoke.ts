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
  "resultar/no-discard",
  "resultar/prefer-map-err",
  "resultar/prefer-and-then",
  "resultar/typed-catch-mapper",
  "resultar/no-unsafe-await",
  "resultar/no-try-catch-in-safe-try",
  "resultar/yield-star-in-safe-try",
  "resultar/unsafe-result-type-assertion",
  "resultar/prefer-tagged-error",
  "resultar/tagged-error-name-match",
  "resultar/no-tagged-error-constructor-override",
  "resultar/no-useless-recovery",
] as const;

pnpm(["--filter", "resultar", "build"], { cwd: workspaceDir });
pnpm(["--filter", "resultar-check", "build"], { cwd: workspaceDir });

const version = pnpm(["exec", "resultar-check", "--version"], { cwd: exampleDir });

if (!/Version 7\.0\./.test(version.output)) {
  throw new Error(`Expected resultar-check to use TypeScript 7\n${version.output}`);
}

const lint = pnpm(["run", "check"], { cwd: exampleDir, expectFailure: true });

assertIncludes(
  lint.output,
  "resultar/no-discard",
  "Expected check command to report discarded Resultar values",
);
assertIncludes(
  lint.output,
  "assigned to `unhandled`",
  "Expected check command to report must-use assignment diagnostics",
);
assertIncludes(
  lint.output,
  "throwing `new Error(...)`",
  "Expected check command to report thrown native Error diagnostics",
);
assertIncludes(
  lint.output,
  "raw Promise boundary",
  "Expected check command to report Resultar async unwrapping in raw Promise boundaries",
);

for (const rule of expectedRules) {
  assertIncludes(lint.output, rule, `Expected check command to report ${rule}`);
}

assertExcludes(
  lint.output,
  "resultar-clean.ts",
  "Expected clean Resultar example file to have no diagnostics",
);

process.stdout.write("Resultar lint TS7 example smoke passed.\n");
