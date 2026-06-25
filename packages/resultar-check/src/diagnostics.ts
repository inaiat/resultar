import type * as ts from "typescript";

import type { ResultarLintFinding, ResultarRuleName, ResultarRuleSeverity } from "./finding.js";
import {
  type ResultarRulesOptions,
  getSourceFileResultarFindings,
  normalizeResultarRulesOptions,
  onlyResultarRule,
} from "./rules-core.js";

export const RESULTAR_DIAGNOSTIC_SOURCE = "resultar";
export const RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE = 91_001;
export const RESULTAR_RULE_DIAGNOSTIC_CODES: Record<ResultarRuleName, number> = {
  "no-discard": RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE,
  "no-tagged-error-constructor-override": 91_010,
  "no-try-catch-in-safe-try": 91_006,
  "no-unsafe-await": 91_012,
  "no-useless-recovery": 91_011,
  "prefer-and-then": 91_003,
  "prefer-map-err": 91_002,
  "prefer-tagged-error": 91_008,
  "tagged-error-name-match": 91_009,
  "typed-catch-mapper": 91_004,
  "unsafe-result-type-assertion": 91_007,
  "yield-star-in-safe-try": 91_005,
};

type TypeScriptApi = typeof ts;

type ResultarLanguageServiceOptions = Partial<ResultarRulesOptions>;

interface DiagnosticContext {
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

export interface ResultarDiagnosticInput {
  readonly options?: ResultarLanguageServiceOptions;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

const isExternalSourceFile = (sourceFile: ts.SourceFile): boolean =>
  sourceFile.isDeclarationFile ||
  sourceFile.fileName.includes("/node_modules/") ||
  sourceFile.fileName.includes("\\node_modules\\");

const getDiagnosticCategory = (
  tsApi: TypeScriptApi,
  severity: Exclude<ResultarRuleSeverity, "off">,
): ts.DiagnosticCategory => {
  if (severity === "error") {
    return tsApi.DiagnosticCategory.Error;
  }

  if (severity === "message") {
    return tsApi.DiagnosticCategory.Message;
  }

  if (severity === "suggestion") {
    return tsApi.DiagnosticCategory.Suggestion;
  }

  return tsApi.DiagnosticCategory.Warning;
};

const createResultarDiagnostic = (
  context: DiagnosticContext,
  finding: ResultarLintFinding,
): ts.Diagnostic => {
  const diagnosticRuleName = finding.rule === "no-discard" ? "noDiscard" : finding.rule;

  return {
    category: getDiagnosticCategory(context.tsApi, finding.severity),
    code: RESULTAR_RULE_DIAGNOSTIC_CODES[finding.rule],
    file: context.sourceFile,
    length: finding.length,
    messageText: `[resultar/${diagnosticRuleName}] ${finding.message}`,
    source: RESULTAR_DIAGNOSTIC_SOURCE,
    start: finding.start,
  };
};

export const getResultarDiagnostics = (
  input: ResultarDiagnosticInput,
): readonly ts.Diagnostic[] => {
  const options = normalizeResultarRulesOptions(input.options);

  if (isExternalSourceFile(input.sourceFile)) {
    return [];
  }

  const context: DiagnosticContext = { sourceFile: input.sourceFile, tsApi: input.tsApi };
  const diagnostics = getSourceFileResultarFindings(
    input.tsApi,
    input.program.getTypeChecker(),
    input.sourceFile,
    options,
  ).map((finding) => createResultarDiagnostic(context, finding));

  return diagnostics;
};

export const getProgramResultarDiagnostics = (
  tsApi: TypeScriptApi,
  program: ts.Program,
  options: ResultarLanguageServiceOptions = {},
): readonly ts.Diagnostic[] =>
  program
    .getSourceFiles()
    .flatMap((sourceFile) => getResultarDiagnostics({ options, program, sourceFile, tsApi }));

export const getNoDiscardDiagnostics = (input: ResultarDiagnosticInput): readonly ts.Diagnostic[] =>
  getResultarDiagnostics({
    ...input,
    options: {
      ...onlyResultarRule("no-discard", input.options?.noDiscard ?? "error"),
      noDiscardMode: input.options?.noDiscardMode,
    },
  });

export const getProgramNoDiscardDiagnostics = (
  tsApi: TypeScriptApi,
  program: ts.Program,
  options: ResultarLanguageServiceOptions = {},
): readonly ts.Diagnostic[] =>
  getProgramResultarDiagnostics(tsApi, program, {
    ...onlyResultarRule("no-discard", options.noDiscard ?? "error"),
    noDiscardMode: options.noDiscardMode,
  });
