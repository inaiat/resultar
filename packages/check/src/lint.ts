import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import * as ts from "./typescript-api.js";

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
  readonly ignoreFilePatterns?: readonly string[];
  readonly mode?: ResultarNoDiscardMode;
  readonly project?: string;
  readonly rootDir?: string;
}

export type { NoDiscardFinding, NoDiscardMode } from "./result-usage-core.js";

type NoDiscardFailure = { readonly error: Error; readonly ok: false };

interface OpenedProject {
  readonly close: () => void;
  readonly config: unknown;
  readonly program: ts.Program;
}

interface TypeScriptProjectDiagnostic {
  readonly code: number;
  readonly fileName?: string;
  readonly pos?: number;
  readonly text: string;
}

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

interface CliParseState {
  help: boolean;
  mode: ResultarNoDiscardMode | undefined;
  project: string | undefined;
  readonly tscArgs: string[];
}

type ParsedCliArgument =
  | { readonly consumed: 0; readonly kind: "help" }
  | { readonly consumed: 0 | 1; readonly kind: "mode"; readonly mode: ResultarNoDiscardMode }
  | {
      readonly consumed: 0 | 1;
      readonly forwarded: readonly string[];
      readonly kind: "project";
      readonly project: string;
    }
  | { readonly consumed: 0; readonly kind: "passthrough"; readonly value: string };

type ParsedCliArgumentResult =
  | NoDiscardFailure
  | { readonly argument: ParsedCliArgument; readonly ok: true };

const usage = `Usage: resultar-check

Flags:
  --mode <direct|must-use>  Check mode. Defaults to tsconfig plugin noDiscardMode or must-use.
  -p, --project <path>  TypeScript project file to inspect. Defaults to tsconfig.json.
  -h, --help            Show this help message.

Runs TypeScript 7 with no emit first, then all enabled Resultar rules from tsconfig plugin options.
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

  return requireFromRoot.resolve(specifier);
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

const resolveOptionalBundledPackage = (specifier: string): string | undefined => {
  try {
    return requireFromPackage.resolve(specifier);
  } catch {
    return undefined;
  }
};

const resolveTypeScript7PackageJson = (
  rootDir: string,
): NoDiscardFailure | { readonly ok: true; readonly packageJson: string } => {
  const candidates = [
    resolveOptionalPackage(rootDir, "typescript/package.json"),
    resolveOptionalBundledPackage("typescript/package.json"),
  ];

  for (const packageJson of candidates) {
    if (packageJson !== undefined && isTypeScript7Version(readPackageVersion(packageJson))) {
      return { ok: true, packageJson };
    }
  }

  return failure(
    new Error(
      "Unable to resolve TypeScript 7. Install typescript@7.0.2 in this project or reinstall resultar-check with its dependencies.",
    ),
  );
};

const parseModeValue = (
  value: string,
): NoDiscardFailure | { readonly mode: ResultarNoDiscardMode; readonly ok: true } =>
  value === "direct" || value === "must-use"
    ? { mode: value, ok: true }
    : cliError(`Unknown --mode value: ${value}`);

const parseModeArgument = (args: readonly string[], index: number): ParsedCliArgumentResult => {
  const value = args[index + 1];

  if (value === undefined || value === "") {
    return cliError("--mode requires direct or must-use");
  }

  const parsed = parseModeValue(value);

  return parsed.ok
    ? { argument: { consumed: 1, kind: "mode", mode: parsed.mode }, ok: true }
    : parsed;
};

const parseProjectArgument = (
  args: readonly string[],
  index: number,
  option: "--project" | "-p",
): ParsedCliArgumentResult => {
  const project = args[index + 1];

  return project === undefined || project === ""
    ? cliError(`${option} requires a path`)
    : {
        argument: { consumed: 1, forwarded: [option, project], kind: "project", project },
        ok: true,
      };
};

const parseCliArgument = (
  args: readonly string[],
  index: number,
  arg: string,
): ParsedCliArgumentResult => {
  if (arg === "--help" || arg === "-h") {
    return { argument: { consumed: 0, kind: "help" }, ok: true };
  }

  if (arg === "--mode") {
    return parseModeArgument(args, index);
  }

  if (arg.startsWith("--mode=")) {
    const parsed = parseModeValue(arg.slice("--mode=".length));

    return parsed.ok
      ? { argument: { consumed: 0, kind: "mode", mode: parsed.mode }, ok: true }
      : parsed;
  }

  if (arg === "--project" || arg === "-p") {
    return parseProjectArgument(args, index, arg);
  }

  if (arg.startsWith("--project=")) {
    const project = arg.slice("--project=".length);

    return project === ""
      ? cliError("--project requires a path")
      : { argument: { consumed: 0, forwarded: [arg], kind: "project", project }, ok: true };
  }

  return { argument: { consumed: 0, kind: "passthrough", value: arg }, ok: true };
};

const applyCliArgument = (
  state: CliParseState,
  argument: ParsedCliArgument,
  allowPassthrough: boolean,
): NoDiscardFailure | { readonly ok: true } => {
  switch (argument.kind) {
    case "help": {
      state.help = true;
      break;
    }
    case "mode": {
      state.mode = argument.mode;
      break;
    }
    case "project": {
      state.project = argument.project;
      state.tscArgs.push(...argument.forwarded);
      break;
    }
    case "passthrough": {
      if (!allowPassthrough) {
        return cliError(`Unknown argument: ${argument.value}`);
      }
      state.tscArgs.push(argument.value);
      break;
    }
    default: {
      const unreachable: never = argument;
      return unreachable;
    }
  }

  return { ok: true };
};

const parseCliOptions = (
  args: readonly string[],
  allowPassthrough: boolean,
): NoDiscardFailure | { readonly ok: true; readonly options: ResultarCheckCliOptions } => {
  const state: CliParseState = { help: false, mode: undefined, project: undefined, tscArgs: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined || arg === "") {
      continue;
    }

    const parsed = parseCliArgument(args, index, arg);

    if (!parsed.ok) {
      return parsed;
    }

    const applied = applyCliArgument(state, parsed.argument, allowPassthrough);

    if (!applied.ok) {
      return applied;
    }

    index += parsed.argument.consumed;
  }

  return {
    ok: true,
    options: {
      help: state.help,
      tscArgs: state.tscArgs,
      ...(state.mode === undefined ? {} : { mode: state.mode }),
      ...(state.project === undefined ? {} : { project: state.project }),
    },
  };
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const readProjectConfig = (
  projectPath: string,
): NoDiscardFailure | { readonly config: unknown; readonly ok: true } => {
  try {
    return { config: JSON.parse(readFileSync(projectPath, "utf8")) as unknown, ok: true };
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
};

const getLineAndColumn = (
  text: string,
  position: number,
): { readonly column: number; readonly line: number } => {
  const beforePosition = text.slice(0, position);
  const lines = beforePosition.split(/\r\n|\r|\n/u);
  const lastLine = lines.at(-1) ?? "";

  return { column: lastLine.length + 1, line: lines.length };
};

const formatProjectDiagnostic = (diagnostic: TypeScriptProjectDiagnostic): string => {
  const code = `TS${diagnostic.code}`;

  if (diagnostic.fileName === undefined || diagnostic.pos === undefined || diagnostic.pos < 0) {
    return `${code}: ${diagnostic.text}`;
  }

  try {
    const position = getLineAndColumn(readFileSync(diagnostic.fileName, "utf8"), diagnostic.pos);

    return `${diagnostic.fileName}:${position.line}:${position.column} - ${code}: ${diagnostic.text}`;
  } catch {
    return `${diagnostic.fileName} - ${code}: ${diagnostic.text}`;
  }
};

const getProjectNoDiscardOptions = (
  config: unknown,
): { readonly ignoreFilePatterns?: readonly string[]; readonly mode?: ResultarNoDiscardMode } => {
  if (!isRecord(config) || !isRecord(config.compilerOptions)) {
    return {};
  }

  const { plugins } = config.compilerOptions;

  if (!Array.isArray(plugins)) {
    return {};
  }

  const pluginConfig = findResultarPluginConfig(plugins);

  return pluginConfig === undefined
    ? {}
    : { ignoreFilePatterns: pluginConfig.ignoreFilePatterns, mode: pluginConfig.noDiscardMode };
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

const createProgramFacade = (project: ts.ApiProject): ts.Program => {
  const sourceFiles = project.program
    .getSourceFileNames()
    .map((fileName) => project.program.getSourceFile(fileName))
    .filter((sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined);

  return {
    getSourceFile: (fileName) => project.program.getSourceFile(fileName),
    getSourceFiles: () => sourceFiles,
    getTypeChecker: () => project.checker,
  };
};

const openProject = (
  rootDir: string,
  projectPath: string,
): NoDiscardFailure | { readonly ok: true; readonly project: OpenedProject } => {
  const api = new ts.API({ cwd: rootDir });

  try {
    api.parseConfigFile(projectPath);
    const snapshot = api.updateSnapshot({ openProjects: [projectPath] });
    const project =
      snapshot.getProject(projectPath) ??
      snapshot.getProjects().find((candidate) => resolve(candidate.configFileName) === projectPath);

    if (project === undefined) {
      api.close();

      return failure(new Error(`Unable to open TypeScript project: ${projectPath}`));
    }

    const configDiagnostics = project.program.getConfigFileParsingDiagnostics();

    if (configDiagnostics.length > 0) {
      api.close();

      return failure(
        new Error(
          configDiagnostics.map((diagnostic) => formatProjectDiagnostic(diagnostic)).join("\n"),
        ),
      );
    }

    const config = readProjectConfig(projectPath);

    if (!config.ok) {
      api.close();

      return config;
    }

    return {
      ok: true,
      project: {
        close: () => {
          api.close();
        },
        config: config.config,
        program: createProgramFacade(project),
      },
    };
  } catch (error) {
    api.close();

    return failure(error instanceof Error ? error : new Error(String(error)));
  }
};

export const findDiscardedResults = (options: NoDiscardOptions = {}): NoDiscardResult => {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const projectPath = resolve(rootDir, options.project ?? "tsconfig.json");
  const project = openProject(rootDir, projectPath);

  if (!project.ok) {
    return project;
  }

  try {
    const projectNoDiscardOptions = getProjectNoDiscardOptions(project.project.config);
    const findings = getProgramNoDiscardFindings(ts, project.project.program, {
      ignoreFilePatterns: options.ignoreFilePatterns ?? projectNoDiscardOptions.ignoreFilePatterns,
      mode: normalizeNoDiscardMode(options.mode ?? projectNoDiscardOptions.mode),
    });

    return success(findings);
  } finally {
    project.project.close();
  }
};

export const findResultarLintFindings = (options: ResultarLintOptions = {}): ResultarLintResult => {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const projectPath = resolve(rootDir, options.project ?? "tsconfig.json");
  const project = openProject(rootDir, projectPath);

  if (!project.ok) {
    return project;
  }

  try {
    const projectRuleOptions = getProjectRuleOptions(project.project.config);
    const findings = getProgramResultarFindings(ts, project.project.program, {
      ...projectRuleOptions,
      ...options.rules,
      ignoreFilePatterns:
        options.ignoreFilePatterns ??
        options.rules?.ignoreFilePatterns ??
        projectRuleOptions?.ignoreFilePatterns,
      noDiscardMode: normalizeNoDiscardMode(
        options.mode ?? options.rules?.noDiscardMode ?? projectRuleOptions?.noDiscardMode,
      ),
    });

    return success(findings);
  } finally {
    project.project.close();
  }
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
  const parsedArgs = parseCliOptions(args, false);

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

const withDefaultNoEmit = (args: readonly string[]): readonly string[] =>
  args.some((arg) => /^--noemit(?:=|$)/i.test(arg)) ? args : [...args, "--noEmit"];

const runNode = (script: string, args: readonly string[]): number => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });

  if (result.error !== undefined) {
    throw result.error;
  }

  return result.status ?? 1;
};

export const runResultarCheckCli = (args: readonly string[] = process.argv.slice(2)): number => {
  const rootDir = process.cwd();
  const parsedArgs = parseCliOptions(args, true);

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

  const skipResultarDiagnostics = shouldSkipResultarDiagnostics(args);
  const tscArgs = skipResultarDiagnostics
    ? parsedArgs.options.tscArgs
    : withDefaultNoEmit(parsedArgs.options.tscArgs);
  const tscStatus = runNode(join(dirname(resolvedTypeScript.packageJson), "bin/tsc"), tscArgs);

  if (tscStatus !== 0 || skipResultarDiagnostics) {
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
