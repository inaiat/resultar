import type * as ts from "./typescript-api.js";

import type { ResultarLintFinding } from "./finding.js";
import { shouldInspectSourceFile, type SourceFileFilterOptions } from "./source-files.js";

type TypeScriptApi = typeof ts;

export type NoDiscardMode = "direct" | "must-use";

export interface NoDiscardRuleOptions extends SourceFileFilterOptions {
  readonly mode?: NoDiscardMode;
}

export type NoDiscardFinding = ResultarLintFinding & {
  readonly rule: "no-discard";
  readonly type: string;
};

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

interface IdentifierText {
  readonly escapedText?: unknown;
  readonly text?: string;
}

const resultTypeNames = new Set([
  "DisposableResult",
  "DisposableResultAsync",
  "ErrResult",
  "OkResult",
  "Result",
  "ResultAsync",
  "StrictResult",
  "StrictResultAsync",
]);

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

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const getObjectProperty = (value: object, property: PropertyKey): unknown =>
  Reflect.get(value, property);

const callObjectMethod = (
  value: object,
  methodName: PropertyKey,
  args: readonly unknown[] = [],
): unknown => {
  const method = getObjectProperty(value, methodName);

  return typeof method === "function" ? Reflect.apply(method, value, args) : undefined;
};

const isTypeLike = (value: unknown): value is ts.Type =>
  isObject(value) && typeof getObjectProperty(value, "flags") === "number";

const isTypeArray = (value: unknown): value is readonly ts.Type[] =>
  Array.isArray(value) && value.every((entry) => isTypeLike(entry));

const getUnionOrIntersectionTypes = (
  tsApi: TypeScriptApi,
  type: ts.Type | undefined,
): readonly ts.Type[] | undefined => {
  if (
    type === undefined ||
    (type.flags & (tsApi.TypeFlags.Union | tsApi.TypeFlags.Intersection)) === 0
  ) {
    return undefined;
  }

  const getTypesResult = callObjectMethod(type, "getTypes");
  const types = getTypesResult ?? getObjectProperty(type, "types");

  return isTypeArray(types) ? types : [];
};

const getSymbolName = (symbol: unknown): string | undefined => {
  if (!isObject(symbol)) {
    return undefined;
  }

  const symbolName = callObjectMethod(symbol, "getName");

  if (typeof symbolName === "string") {
    return symbolName;
  }

  const escapedName = getObjectProperty(symbol, "escapedName");
  const name = getObjectProperty(symbol, "name");

  if (typeof escapedName === "string") {
    return escapedName;
  }

  return typeof name === "string" ? name : undefined;
};

const getTypeSymbolName = (type: ts.Type | undefined): string | undefined => {
  if (type === undefined) {
    return undefined;
  }

  const directSymbol = callObjectMethod(type, "getSymbol");

  return getSymbolName(directSymbol ?? getObjectProperty(type, "symbol"));
};

const getTokenPosOfNode = (
  tsApi: TypeScriptApi,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): number => {
  const tokenPos = callObjectMethod(tsApi, "getTokenPosOfNode", [node, sourceFile]);

  return typeof tokenPos === "number" ? tokenPos : node.pos;
};

const getNodeStart = (tsApi: TypeScriptApi, node: ts.Node, sourceFile: ts.SourceFile): number =>
  typeof node.getStart === "function"
    ? node.getStart(sourceFile)
    : getTokenPosOfNode(tsApi, node, sourceFile);

const getIdentifierText = (identifier: IdentifierText): string => {
  if (typeof identifier.text === "string") {
    return identifier.text;
  }

  const { escapedText } = identifier;

  return typeof escapedText === "string" || typeof escapedText === "number" ? `${escapedText}` : "";
};

const getNodeWidth = (tsApi: TypeScriptApi, node: ts.Node, sourceFile: ts.SourceFile): number => {
  if (typeof node.getWidth === "function") {
    return node.getWidth(sourceFile);
  }

  const start = getNodeStart(tsApi, node, sourceFile);

  return node.end - start;
};

const getEntityNameText = (tsApi: TypeScriptApi, name: ts.EntityName): string =>
  tsApi.isIdentifier(name)
    ? getIdentifierText(name)
    : `${getEntityNameText(tsApi, name.left)}.${getIdentifierText(name.right)}`;

export const normalizeNoDiscardMode = (mode: unknown): NoDiscardMode =>
  mode === "direct" ? "direct" : "must-use";

export const isResultLikeType = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  node: ts.Node,
  type: ts.Type | undefined,
): boolean => {
  if (type === undefined) {
    return false;
  }

  const unionOrIntersectionTypes = getUnionOrIntersectionTypes(tsApi, type);

  if (unionOrIntersectionTypes !== undefined) {
    return unionOrIntersectionTypes.some((innerType) =>
      isResultLikeType(tsApi, checker, node, innerType),
    );
  }

  const aliasName = getSymbolName(
    callObjectMethod(type, "getAliasSymbol") ?? getObjectProperty(type, "aliasSymbol"),
  );
  const symbolName = getTypeSymbolName(type);

  if (
    (aliasName !== undefined && resultTypeNames.has(aliasName)) ||
    (symbolName !== undefined && resultTypeNames.has(symbolName))
  ) {
    return true;
  }

  if (tsApi.isTypeReferenceNode(node)) {
    const typeName = getEntityNameText(tsApi, node.typeName);
    const unqualifiedName = typeName.includes(".") ? typeName.split(".").at(-1) : typeName;

    return unqualifiedName !== undefined && resultTypeNames.has(unqualifiedName);
  }

  void checker;
  return false;
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
    const { kind } = unwrapped.operatorToken;

    return (
      (kind === tsApi.SyntaxKind.AmpersandAmpersandToken ||
        kind === tsApi.SyntaxKind.BarBarToken ||
        kind === tsApi.SyntaxKind.QuestionQuestionToken) &&
      isCallLikeDiscard(tsApi, unwrapped.right)
    );
  }

  return false;
};

const getTypeName = (context: RuleContext, node: ts.Node, type: ts.Type | undefined): string =>
  type === undefined
    ? "unknown"
    : context.checker.typeToString(type, node, context.tsApi.TypeFormatFlags.NoTruncation);

const createFinding = (
  context: RuleContext,
  node: ts.Expression,
  typeName: string,
  message: string,
): NoDiscardFinding => {
  const start = getNodeStart(context.tsApi, node, context.sourceFile);
  const position = context.tsApi.getLineAndCharacterOfPosition(context.sourceFile, start);

  return {
    column: position.character + 1,
    file: context.sourceFile.fileName,
    length: getNodeWidth(context.tsApi, node, context.sourceFile),
    line: position.line + 1,
    message,
    rule: "no-discard",
    severity: "error",
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

const getSymbolIdentity = (symbol: ts.Symbol): unknown => {
  const id = getObjectProperty(symbol, "id");
  const valueDeclaration = getObjectProperty(symbol, "valueDeclaration");

  return id ?? valueDeclaration ?? symbol;
};

const symbolsEqual = (left: ts.Symbol, right: ts.Symbol): boolean =>
  left === right || getSymbolIdentity(left) === getSymbolIdentity(right);

const isWrapperParent = (tsApi: TypeScriptApi, parent: ts.Node, child: ts.Node): boolean =>
  (tsApi.isParenthesizedExpression(parent) && parent.expression === child) ||
  (tsApi.isAsExpression(parent) && parent.expression === child) ||
  (tsApi.isTypeAssertionExpression(parent) && parent.expression === child) ||
  (tsApi.isNonNullExpression(parent) && parent.expression === child) ||
  (tsApi.isSatisfiesExpression(parent) && parent.expression === child);

const isReturnValueContainerParent = (
  tsApi: TypeScriptApi,
  parent: ts.Node,
  child: ts.Node,
): boolean =>
  isWrapperParent(tsApi, parent, child) ||
  (tsApi.isShorthandPropertyAssignment(parent) && parent.name === child) ||
  (tsApi.isPropertyAssignment(parent) && parent.initializer === child) ||
  (tsApi.isSpreadAssignment(parent) && parent.expression === child) ||
  (tsApi.isSpreadElement(parent) && parent.expression === child) ||
  (tsApi.isObjectLiteralExpression(parent) &&
    parent.properties.some((property) => property === child)) ||
  (tsApi.isArrayLiteralExpression(parent) &&
    parent.elements.some((element) => element === child)) ||
  (tsApi.isConditionalExpression(parent) &&
    (parent.whenTrue === child || parent.whenFalse === child));

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

  if (
    (parent !== undefined && tsApi.isReturnStatement(parent) && parent.expression === root) ||
    (parent !== undefined && tsApi.isArrowFunction(parent) && parent.body === root)
  ) {
    return true;
  }

  let current: ts.Node = identifier;

  for (let parentIndex = ancestors.length - 1; parentIndex >= 0; parentIndex -= 1) {
    const containerParent = ancestors[parentIndex];

    if (containerParent === undefined) {
      return false;
    }

    if (isReturnValueContainerParent(tsApi, containerParent, current)) {
      current = containerParent;
      continue;
    }

    return (
      (tsApi.isReturnStatement(containerParent) && containerParent.expression === current) ||
      (tsApi.isArrowFunction(containerParent) && containerParent.body === current)
    );
  }

  return false;
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
      const methodOrPropertyName = getIdentifierText(parent.name);
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
    const ancestor = ancestors[index];

    if (ancestor === undefined) {
      continue;
    }

    current = ancestor;

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
  const shorthandParent = identifier.parent;
  const symbol =
    shorthandParent !== undefined &&
    tsApi.isShorthandPropertyAssignment(shorthandParent) &&
    shorthandParent.name === identifier
      ? checker.getShorthandAssignmentValueSymbol(shorthandParent)
      : checker.getSymbolAtLocation(identifier);

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
            name: getIdentifierText(node.name),
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

    context.tsApi.forEachChild(node, (child) => {
      visit(child, [...ancestors, node]);
    });
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
  if (!shouldInspectSourceFile(sourceFile, options)) {
    return [];
  }

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
    if (shouldInspectSourceFile(sourceFile, options)) {
      findings.push(...getSourceFileNoDiscardFindings(tsApi, checker, sourceFile, options));
    }
  }

  return findings;
};
