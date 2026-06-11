import type * as ts from "typescript";

import {
  getSourceFileNoDiscardFindings,
  normalizeNoDiscardMode,
  type NoDiscardFinding,
  type NoDiscardMode,
} from "./no-discard-core";

export const RESULTAR_DIAGNOSTIC_SOURCE = "resultar";
export const RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE = 91_001;

type TypeScriptApi = typeof ts;
type NoDiscardSeverity = "error" | "off";

interface ResultarLanguageServiceOptions {
  readonly noDiscard: NoDiscardSeverity;
  readonly noDiscardMode?: NoDiscardMode;
}

const defaultOptions: ResultarLanguageServiceOptions = { noDiscard: "error" };

interface DiagnosticContext {
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

export interface NoDiscardDiagnosticInput {
  readonly options?: ResultarLanguageServiceOptions;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

const isExternalSourceFile = (sourceFile: ts.SourceFile): boolean =>
  sourceFile.isDeclarationFile ||
  sourceFile.fileName.includes("/node_modules/") ||
  sourceFile.fileName.includes("\\node_modules\\");

const createNoDiscardDiagnostic = (
  context: DiagnosticContext,
  finding: NoDiscardFinding,
): ts.Diagnostic => {
  return {
    category: context.tsApi.DiagnosticCategory.Error,
    code: RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE,
    file: context.sourceFile,
    length: finding.length,
    messageText: `[resultar/noDiscard] ${finding.message}`,
    source: RESULTAR_DIAGNOSTIC_SOURCE,
    start: finding.start,
  };
};

export const getNoDiscardDiagnostics = (
  input: NoDiscardDiagnosticInput,
): readonly ts.Diagnostic[] => {
  const options = input.options ?? defaultOptions;

  if (options.noDiscard === "off" || isExternalSourceFile(input.sourceFile)) {
    return [];
  }

  const context: DiagnosticContext = {
    sourceFile: input.sourceFile,
    tsApi: input.tsApi,
  };
  const diagnostics = getSourceFileNoDiscardFindings(
    input.tsApi,
    input.program.getTypeChecker(),
    input.sourceFile,
    { mode: normalizeNoDiscardMode(options.noDiscardMode) },
  ).map((finding) => createNoDiscardDiagnostic(context, finding));

  return diagnostics;
};

export const getProgramNoDiscardDiagnostics = (
  tsApi: TypeScriptApi,
  program: ts.Program,
  options: ResultarLanguageServiceOptions = defaultOptions,
): readonly ts.Diagnostic[] => {
  if (options.noDiscard === "off") {
    return [];
  }

  return program
    .getSourceFiles()
    .flatMap((sourceFile) => getNoDiscardDiagnostics({ options, program, sourceFile, tsApi }));
};
