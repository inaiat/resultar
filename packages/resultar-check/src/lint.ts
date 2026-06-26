import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import type * as ts from "typescript";

import type { ResultarLintFinding } from "./finding.js";
import {
  getProgramNoDiscardFindings,
  type NoDiscardFinding as ResultarNoDiscardFinding,
  type NoDiscardMode as ResultarNoDiscardMode,
  normalizeNoDiscardMode,
} from "./result-usage-core.js";
import { type ResultarRulesOptions, getProgramResultarFindings } from "./rules-core.js";
import { findResultarPluginConfig } from "./plugin-options.js";

export interface NoDiscardOptions {
  readonly mode?: ResultarNoDiscardMode;
  readonly project?: string;
  readonly rootDir?: string;
}

export type { NoDiscardFinding, NoDiscardMode } from "./result-usage-core.js";

type TypeScriptApi = typeof ts;

type NoDiscardFailure = { readonly error: Error; readonly ok: false };

export type NoDiscardResult =
  | NoDiscardFailure
  | { readonly findings: readonly ResultarNoDiscardFinding[]; readonly ok: true };

export interface ResultarLintOptions extends NoDiscardOptions {
  readonly rules?: Partial<ResultarRulesOptions>;
}

export type ResultarLintResult =
  | NoDiscardFailure
  | { readonly findings: readonly ResultarLintFinding[]; readonly ok: true };

interface CliOptions extends NoDiscardOptions {
  readonly help: boolean;
}

interface ResultarCheckCliOptions extends CliOptions {
  readonly tscArgs: readonly string[];
}

const usage = `Usage: resultar-check -p tsconfig.json --noEmit

Flags:
  --mode <direct|must-use>  Check mode. Defaults to tsconfig plugin noDiscardMode or must-use.
  -p, --project <path>  TypeScript project file to inspect. Defaults to tsconfig.json.
  -h, --help            Show this help message.

Runs TypeScript 7 first, then all enabled Resultar rules from tsconfig plugin options.
`;

const failure = (error: Error): NoDiscardFailure => ({ error, ok: false });
const success = <Finding extends ResultarLintFinding>(
  findings: readonly Finding[],
): { readonly findings: readonly Finding[]; readonly ok: true } => ({ findings, ok: true });

const cliError = (message: string): NoDiscardFailure => failure(new Error(message));
const requireFromPackage = createRequire(import.meta.url);

const isTypeScript7Version = (version: string): boolean => version.startsWith("7.");

const resolvePackageFromRoot = (rootDir: string, specifier: string): string => {
  const requireFromRoot = createRequire(resolve(rootDir, "package.json"));

  try {
    return requireFromRoot.resolve(specifier);
  } catch {
    return requireFromPackage.resolve(specifier);
  }
};

const readPackageVersion = (packageJson: string): string => {
  const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as unknown;

  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new TypeError(`Unable to read package version from ${packageJson}`);
  }

  return parsed.version;
};

const resolveOptionalPackage = (rootDir: string, specifier: string): string | undefined => {
  try {
    return resolvePackageFromRoot(rootDir, specifier);
  } catch {
    return undefined;
  }
};

const resolveTypeScript7PackageJson = (
  rootDir: string,
): NoDiscardFailure | { readonly ok: true; readonly packageJson: string } => {
  const candidates = ["typescript/package.json", "typescript-7/package.json"];

  for (const candidate of candidates) {
    const packageJson = resolveOptionalPackage(rootDir, candidate);

    if (packageJson !== undefined && isTypeScript7Version(readPackageVersion(packageJson))) {
      return { ok: true, packageJson };
    }
  }

  return failure(
    new Error(
      "Unable to resolve TypeScript 7. Install typescript@rc or typescript-7@npm:typescript@rc in this project.",
    ),
  );
};

const parseArgs = (
  args: readonly string[],
): NoDiscardFailure | { readonly ok: true; readonly options: CliOptions } => {
  let mode: ResultarNoDiscardMode | undefined = undefined;
  let project: string | undefined = undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--project" || arg === "-p") {
      const nextArg = args[index + 1];

      if (nextArg === undefined || nextArg === "") {
        return cliError(`${arg} requires a path`);
      }

      project = nextArg;
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else if (arg === "--mode") {
      const nextArg = args[index + 1];

      if (nextArg === undefined || nextArg === "") {
        return cliError("--mode requires direct or must-use");
      }

      if (nextArg !== "direct" && nextArg !== "must-use") {
        return cliError(`Unknown --mode value: ${nextArg}`);
      }

      mode = nextArg;
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--mode=")) {
      const nextMode = arg.slice("--mode=".length);

      if (nextMode !== "direct" && nextMode !== "must-use") {
        return cliError(`Unknown --mode value: ${nextMode}`);
      }

      mode = nextMode;
    } else if (arg !== undefined && arg !== "") {
      return cliError(`Unknown argument: ${arg}`);
    }
  }

  if (project === "") {
    return cliError("--project requires a path");
  }

  return project === undefined
    ? { ok: true, options: mode === undefined ? { help } : { help, mode } }
    : { ok: true, options: mode === undefined ? { help, project } : { help, mode, project } };
};

const parseCheckArgs = (
  args: readonly string[],
): NoDiscardFailure | { readonly ok: true; readonly options: ResultarCheckCliOptions } => {
  let mode: ResultarNoDiscardMode | undefined = undefined;
  let project: string | undefined = undefined;
  let help = false;
  const tscArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined || arg === "") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--mode") {
      const nextArg = args[index + 1];

      if (nextArg === undefined || nextArg === "") {
        return cliError("--mode requires direct or must-use");
      }

      if (nextArg !== "direct" && nextArg !== "must-use") {
        return cliError(`Unknown --mode value: ${nextArg}`);
      }

      mode = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const nextMode = arg.slice("--mode=".length);

      if (nextMode !== "direct" && nextMode !== "must-use") {
        return cliError(`Unknown --mode value: ${nextMode}`);
      }

      mode = nextMode;
      continue;
    }

    if (arg === "--project" || arg === "-p") {
      const nextArg = args[index + 1];

      if (nextArg === undefined || nextArg === "") {
        return cliError(`${arg} requires a path`);
      }

      project = nextArg;
      tscArgs.push(arg, nextArg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    }

    tscArgs.push(arg);
  }

  if (project === "") {
    return cliError("--project requires a path");
  }

  if (project === undefined) {
    return { ok: true, options: mode === undefined ? { help, tscArgs } : { help, mode, tscArgs } };
  }

  return {
    ok: true,
    options: mode === undefined ? { help, project, tscArgs } : { help, mode, project, tscArgs },
  };
};

const readProject = (
  tsApi: TypeScriptApi,
  projectPath: string,
):
  | NoDiscardFailure
  | { readonly config: unknown; readonly ok: true; readonly parsed: ts.ParsedCommandLine } => {
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  };
  const config = tsApi.readConfigFile(projectPath, (fileName) => tsApi.sys.readFile(fileName));

  if (config.error) {
    return failure(
      new Error(tsApi.formatDiagnosticsWithColorAndContext([config.error], formatHost)),
    );
  }

  const parsed = tsApi.parseJsonConfigFileContent(
    config.config,
    tsApi.sys,
    resolve(projectPath, ".."),
    undefined,
    projectPath,
  );

  if (parsed.errors.length > 0) {
    return failure(
      new Error(tsApi.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost)),
    );
  }

  return { config: config.config, ok: true, parsed };
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const getProjectNoDiscardMode = (config: unknown): ResultarNoDiscardMode | undefined => {
  if (!isRecord(config) || !isRecord(config.compilerOptions)) {
    return undefined;
  }

  const { plugins } = config.compilerOptions;

  if (!Array.isArray(plugins)) {
    return undefined;
  }

  return findResultarPluginConfig(plugins)?.noDiscardMode;
};

const getProjectRuleOptions = (config: unknown): Partial<ResultarRulesOptions> | undefined => {
  if (!isRecord(config) || !isRecord(config.compilerOptions)) {
    return undefined;
  }

  const { plugins } = config.compilerOptions;

  if (!Array.isArray(plugins)) {
    return undefined;
  }

  return findResultarPluginConfig(plugins);
};

const resolveTypeScriptApi = (
  _rootDir: string,
): NoDiscardFailure | { readonly ok: true; readonly tsApi: TypeScriptApi } => {
  try {
    return { ok: true, tsApi: requireFromPackage("typescript") as TypeScriptApi };
  } catch {
    return failure(
      new Error(
        "Unable to resolve the internal TypeScript diagnostics API bundled with resultar-check.",
      ),
    );
  }
};

export const findDiscardedResults = (options: NoDiscardOptions = {}): NoDiscardResult => {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const projectPath = resolve(rootDir, options.project ?? "tsconfig.json");
  const resolvedTypeScript = resolveTypeScriptApi(rootDir);

  if (!resolvedTypeScript.ok) {
    return resolvedTypeScript;
  }

  const { tsApi } = resolvedTypeScript;
  const project = readProject(tsApi, projectPath);

  if (!project.ok) {
    return project;
  }

  const program = tsApi.createProgram(project.parsed.fileNames, project.parsed.options);
  const findings = getProgramNoDiscardFindings(tsApi, program, {
    mode: normalizeNoDiscardMode(options.mode ?? getProjectNoDiscardMode(project.config)),
  });

  return success(findings);
};

export const findResultarLintFindings = (options: ResultarLintOptions = {}): ResultarLintResult => {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const projectPath = resolve(rootDir, options.project ?? "tsconfig.json");
  const resolvedTypeScript = resolveTypeScriptApi(rootDir);

  if (!resolvedTypeScript.ok) {
    return resolvedTypeScript;
  }

  const { tsApi } = resolvedTypeScript;
  const project = readProject(tsApi, projectPath);

  if (!project.ok) {
    return project;
  }

  const projectRuleOptions = getProjectRuleOptions(project.config);
  const program = tsApi.createProgram(project.parsed.fileNames, project.parsed.options);
  const findings = getProgramResultarFindings(tsApi, program, {
    ...projectRuleOptions,
    ...options.rules,
    noDiscardMode: normalizeNoDiscardMode(
      options.mode ?? options.rules?.noDiscardMode ?? projectRuleOptions?.noDiscardMode,
    ),
  });

  return success(findings);
};

const formatFinding = (finding: ResultarLintFinding, rootDir: string): string => {
  const file = relative(rootDir, finding.file);

  return [
    `${file}:${finding.line}:${finding.column} resultar/${finding.rule}`,
    finding.message,
  ].join(" - ");
};

export const runResultarLintCli = (args: readonly string[] = process.argv.slice(2)): number => {
  const rootDir = process.cwd();
  const parsedArgs = parseArgs(args);

  if (!parsedArgs.ok) {
    process.stderr.write(`${parsedArgs.error.message}\n`);
    return 1;
  }

  if (parsedArgs.options.help) {
    process.stdout.write(usage);
    return 0;
  }

  const result =
    parsedArgs.options.project === undefined
      ? findResultarLintFindings({ mode: parsedArgs.options.mode, rootDir })
      : findResultarLintFindings({
          mode: parsedArgs.options.mode,
          project: parsedArgs.options.project,
          rootDir,
        });

  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }

  if (result.findings.length === 0) {
    return 0;
  }

  process.stderr.write(
    `${result.findings.map((finding) => formatFinding(finding, rootDir)).join("\n")}\n`,
  );

  return 1;
};

const passthroughArgs = new Set(["--version", "-v"]);

const shouldSkipResultarDiagnostics = (args: readonly string[]): boolean =>
  args.some((arg) => passthroughArgs.has(arg));

const runNode = (script: string, args: readonly string[]): number => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });

  if (result.error !== undefined) {
    throw result.error;
  }

  return result.status ?? 1;
};

export const runResultarCheckCli = (args: readonly string[] = process.argv.slice(2)): number => {
  const rootDir = process.cwd();
  const parsedArgs = parseCheckArgs(args);

  if (!parsedArgs.ok) {
    process.stderr.write(`${parsedArgs.error.message}\n`);
    return 1;
  }

  if (parsedArgs.options.help) {
    process.stdout.write(usage);
    return 0;
  }

  const resolvedTypeScript = resolveTypeScript7PackageJson(rootDir);

  if (!resolvedTypeScript.ok) {
    process.stderr.write(`${resolvedTypeScript.error.message}\n`);
    return 1;
  }

  const tscStatus = runNode(join(dirname(resolvedTypeScript.packageJson), "bin/tsc"), [
    ...parsedArgs.options.tscArgs,
  ]);

  if (tscStatus !== 0 || shouldSkipResultarDiagnostics(args)) {
    return tscStatus;
  }

  const result =
    parsedArgs.options.project === undefined
      ? findResultarLintFindings({ mode: parsedArgs.options.mode, rootDir })
      : findResultarLintFindings({
          mode: parsedArgs.options.mode,
          project: parsedArgs.options.project,
          rootDir,
        });

  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }

  if (result.findings.length === 0) {
    return 0;
  }

  process.stderr.write(
    `${result.findings.map((finding) => formatFinding(finding, rootDir)).join("\n")}\n`,
  );

  return 1;
};
