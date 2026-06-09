#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

import type * as ts from "typescript";

type TypeScriptApi = typeof ts;

const resultTypeMatcher =
  /\b(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)\b/;

export interface NoDiscardFinding {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly type: string;
}

export interface NoDiscardOptions {
  readonly project?: string;
  readonly rootDir?: string;
}

type NoDiscardFailure = { readonly error: Error; readonly ok: false };

export type NoDiscardResult =
  | NoDiscardFailure
  | { readonly findings: readonly NoDiscardFinding[]; readonly ok: true };

interface CliOptions extends NoDiscardOptions {
  readonly help: boolean;
}

const usage = `Usage: resultar-no-discard [--project tsconfig.json]

Flags:
  -p, --project <path>  TypeScript project file to inspect. Defaults to tsconfig.json.
  -h, --help            Show this help message.
`;

const failure = (error: Error): NoDiscardFailure => ({ error, ok: false });
const success = (findings: readonly NoDiscardFinding[]): NoDiscardResult => ({
  findings,
  ok: true,
});

const cliError = (message: string): NoDiscardFailure => failure(new Error(message));
const requireFromPackage = createRequire(__filename);

const parseArgs = (
  args: readonly string[],
): NoDiscardFailure | { readonly ok: true; readonly options: CliOptions } => {
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
    } else if (arg !== undefined && arg !== "") {
      return cliError(`Unknown argument: ${arg}`);
    }
  }

  if (project === "") {
    return cliError("--project requires a path");
  }

  return project === undefined
    ? { ok: true, options: { help } }
    : { ok: true, options: { help, project } };
};

const readProject = (
  tsApi: TypeScriptApi,
  projectPath: string,
): NoDiscardFailure | { readonly ok: true; readonly parsed: ts.ParsedCommandLine } => {
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

  return { ok: true, parsed };
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
          "Unable to resolve TypeScript. Install typescript in this project or run resultar-no-discard from a project with local TypeScript.",
        ),
      );
    }
  }
};

const isResultLikeType = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  node: ts.Node,
  type: ts.Type,
): boolean => {
  if (type.isUnionOrIntersection()) {
    return type.types.some((innerType) => isResultLikeType(tsApi, checker, node, innerType));
  }

  const typeName = checker.typeToString(
    type,
    node,
    tsApi.TypeFormatFlags.NoTruncation + tsApi.TypeFormatFlags.UseFullyQualifiedType,
  );

  return resultTypeMatcher.test(typeName);
};

const unwrapExpression = (tsApi: TypeScriptApi, expression: ts.Expression): ts.Expression => {
  let current = expression;

  while (tsApi.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
};

const isExplicitDiscard = (tsApi: TypeScriptApi, expression: ts.Expression): boolean =>
  tsApi.isVoidExpression(unwrapExpression(tsApi, expression));

const isCallLikeDiscard = (tsApi: TypeScriptApi, expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(tsApi, expression);

  if (tsApi.isAwaitExpression(unwrapped)) {
    return isCallLikeDiscard(tsApi, unwrapped.expression);
  }

  if (tsApi.isCallExpression(unwrapped)) {
    return true;
  }

  if (tsApi.isConditionalExpression(unwrapped)) {
    return (
      isCallLikeDiscard(tsApi, unwrapped.whenTrue) || isCallLikeDiscard(tsApi, unwrapped.whenFalse)
    );
  }

  if (
    tsApi.isBinaryExpression(unwrapped) &&
    [
      tsApi.SyntaxKind.AmpersandAmpersandToken,
      tsApi.SyntaxKind.BarBarToken,
      tsApi.SyntaxKind.QuestionQuestionToken,
    ].includes(unwrapped.operatorToken.kind)
  ) {
    return isCallLikeDiscard(tsApi, unwrapped.right);
  }

  return false;
};

const inspectSourceFile = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly NoDiscardFinding[] => {
  const findings: NoDiscardFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (
      tsApi.isExpressionStatement(node) &&
      !isExplicitDiscard(tsApi, node.expression) &&
      isCallLikeDiscard(tsApi, node.expression)
    ) {
      const type = checker.getTypeAtLocation(node.expression);

      if (isResultLikeType(tsApi, checker, node.expression, type)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart());
        findings.push({
          column: position.character + 1,
          file: sourceFile.fileName,
          line: position.line + 1,
          type: checker.typeToString(type, node.expression, tsApi.TypeFormatFlags.NoTruncation),
        });
      }
    }

    tsApi.forEachChild(node, visit);
  };

  visit(sourceFile);

  return findings;
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
  const checker = program.getTypeChecker();
  const findings: NoDiscardFinding[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile && !sourceFile.fileName.includes("/node_modules/")) {
      findings.push(...inspectSourceFile(tsApi, checker, sourceFile));
    }
  }

  return success(findings);
};

const formatFinding = (finding: NoDiscardFinding, rootDir: string): string => {
  const file = relative(rootDir, finding.file);

  return [
    `${file}:${finding.line}:${finding.column} no-discard-result`,
    `Ignored ${finding.type} value. Handle it or explicitly discard it with \`void\`.`,
  ].join(" - ");
};

export const runNoDiscardCli = (args: readonly string[] = process.argv.slice(2)): number => {
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
      ? findDiscardedResults({ rootDir })
      : findDiscardedResults({ project: parsedArgs.options.project, rootDir });

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

const isCliEntrypoint = (): boolean => {
  const entrypoint = process.argv[1];

  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypoint) === realpathSync(__filename);
  } catch {
    return false;
  }
};

if (isCliEntrypoint()) {
  process.exitCode = runNoDiscardCli();
}
