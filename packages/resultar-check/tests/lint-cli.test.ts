import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert";

import { afterEach, describe, it } from "vite-plus/test";
import * as ts from "typescript";

import {
  getNoDiscardDiagnostics,
  getProgramNoDiscardDiagnostics,
  getResultarDiagnostics,
} from "../src/diagnostics.js";
import { findResultarPluginConfig, parsePluginOptions } from "../src/plugin-options.js";
import { findDiscardedResults, findResultarLintFindings, runResultarLintCli } from "../src/lint.js";
import {
  defaultResultarRulesOptions,
  normalizeNoUnsafeAwaitIgnoreCalls,
  normalizeNoUnsafeAwaitMode,
  normalizeResultarRulesOptions,
  normalizeRuleSeverity,
} from "../src/rules-core.js";
import { isIgnoredFileName, normalizeIgnoreFilePatterns } from "../src/source-files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

const createTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "resultar-check-test-"));
  tempDirs.push(dir);
  return dir;
};

const createFixtureProject = async (
  source: string,
  options: { fileName?: string; plugins?: readonly Record<string, unknown>[] } = {},
) => {
  const rootDir = await createTempDir();
  const fileName = options.fileName ?? "fixture.ts";
  const filePath = join(rootDir, fileName);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, source);
  await writeFile(
    join(rootDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          plugins: options.plugins ?? [],
          strict: true,
          target: "ES2022",
        },
        include: [fileName],
      },
      undefined,
      2,
    ),
  );
  return rootDir;
};

const createProgram = (rootDir: string) => {
  const configPath = join(rootDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (config.error) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext([config.error], diagnosticHost(rootDir)),
    );
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootDir);
  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost(rootDir)),
    );
  }

  return ts.createProgram({ options: parsed.options, rootNames: parsed.fileNames });
};

const diagnosticHost = (rootDir: string): ts.FormatDiagnosticsHost => ({
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => rootDir,
  getNewLine: () => "\n",
});

const getFixtureSourceFile = (program: ts.Program) => {
  const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith("fixture.ts"));

  ok(sourceFile, "Expected fixture.ts to be part of the program");
  return sourceFile;
};

const runCli = (args: readonly string[], cwd: string) => {
  const previousCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    return { status: runResultarLintCli(args), stderr, stdout };
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
    process.chdir(previousCwd);
  }
};

describe("lint CLI and integration edges", () => {
  it("normalizes plugin options and rule severities", () => {
    equal(normalizeRuleSeverity("warning", "error"), "warning");
    equal(normalizeRuleSeverity("suggestion", "error"), "suggestion");
    equal(normalizeRuleSeverity("message", "error"), "message");
    equal(normalizeRuleSeverity("off", "error"), "off");
    equal(normalizeRuleSeverity(false, "warning"), "warning");
    equal(normalizeNoUnsafeAwaitMode("all"), "all");
    equal(normalizeNoUnsafeAwaitMode("resultar-context"), "resultar-context");
    equal(normalizeNoUnsafeAwaitMode(false), defaultResultarRulesOptions.noUnsafeAwaitMode);
    deepEqual(
      normalizeNoUnsafeAwaitIgnoreCalls(["startServer", "fastify.after", "invalid path", 1]),
      ["startServer", "fastify.after"],
    );
    deepEqual(normalizeNoUnsafeAwaitIgnoreCalls("fastify.after"), []);
    deepEqual(normalizeIgnoreFilePatterns(["*.test.ts", "tests/**", "", 1]), [
      "*.test.ts",
      "tests/**",
    ]);
    deepEqual(normalizeIgnoreFilePatterns("*.spec.ts"), ["*.spec.ts"]);
    equal(isIgnoredFileName("/workspace/src/user.test.ts", ["*.test.ts"]), true);
    equal(isIgnoredFileName("/workspace/tests/user.ts", ["tests/**"]), true);
    equal(isIgnoredFileName("/workspace/src/user.ts", ["*.test.ts"]), false);

    const parsed = parsePluginOptions({
      ignoreFilePatterns: ["*.test.ts"],
      noDiscard: "off",
      noDiscardMode: "direct",
      noUnsafeAwaitIgnoreCalls: ["startServer", "fastify.after"],
      noUnsafeAwaitMode: "all",
      preferTaggedError: "suggestion",
      typedCatchMapper: "message",
    });

    deepEqual(parsed.ignoreFilePatterns, ["*.test.ts"]);
    equal(parsed.noDiscard, "off");
    equal(parsed.noDiscardMode, "direct");
    deepEqual(parsed.noUnsafeAwaitIgnoreCalls, ["startServer", "fastify.after"]);
    equal(parsed.noUnsafeAwaitMode, "all");
    equal(parsed.preferTaggedError, "suggestion");
    equal(parsed.typedCatchMapper, "message");

    const fallback = parsePluginOptions("not an object");
    equal(fallback.noDiscard, defaultResultarRulesOptions.noDiscard);

    const normalized = normalizeResultarRulesOptions({
      ignoreFilePatterns: ["*.test.ts"],
      noDiscard: "off",
      noUnsafeAwaitIgnoreCalls: ["startServer", "fastify.after"],
      noUnsafeAwaitMode: "all",
      preferMapErr: "suggestion",
    });
    deepEqual(normalized.ignoreFilePatterns, ["*.test.ts"]);
    equal(normalized.noDiscard, "off");
    deepEqual(normalized.noUnsafeAwaitIgnoreCalls, ["startServer", "fastify.after"]);
    equal(normalized.noUnsafeAwaitMode, "all");
    equal(normalized.preferMapErr, "suggestion");

    const config = findResultarPluginConfig([
      { name: "other-plugin", noDiscard: false },
      { name: "resultar-check", noDiscardMode: "direct" },
    ]);
    equal(config?.noDiscardMode, "direct");

    const legacyConfig = findResultarPluginConfig([
      { name: "resultar-lint", noDiscardMode: "direct" },
    ]);
    equal(legacyConfig?.noDiscardMode, "direct");
  });

  it("maps diagnostics severities and skips external source files", async () => {
    const rootDir = await createFixtureProject(`
type Result<T, E> = { value?: T; error?: E }
declare function saveUser(): Result<string, Error>
saveUser()
`);
    const program = createProgram(rootDir);
    const sourceFile = getFixtureSourceFile(program);

    const messageDiagnostics = getNoDiscardDiagnostics({
      options: { noDiscard: "message" },
      program,
      sourceFile,
      tsApi: ts,
    });
    equal(messageDiagnostics[0]?.category, ts.DiagnosticCategory.Message);

    const suggestionDiagnostics = getResultarDiagnostics({
      options: { noDiscard: "suggestion" },
      program,
      sourceFile,
      tsApi: ts,
    });
    equal(suggestionDiagnostics[0]?.category, ts.DiagnosticCategory.Suggestion);

    const warningDiagnostics = getProgramNoDiscardDiagnostics(ts, program, {
      noDiscard: "warning",
    });
    equal(warningDiagnostics[0]?.category, ts.DiagnosticCategory.Warning);

    const externalRoot = await createFixtureProject(
      `
type Result<T, E> = { value?: T; error?: E }
declare function saveUser(): Result<string, Error>
saveUser()
`,
      { fileName: "node_modules/pkg/fixture.ts" },
    );
    const externalProgram = createProgram(externalRoot);
    const externalSourceFile = getFixtureSourceFile(externalProgram);
    equal(
      getResultarDiagnostics({
        program: externalProgram,
        sourceFile: externalSourceFile,
        tsApi: ts,
      }).length,
      0,
    );
  });

  it("runs the CLI for help, argument errors, passing files, and failing findings", async () => {
    const cleanRoot = await createFixtureProject("const value = 1\n");

    const help = runCli(["--help"], cleanRoot);
    equal(help.status, 0);
    match(help.stdout, /Usage: resultar-check/);

    const removedCheckSubcommand = runCli(["check"], cleanRoot);
    equal(removedCheckSubcommand.status, 1);
    match(removedCheckSubcommand.stderr, /Unknown argument: check/);

    const unknown = runCli(["--unknown"], cleanRoot);
    equal(unknown.status, 1);
    match(unknown.stderr, /Unknown argument/);

    const missingProject = runCli(["--project"], cleanRoot);
    equal(missingProject.status, 1);
    match(missingProject.stderr, /--project requires a path/);

    const passing = runCli([], cleanRoot);
    equal(passing.status, 0);
    equal(passing.stdout, "");

    const failingRoot = await createFixtureProject(`
type Result<T, E> = { value?: T; error?: E }
declare function saveUser(): Result<string, Error>
saveUser()
`);
    const failing = runCli(["--project", "tsconfig.json"], failingRoot);
    equal(failing.status, 1);
    match(failing.stderr, /resultar\/no-discard/);
  });

  it("handles additional CLI flag forms", async () => {
    const cleanRoot = await createFixtureProject("const value = 1\n");

    equal(runCli(["--project=tsconfig.json"], cleanRoot).status, 0);
    equal(runCli(["--project=tsconfig.json", "--mode=direct"], cleanRoot).status, 0);
    equal(runCli(["--mode", "direct"], cleanRoot).status, 0);
    equal(runCli(["--mode=must-use"], cleanRoot).status, 0);

    const missingMode = runCli(["--mode"], cleanRoot);
    equal(missingMode.status, 1);
    match(missingMode.stderr, /--mode requires direct or must-use/);

    const invalidMode = runCli(["--mode", "async"], cleanRoot);
    equal(invalidMode.status, 1);
    match(invalidMode.stderr, /Unknown --mode value: async/);

    const invalidEqualsMode = runCli(["--mode=async"], cleanRoot);
    equal(invalidEqualsMode.status, 1);
    match(invalidEqualsMode.stderr, /Unknown --mode value: async/);

    const emptyProject = runCli(["--project="], cleanRoot);
    equal(emptyProject.status, 1);
    match(emptyProject.stderr, /--project requires a path/);
  });

  it("handles projects without compilerOptions plugin config", async () => {
    const rootDir = await createTempDir();
    await writeFile(
      join(rootDir, "fixture.ts"),
      `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare function saveUser(): Result<string, Error>
saveUser()
`,
    );
    await writeFile(join(rootDir, "tsconfig.json"), JSON.stringify({ files: ["fixture.ts"] }));

    const noDiscard = findDiscardedResults({ rootDir });
    const allRules = findResultarLintFindings({ rootDir });

    if (!noDiscard.ok) {
      throw noDiscard.error;
    }

    if (!allRules.ok) {
      throw allRules.error;
    }

    equal(noDiscard.findings.length, 1);
    equal(allRules.findings.length, 1);
  });

  it("ignores files matching configured ignoreFilePatterns", async () => {
    const rootDir = await createTempDir();
    const source = `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare function saveUser(): Result<string, Error>
saveUser()
`;

    await writeFile(join(rootDir, "fixture.ts"), source);
    await writeFile(join(rootDir, "fixture.test.ts"), source);
    await writeFile(
      join(rootDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            plugins: [{ name: "resultar-check", ignoreFilePatterns: ["*.test.ts"] }],
            strict: true,
            target: "ES2022",
          },
          include: ["*.ts"],
        },
        undefined,
        2,
      ),
    );

    const noDiscard = findDiscardedResults({ rootDir });
    const allRules = findResultarLintFindings({ rootDir });

    if (!noDiscard.ok) {
      throw noDiscard.error;
    }

    if (!allRules.ok) {
      throw allRules.error;
    }

    deepEqual(
      noDiscard.findings.map((finding) => finding.file.replaceAll("\\", "/").split("/").at(-1)),
      ["fixture.ts"],
    );
    deepEqual(
      allRules.findings.map((finding) => finding.file.replaceAll("\\", "/").split("/").at(-1)),
      ["fixture.ts"],
    );

    const cli = runCli([], rootDir);
    equal(cli.status, 1);
    match(cli.stderr, /fixture\.ts/);
    doesNotMatch(cli.stderr, /fixture\.test\.ts/);
  });

  it("surfaces TypeScript project semantic config errors", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "fixture.ts"), "const value = 1\n");
    await writeFile(
      join(rootDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "DefinitelyNotAModuleKind" },
        files: ["fixture.ts"],
      }),
    );

    const noDiscard = findDiscardedResults({ rootDir });

    equal(noDiscard.ok, false);
    if (!noDiscard.ok) {
      match(noDiscard.error.message, /module/);
    }
  });

  it("surfaces TypeScript project parse errors from the CLI", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "tsconfig.json"), "{");

    const result = runCli([], rootDir);
    equal(result.status, 1);
    match(result.stderr, /TS1005/);
  });
});
