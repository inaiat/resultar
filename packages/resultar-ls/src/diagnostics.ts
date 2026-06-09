import type * as ts from "typescript";

export const RESULTAR_DIAGNOSTIC_SOURCE = "resultar";
export const RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE = 91_001;

type TypeScriptApi = typeof ts;
type NoDiscardSeverity = "error" | "off";

interface ResultarLanguageServiceOptions {
  readonly noDiscard: NoDiscardSeverity;
}

const defaultOptions: ResultarLanguageServiceOptions = { noDiscard: "error" };
const resultTypeMatcher =
  /\b(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)\b/;

interface DiagnosticContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

export interface NoDiscardDiagnosticInput {
  readonly options?: ResultarLanguageServiceOptions;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

const isResultLikeType = (context: DiagnosticContext, node: ts.Node, type: ts.Type): boolean => {
  if (type.isUnionOrIntersection()) {
    return type.types.some((innerType) => isResultLikeType(context, node, innerType));
  }

  const typeName = context.checker.typeToString(
    type,
    node,
    context.tsApi.TypeFormatFlags.NoTruncation +
      context.tsApi.TypeFormatFlags.UseFullyQualifiedType,
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

  if (tsApi.isBinaryExpression(unwrapped)) {
    const kind = unwrapped.operatorToken.kind;

    return (
      kind === tsApi.SyntaxKind.AmpersandAmpersandToken ||
      kind === tsApi.SyntaxKind.BarBarToken ||
      kind === tsApi.SyntaxKind.QuestionQuestionToken
    );
  }

  return false;
};

const isExternalSourceFile = (sourceFile: ts.SourceFile): boolean =>
  sourceFile.isDeclarationFile ||
  sourceFile.fileName.includes("/node_modules/") ||
  sourceFile.fileName.includes("\\node_modules\\");

const createNoDiscardDiagnostic = (
  context: DiagnosticContext,
  node: ts.ExpressionStatement,
): ts.Diagnostic => {
  const type = context.checker.getTypeAtLocation(node.expression);
  const typeName = context.checker.typeToString(
    type,
    node.expression,
    context.tsApi.TypeFormatFlags.NoTruncation,
  );
  const start = node.expression.getStart(context.sourceFile);

  return {
    category: context.tsApi.DiagnosticCategory.Error,
    code: RESULTAR_NO_DISCARD_DIAGNOSTIC_CODE,
    file: context.sourceFile,
    length: node.expression.getWidth(context.sourceFile),
    messageText: `[resultar/noDiscard] Ignored ${typeName} value. Handle it or explicitly discard it with \`void\`.`,
    source: RESULTAR_DIAGNOSTIC_SOURCE,
    start,
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
    checker: input.program.getTypeChecker(),
    sourceFile: input.sourceFile,
    tsApi: input.tsApi,
  };
  const diagnostics: ts.Diagnostic[] = [];

  const visit = (node: ts.Node): void => {
    if (
      context.tsApi.isExpressionStatement(node) &&
      !isExplicitDiscard(context.tsApi, node.expression) &&
      isCallLikeDiscard(context.tsApi, node.expression)
    ) {
      const type = context.checker.getTypeAtLocation(node.expression);

      if (isResultLikeType(context, node.expression, type)) {
        diagnostics.push(createNoDiscardDiagnostic(context, node));
      }
    }

    context.tsApi.forEachChild(node, visit);
  };

  visit(input.sourceFile);

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
