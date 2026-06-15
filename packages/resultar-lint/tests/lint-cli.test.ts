import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejects, equal, match, ok } from "node:assert";

import { afterEach, describe, it } from "vite-plus/test";
import * as ts from "typescript";

import {
  getNoDiscardDiagnostics,
  getProgramNoDiscardDiagnostics,
  getResultarDiagnostics,
} from "../src/diagnostics.js";
import { findResultarPluginConfig, parsePluginOptions } from "../src/plugin-options.js";
import {
  getTypeScriptPatchStatus,
  patchTypeScriptPackage,
  unpatchTypeScriptPackage,
} from "../src/patch.js";
import { findDiscardedResults, findResultarLintFindings, runResultarLintCli } from "../src/lint.js";
import {
  defaultResultarRulesOptions,
  normalizeResultarRulesOptions,
  normalizeRuleSeverity,
} from "../src/rules-core.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

const createTempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "resultar-lint-test-"));
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

const createFakeTypeScriptPackage = async (version?: string, moduleSource?: string) => {
  const dir = await createTempDir();
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(version === undefined ? {} : { version }),
  );

  if (moduleSource !== undefined) {
    await Promise.all([
      writeFile(join(dir, "lib/_tsc.js"), moduleSource),
      writeFile(join(dir, "lib/typescript.js"), moduleSource),
    ]);
  }

  return dir;
};

describe("lint CLI and integration edges", () => {
  it("normalizes plugin options and rule severities", () => {
    equal(normalizeRuleSeverity("warning", "error"), "warning");
    equal(normalizeRuleSeverity("suggestion", "error"), "suggestion");
    equal(normalizeRuleSeverity("message", "error"), "message");
    equal(normalizeRuleSeverity("off", "error"), "off");
    equal(normalizeRuleSeverity(false, "warning"), "warning");

    const parsed = parsePluginOptions({
      noDiscard: "off",
      noDiscardMode: "direct",
      preferTaggedError: "suggestion",
      typedCatchMapper: "message",
    });

    equal(parsed.noDiscard, "off");
    equal(parsed.noDiscardMode, "direct");
    equal(parsed.preferTaggedError, "suggestion");
    equal(parsed.typedCatchMapper, "message");

    const fallback = parsePluginOptions("not an object");
    equal(fallback.noDiscard, defaultResultarRulesOptions.noDiscard);

    const normalized = normalizeResultarRulesOptions({
      noDiscard: "off",
      preferMapErr: "suggestion",
    });
    equal(normalized.noDiscard, "off");
    equal(normalized.preferMapErr, "suggestion");

    const config = findResultarPluginConfig([
      { name: "other-plugin", noDiscard: false },
      { name: "resultar-lint", noDiscardMode: "direct" },
    ]);
    equal(config?.noDiscardMode, "direct");
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
    match(help.stdout, /resultar-lint check/);

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

  it("rejects unsupported and malformed TypeScript patch targets", async () => {
    const localStatus = await getTypeScriptPatchStatus();

    ok(localStatus.typescriptVersion.startsWith("6."));
    equal(localStatus.modules.length, 2);

    const unsupported = await createFakeTypeScriptPackage("5.9.0");
    await rejects(patchTypeScriptPackage({ dir: unsupported }), /supports TypeScript 6/);

    const missingVersion = await createFakeTypeScriptPackage();
    await rejects(
      getTypeScriptPatchStatus({ dir: missingVersion }),
      /Unable to read TypeScript version/,
    );

    const missingModules = await createFakeTypeScriptPackage("6.0.0");
    await rejects(getTypeScriptPatchStatus({ dir: missingModules }), /lib\/_tsc\.js|ENOENT/);

    const missingNeedle = await createFakeTypeScriptPackage("6.0.0", "const ts = {}\n");
    await rejects(
      patchTypeScriptPackage({ dir: missingNeedle }),
      /Unable to find TypeScript diagnostics insertion point/,
    );

    const malformedPatch = await createFakeTypeScriptPackage(
      "6.0.0",
      [
        "/* resultar-lint-patch:start call */",
        "  const diagnostics = sortAndDeduplicateDiagnostics(allDiagnostics);",
        "",
      ].join("\n"),
    );
    await rejects(
      patchTypeScriptPackage({ dir: malformedPatch }),
      /without \/\* resultar-lint-patch:end call \*\//,
    );
  });

  it("unpatches CRLF patch blocks from TypeScript module files", async () => {
    const patchedSource = [
      "/* resultar-lint-patch:start call */",
      "  addRange(allDiagnostics, resultarLanguageServiceDiagnostics(program));",
      "/* resultar-lint-patch:end call */",
      "  const diagnostics = sortAndDeduplicateDiagnostics(allDiagnostics);",
      "/* resultar-lint-patch:start helper */",
      "/* resultar-lint-patch:version 3 */",
      "function resultarLanguageServiceDiagnostics() { return []; }",
      "/* resultar-lint-patch:end helper */",
      "",
    ].join("\r\n");
    const dir = await createFakeTypeScriptPackage("6.0.0", patchedSource);
    const result = await unpatchTypeScriptPackage({ dir });

    equal(result.typescriptVersion, "6.0.0");
    equal(result.modules.length, 2);
    equal(
      result.modules.every((moduleStatus) => moduleStatus.changed),
      true,
    );
  });
});
