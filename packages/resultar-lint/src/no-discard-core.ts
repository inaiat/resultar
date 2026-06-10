import type * as ts from "typescript";

type TypeScriptApi = typeof ts;

export type NoDiscardMode = "direct" | "must-use";

export interface NoDiscardRuleOptions {
  readonly mode?: NoDiscardMode;
}

export interface NoDiscardFinding {
  readonly column: number;
  readonly file: string;
  readonly length: number;
  readonly line: number;
  readonly message: string;
  readonly start: number;
  readonly type: string;
}

interface RuleContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

interface TrackedResult {
  readonly declaration: ts.VariableDeclaration;
  readonly identifier: ts.Identifier;
  readonly name: string;
  readonly symbol: ts.Symbol;
  readonly typeName: string;
  hasDiscardedResultUse: boolean;
  handled: boolean;
}

const resultTypeMatcher =
  /\b(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)\b/;

const consumerMethods = new Set([
  "_unsafeUnwrap",
  "_unsafeUnwrapErr",
  "isErr",
  "isOk",
  "match",
  "matchTags",
  "matchTagsPartial",
  "unwrapOr",
  "unwrapOrThrow",
]);

const consumerProperties = new Set(["error", "value"]);

export const normalizeNoDiscardMode = (mode: unknown): NoDiscardMode =>
  mode === "direct" ? "direct" : "must-use";

export const isResultLikeType = (
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

export const unwrapExpression = (
  tsApi: TypeScriptApi,
  expression: ts.Expression,
): ts.Expression => {
  let current = expression;

  for (;;) {
    if (tsApi.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (tsApi.isAsExpression(current)) {
      current = current.expression;
    } else if (tsApi.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (tsApi.isNonNullExpression(current)) {
      current = current.expression;
    } else if (tsApi.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
};

export const isExplicitDiscard = (tsApi: TypeScriptApi, expression: ts.Expression): boolean =>
  tsApi.isVoidExpression(unwrapExpression(tsApi, expression));

export const isCallLikeDiscard = (tsApi: TypeScriptApi, expression: ts.Expression): boolean => {
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
      (kind === tsApi.SyntaxKind.AmpersandAmpersandToken ||
        kind === tsApi.SyntaxKind.BarBarToken ||
        kind === tsApi.SyntaxKind.QuestionQuestionToken) &&
      isCallLikeDiscard(tsApi, unwrapped.right)
    );
  }

  return false;
};

const getTypeName = (context: RuleContext, node: ts.Node, type: ts.Type): string =>
  context.checker.typeToString(type, node, context.tsApi.TypeFormatFlags.NoTruncation);

const createFinding = (
  context: RuleContext,
  node: ts.Expression,
  typeName: string,
  message: string,
): NoDiscardFinding => {
  const start = node.getStart(context.sourceFile);
  const position = context.sourceFile.getLineAndCharacterOfPosition(start);

  return {
    column: position.character + 1,
    file: context.sourceFile.fileName,
    length: node.getWidth(context.sourceFile),
    line: position.line + 1,
    message,
    start,
    type: typeName,
  };
};

const createIgnoredFinding = (
  context: RuleContext,
  node: ts.Expression,
  typeName: string,
): NoDiscardFinding =>
  createFinding(
    context,
    node,
    typeName,
    `Ignored ${typeName} value. Handle it or explicitly discard it with \`void\`.`,
  );

const createUnhandledFinding = (context: RuleContext, tracked: TrackedResult): NoDiscardFinding =>
  createFinding(
    context,
    tracked.identifier,
    tracked.typeName,
    `Unhandled ${tracked.typeName} value assigned to \`${tracked.name}\`. Handle it, return it, or explicitly discard it with \`void\`.`,
  );

const symbolsEqual = (left: ts.Symbol, right: ts.Symbol): boolean =>
  left === right || left.valueDeclaration === right.valueDeclaration;

const isWrapperParent = (tsApi: TypeScriptApi, parent: ts.Node, child: ts.Node): boolean =>
  (tsApi.isParenthesizedExpression(parent) && parent.expression === child) ||
  (tsApi.isAsExpression(parent) && parent.expression === child) ||
  (tsApi.isTypeAssertionExpression(parent) && parent.expression === child) ||
  (tsApi.isNonNullExpression(parent) && parent.expression === child) ||
  (tsApi.isSatisfiesExpression(parent) && parent.expression === child);

const getReferenceChainRoot = (
  tsApi: TypeScriptApi,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): { readonly parent: ts.Node | undefined; readonly root: ts.Node } => {
  let current: ts.Node = identifier;
  let parentIndex = ancestors.length - 1;

  for (;;) {
    const parent = ancestors[parentIndex];

    if (parent === undefined) {
      return { parent: undefined, root: current };
    }

    if (isWrapperParent(tsApi, parent, current)) {
      current = parent;
    } else if (tsApi.isAwaitExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (tsApi.isPropertyAccessExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (tsApi.isCallExpression(parent) && parent.expression === current) {
      current = parent;
    } else {
      return { parent, root: current };
    }

    parentIndex -= 1;
  }
};

const isReturnedReference = (
  tsApi: TypeScriptApi,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): boolean => {
  const { parent, root } = getReferenceChainRoot(tsApi, identifier, ancestors);

  return (
    (parent !== undefined && tsApi.isReturnStatement(parent) && parent.expression === root) ||
    (parent !== undefined && tsApi.isArrowFunction(parent) && parent.body === root)
  );
};

const isExplicitDiscardReference = (
  tsApi: TypeScriptApi,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): boolean => {
  const { parent, root } = getReferenceChainRoot(tsApi, identifier, ancestors);

  return parent !== undefined && tsApi.isVoidExpression(parent) && parent.expression === root;
};

const isConsumedByReceiverChain = (
  tsApi: TypeScriptApi,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): boolean => {
  let current: ts.Node = identifier;
  let parentIndex = ancestors.length - 1;

  for (;;) {
    const parent = ancestors[parentIndex];

    if (parent === undefined) {
      return false;
    }

    if (isWrapperParent(tsApi, parent, current)) {
      current = parent;
    } else if (tsApi.isAwaitExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (tsApi.isPropertyAccessExpression(parent) && parent.expression === current) {
      const methodOrPropertyName = parent.name.text;
      const nextParent = ancestors[parentIndex - 1];

      if (consumerProperties.has(methodOrPropertyName)) {
        return true;
      }

      if (
        consumerMethods.has(methodOrPropertyName) &&
        nextParent !== undefined &&
        tsApi.isCallExpression(nextParent) &&
        nextParent.expression === parent
      ) {
        return true;
      }

      current = parent;
    } else if (tsApi.isCallExpression(parent) && parent.expression === current) {
      current = parent;
    } else {
      return false;
    }

    parentIndex -= 1;
  }
};

const isHandledReference = (
  tsApi: TypeScriptApi,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): boolean =>
  isReturnedReference(tsApi, identifier, ancestors) ||
  isExplicitDiscardReference(tsApi, identifier, ancestors) ||
  isConsumedByReceiverChain(tsApi, identifier, ancestors);

const isIdentifierInsideDiscardedResultExpression = (
  context: RuleContext,
  identifier: ts.Identifier,
  ancestors: readonly ts.Node[],
): boolean => {
  let current: ts.Node = identifier;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    current = ancestors[index] as ts.Node;

    if (context.tsApi.isExpressionStatement(current)) {
      if (
        isExplicitDiscard(context.tsApi, current.expression) ||
        !isCallLikeDiscard(context.tsApi, current.expression)
      ) {
        return false;
      }

      const type = context.checker.getTypeAtLocation(current.expression);

      return isResultLikeType(context.tsApi, context.checker, current.expression, type);
    }
  }

  return false;
};

const getTrackedResult = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  trackedResults: readonly TrackedResult[],
  identifier: ts.Identifier,
): TrackedResult | undefined => {
  const symbol = checker.getSymbolAtLocation(identifier);

  return symbol === undefined
    ? undefined
    : trackedResults.find((tracked) => symbolsEqual(tracked.symbol, symbol));
};

const collectTrackedResults = (context: RuleContext): readonly TrackedResult[] => {
  const trackedResults: TrackedResult[] = [];

  const visit = (node: ts.Node): void => {
    if (
      context.tsApi.isVariableDeclaration(node) &&
      context.tsApi.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCallLikeDiscard(context.tsApi, node.initializer)
    ) {
      const type = context.checker.getTypeAtLocation(node.initializer);

      if (isResultLikeType(context.tsApi, context.checker, node.initializer, type)) {
        const symbol = context.checker.getSymbolAtLocation(node.name);

        if (symbol !== undefined) {
          trackedResults.push({
            declaration: node,
            hasDiscardedResultUse: false,
            handled: false,
            identifier: node.name,
            name: node.name.text,
            symbol,
            typeName: getTypeName(context, node.initializer, type),
          });
        }
      }
    }

    context.tsApi.forEachChild(node, visit);
  };

  visit(context.sourceFile);

  return trackedResults;
};

const markTrackedResultUses = (
  context: RuleContext,
  trackedResults: readonly TrackedResult[],
): void => {
  const visit = (node: ts.Node, ancestors: readonly ts.Node[]): void => {
    if (context.tsApi.isIdentifier(node)) {
      const tracked = getTrackedResult(context.tsApi, context.checker, trackedResults, node);

      if (tracked !== undefined && node !== tracked.identifier) {
        if (isHandledReference(context.tsApi, node, ancestors)) {
          tracked.handled = true;
        }

        if (isIdentifierInsideDiscardedResultExpression(context, node, ancestors)) {
          tracked.hasDiscardedResultUse = true;
        }
      }
    }

    context.tsApi.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  };

  visit(context.sourceFile, []);
};

const getDirectFindings = (context: RuleContext): readonly NoDiscardFinding[] => {
  const findings: NoDiscardFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (
      context.tsApi.isExpressionStatement(node) &&
      !isExplicitDiscard(context.tsApi, node.expression) &&
      isCallLikeDiscard(context.tsApi, node.expression)
    ) {
      const type = context.checker.getTypeAtLocation(node.expression);

      if (isResultLikeType(context.tsApi, context.checker, node.expression, type)) {
        findings.push(
          createIgnoredFinding(
            context,
            node.expression,
            getTypeName(context, node.expression, type),
          ),
        );
      }
    }

    context.tsApi.forEachChild(node, visit);
  };

  visit(context.sourceFile);

  return findings;
};

const getMustUseFindings = (context: RuleContext): readonly NoDiscardFinding[] => {
  const trackedResults = collectTrackedResults(context);

  markTrackedResultUses(context, trackedResults);

  return trackedResults
    .filter((tracked) => !tracked.handled && !tracked.hasDiscardedResultUse)
    .map((tracked) => createUnhandledFinding(context, tracked));
};

export const getSourceFileNoDiscardFindings = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  options: NoDiscardRuleOptions = {},
): readonly NoDiscardFinding[] => {
  const context: RuleContext = { checker, sourceFile, tsApi };
  const mode = normalizeNoDiscardMode(options.mode);
  const directFindings = getDirectFindings(context);

  return mode === "must-use" ? [...directFindings, ...getMustUseFindings(context)] : directFindings;
};

export const getProgramNoDiscardFindings = (
  tsApi: TypeScriptApi,
  program: ts.Program,
  options: NoDiscardRuleOptions = {},
): readonly NoDiscardFinding[] => {
  const checker = program.getTypeChecker();
  const findings: NoDiscardFinding[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (
      !sourceFile.isDeclarationFile &&
      !sourceFile.fileName.includes("/node_modules/") &&
      !sourceFile.fileName.includes("\\node_modules\\")
    ) {
      findings.push(...getSourceFileNoDiscardFindings(tsApi, checker, sourceFile, options));
    }
  }

  return findings;
};
