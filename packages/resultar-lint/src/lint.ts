import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

import type * as ts from "typescript";

import type { ResultarLintFinding } from "./finding.js";
import {
  type NoDiscardFinding,
  type NoDiscardMode,
  getProgramNoDiscardFindings,
  normalizeNoDiscardMode,
} from "./result-usage-core.js";
import { type ResultarRulesOptions, getProgramResultarFindings } from "./rules-core.js";
import { findResultarPluginConfig } from "./plugin-options.js";

export interface NoDiscardOptions {
  readonly mode?: NoDiscardMode;
  readonly project?: string;
  readonly rootDir?: string;
}

export type { NoDiscardFinding, NoDiscardMode };

type TypeScriptApi = typeof ts;

type NoDiscardFailure = { readonly error: Error; readonly ok: false };

export type NoDiscardResult =
  | NoDiscardFailure
  | { readonly findings: readonly NoDiscardFinding[]; readonly ok: true };

export interface ResultarLintOptions extends NoDiscardOptions {
  readonly rules?: Partial<ResultarRulesOptions>;
}

export type ResultarLintResult =
  | NoDiscardFailure
  | { readonly findings: readonly ResultarLintFinding[]; readonly ok: true };

interface CliOptions extends NoDiscardOptions {
  readonly help: boolean;
}

const usage = `Usage: resultar-lint check [--project tsconfig.json]

Flags:
  --mode <direct|must-use>  Check mode. Defaults to tsconfig plugin noDiscardMode or must-use.
  -p, --project <path>  TypeScript project file to inspect. Defaults to tsconfig.json.
  -h, --help            Show this help message.

Runs all enabled Resultar rules from tsconfig plugin options. New rules default to warning diagnostics
in editors and still make the CLI exit non-zero when reported.
`;

const failure = (error: Error): NoDiscardFailure => ({ error, ok: false });
const success = <Finding extends ResultarLintFinding>(
  findings: readonly Finding[],
): { readonly findings: readonly Finding[]; readonly ok: true } => ({ findings, ok: true });

const cliError = (message: string): NoDiscardFailure => failure(new Error(message));
const requireFromPackage = createRequire(import.meta.url);

const parseArgs = (
  args: readonly string[],
): NoDiscardFailure | { readonly ok: true; readonly options: CliOptions } => {
  let mode: NoDiscardMode | undefined = undefined;
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

const getProjectNoDiscardMode = (config: unknown): NoDiscardMode | undefined => {
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
  rootDir: string,
): NoDiscardFailure | { readonly ok: true; readonly tsApi: TypeScriptApi } => {
  const requireFromRoot = createRequire(resolve(rootDir, "package.json"));

  try {
    return { ok: true, tsApi: requireFromRoot("typescript") as TypeScriptApi };
  } catch {
    try {
      return { ok: true, tsApi: requireFromPackage("typescript") as TypeScriptApi };
    } catch {
      return failure(
        new Error(
          "Unable to resolve TypeScript. Install typescript in this project or run resultar-lint check from a project with local TypeScript.",
        ),
      );
    }
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
