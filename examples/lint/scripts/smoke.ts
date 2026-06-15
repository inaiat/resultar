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

const runTsc = (expectFailure = false): CommandResult =>
  pnpm(["run", "check-ts"], {
    cwd: exampleDir,
    expectFailure,
  });

const runResultarLint = (expectFailure = false): CommandResult =>
  pnpm(["run", "lint:resultar"], {
    cwd: exampleDir,
    expectFailure,
  });

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
  "resultar/no-try-catch-in-safe-try",
  "resultar/yield-star-in-safe-try",
  "resultar/unsafe-result-type-assertion",
  "resultar/prefer-tagged-error",
  "resultar/tagged-error-name-match",
  "resultar/no-tagged-error-constructor-override",
  "resultar/no-useless-recovery",
] as const;

pnpm(["--filter", "resultar", "build"], { cwd: workspaceDir });
pnpm(["--filter", "resultar-lint", "build"], { cwd: workspaceDir });

const tscVersion = pnpm(["exec", "tsc", "--version"], { cwd: exampleDir });

if (!tscVersion.output.trim().startsWith("Version 6.")) {
  throw new Error(`Expected TypeScript 6.x in the language-service example\n${tscVersion.output}`);
}

try {
  pnpm(["exec", "resultar-lint", "unpatch"], {
    cwd: exampleDir,
  });

  runTsc();

  const lint = runResultarLint(true);
  assertIncludes(
    lint.output,
    "resultar/no-discard",
    "Expected lint-like command to report discarded Resultar values",
  );
  assertIncludes(
    lint.output,
    "assigned to `unhandled`",
    "Expected lint-like command to report must-use assignment diagnostics",
  );

  for (const rule of expectedRules) {
    assertIncludes(lint.output, rule, `Expected lint-like command to report ${rule}`);
  }
  assertExcludes(
    lint.output,
    "resultar-clean.ts",
    "Expected clean Resultar example file to have no lint diagnostics",
  );

  pnpm(["exec", "resultar-lint", "patch"], {
    cwd: exampleDir,
  });

  const secondPatch = pnpm(["exec", "resultar-lint", "patch"], { cwd: exampleDir });

  if (!secondPatch.output.includes("already patched")) {
    throw new Error(`Expected second patch to be a no-op\n${secondPatch.output}`);
  }

  const patchedTsc = runTsc(true);
  assertIncludes(
    patchedTsc.output,
    "[resultar/noDiscard]",
    "Patched TypeScript 6 tsc did not emit Resultar no-discard diagnostics",
  );
  for (const rule of expectedRules.filter((rule) => rule !== "resultar/no-discard")) {
    assertIncludes(
      patchedTsc.output,
      `[${rule}]`,
      `Patched TypeScript 6 tsc did not emit ${rule} diagnostics`,
    );
  }
  assertIncludes(
    patchedTsc.output,
    "assigned to `unhandled`",
    "Patched TypeScript 6 tsc did not emit Resultar must-use diagnostics",
  );
  assertExcludes(
    patchedTsc.output,
    "resultar-clean.ts",
    "Expected clean Resultar example file to have no patched tsc diagnostics",
  );
} finally {
  pnpm(["exec", "resultar-lint", "unpatch"], {
    cwd: exampleDir,
  });
}

runTsc();

process.stdout.write("Resultar language-service example smoke passed.\n");
