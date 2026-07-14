import type * as ts from "./typescript-api.js";

import type { ResultarLintFinding, ResultarRuleName, ResultarRuleSeverity } from "./finding.js";
import {
  type NoDiscardMode,
  getSourceFileNoDiscardFindings,
  isResultLikeType,
  normalizeNoDiscardMode,
  unwrapExpression,
} from "./result-usage-core.js";
import { normalizeIgnoreFilePatterns, shouldInspectSourceFile } from "./source-files.js";

type TypeScriptApi = typeof ts;

type EnabledRuleSeverity = Exclude<ResultarRuleSeverity, "off">;
export type NoUnsafeAwaitMode = "all" | "resultar-context";
type ResultarRuleOptionName = Exclude<
  keyof ResultarRulesOptions,
  "ignoreFilePatterns" | "noDiscardMode" | "noUnsafeAwaitIgnoreCalls" | "noUnsafeAwaitMode"
>;
type MutableResultarRulesOptions = {
  -readonly [Key in keyof ResultarRulesOptions]?: ResultarRulesOptions[Key];
};

interface RuleContext {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly tsApi: TypeScriptApi;
}

interface ResultTypeParts {
  readonly error: ts.Type | undefined;
  readonly ok: ts.Type | undefined;
}

interface IdentifierText {
  readonly escapedText?: unknown;
  readonly text?: string;
}

type SafeTryBody =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

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

export interface ResultarRulesOptions {
  readonly ignoreFilePatterns: readonly string[];
  readonly noAwaitInSafeTry: ResultarRuleSeverity;
  readonly noDiscard: ResultarRuleSeverity;
  readonly noDiscardMode: NoDiscardMode;
  readonly noTaggedErrorConstructorOverride: ResultarRuleSeverity;
  readonly noThrow: ResultarRuleSeverity;
  readonly noTryCatch: ResultarRuleSeverity;
  readonly noTryCatchInSafeTry: ResultarRuleSeverity;
  readonly noUnsafeAwait: ResultarRuleSeverity;
  readonly noUnsafeAwaitIgnoreCalls: readonly string[];
  readonly noUnsafeAwaitMode: NoUnsafeAwaitMode;
  readonly noUselessRecovery: ResultarRuleSeverity;
  readonly preferAndThen: ResultarRuleSeverity;
  readonly preferMapErr: ResultarRuleSeverity;
  readonly preferTaggedError: ResultarRuleSeverity;
  readonly taggedErrorNameMatch: ResultarRuleSeverity;
  readonly typedCatchMapper: ResultarRuleSeverity;
  readonly unsafeResultTypeAssertion: ResultarRuleSeverity;
  readonly yieldStarInSafeTry: ResultarRuleSeverity;
}

export const resultarRuleNames: readonly ResultarRuleName[] = [
  "no-discard",
  "prefer-map-err",
  "prefer-and-then",
  "typed-catch-mapper",
  "no-throw",
  "no-try-catch",
  "no-await-in-safe-try",
  "no-unsafe-await",
  "no-try-catch-in-safe-try",
  "yield-star-in-safe-try",
  "unsafe-result-type-assertion",
  "prefer-tagged-error",
  "tagged-error-name-match",
  "no-tagged-error-constructor-override",
  "no-useless-recovery",
];

export const ruleOptionNameByRule: Record<ResultarRuleName, ResultarRuleOptionName> = {
  "no-await-in-safe-try": "noAwaitInSafeTry",
  "no-discard": "noDiscard",
  "no-tagged-error-constructor-override": "noTaggedErrorConstructorOverride",
  "no-throw": "noThrow",
  "no-try-catch": "noTryCatch",
  "no-try-catch-in-safe-try": "noTryCatchInSafeTry",
  "no-unsafe-await": "noUnsafeAwait",
  "no-useless-recovery": "noUselessRecovery",
  "prefer-and-then": "preferAndThen",
  "prefer-map-err": "preferMapErr",
  "prefer-tagged-error": "preferTaggedError",
  "tagged-error-name-match": "taggedErrorNameMatch",
  "typed-catch-mapper": "typedCatchMapper",
  "unsafe-result-type-assertion": "unsafeResultTypeAssertion",
  "yield-star-in-safe-try": "yieldStarInSafeTry",
};

export const defaultResultarRulesOptions: ResultarRulesOptions = {
  ignoreFilePatterns: [],
  noAwaitInSafeTry: "error",
  noDiscard: "error",
  noDiscardMode: "must-use",
  noTaggedErrorConstructorOverride: "warning",
  noThrow: "off",
  noTryCatch: "off",
  noTryCatchInSafeTry: "warning",
  noUnsafeAwait: "off",
  noUnsafeAwaitIgnoreCalls: [],
  noUnsafeAwaitMode: "resultar-context",
  noUselessRecovery: "warning",
  preferAndThen: "warning",
  preferMapErr: "warning",
  preferTaggedError: "warning",
  taggedErrorNameMatch: "warning",
  typedCatchMapper: "warning",
  unsafeResultTypeAssertion: "warning",
  yieldStarInSafeTry: "warning",
};

const ruleNamesWithoutNoDiscard = resultarRuleNames.filter(
  (ruleName): ruleName is Exclude<ResultarRuleName, "no-discard"> => ruleName !== "no-discard",
);

const recoveryMethods = new Set([
  "catchReason",
  "catchReasons",
  "catchTag",
  "catchTags",
  "mapErr",
  "orElse",
  "unwrapReason",
]);

const tryMapperCallNames = new Set([
  "fromThrowable",
  "fromThrowableAsync",
  "tryCatch",
  "tryCatchAsync",
  "tryResult",
  "tryResultAsync",
  "tryAsync",
]);

const asyncAwaitBoundaryCallNames = new Set([
  "fromThrowableAsync",
  "tryCatchAsync",
  "tryResultAsync",
  "tryAsync",
]);

const resultLikeTypeNames = new Set([
  "DisposableResult",
  "DisposableResultAsync",
  "ErrResult",
  "OkResult",
  "Result",
  "ResultAsync",
  "StrictResult",
  "StrictResultAsync",
]);
const resultAsyncTypeNames = new Set(["DisposableResultAsync", "ResultAsync", "StrictResultAsync"]);

export const normalizeRuleSeverity = (
  value: unknown,
  fallback: ResultarRuleSeverity,
): ResultarRuleSeverity =>
  value === "error" ||
  value === "message" ||
  value === "off" ||
  value === "suggestion" ||
  value === "warning"
    ? value
    : fallback;

export const normalizeNoUnsafeAwaitMode = (
  value: unknown,
  fallback: NoUnsafeAwaitMode = defaultResultarRulesOptions.noUnsafeAwaitMode,
): NoUnsafeAwaitMode => (value === "all" || value === "resultar-context" ? value : fallback);

const isValidCallPath = (value: string): boolean =>
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value);

export const normalizeNoUnsafeAwaitIgnoreCalls = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && isValidCallPath(entry))
    : defaultResultarRulesOptions.noUnsafeAwaitIgnoreCalls;

export const normalizeResultarRulesOptions = (
  options: Partial<ResultarRulesOptions> = {},
): ResultarRulesOptions => ({
  ignoreFilePatterns: normalizeIgnoreFilePatterns(options.ignoreFilePatterns),
  noAwaitInSafeTry: normalizeRuleSeverity(
    options.noAwaitInSafeTry,
    defaultResultarRulesOptions.noAwaitInSafeTry,
  ),
  noDiscard: normalizeRuleSeverity(options.noDiscard, defaultResultarRulesOptions.noDiscard),
  noDiscardMode: normalizeNoDiscardMode(options.noDiscardMode),
  noTaggedErrorConstructorOverride: normalizeRuleSeverity(
    options.noTaggedErrorConstructorOverride,
    defaultResultarRulesOptions.noTaggedErrorConstructorOverride,
  ),
  noThrow: normalizeRuleSeverity(options.noThrow, defaultResultarRulesOptions.noThrow),
  noTryCatch: normalizeRuleSeverity(options.noTryCatch, defaultResultarRulesOptions.noTryCatch),
  noTryCatchInSafeTry: normalizeRuleSeverity(
    options.noTryCatchInSafeTry,
    defaultResultarRulesOptions.noTryCatchInSafeTry,
  ),
  noUnsafeAwait: normalizeRuleSeverity(
    options.noUnsafeAwait,
    defaultResultarRulesOptions.noUnsafeAwait,
  ),
  noUnsafeAwaitIgnoreCalls: normalizeNoUnsafeAwaitIgnoreCalls(options.noUnsafeAwaitIgnoreCalls),
  noUnsafeAwaitMode: normalizeNoUnsafeAwaitMode(options.noUnsafeAwaitMode),
  noUselessRecovery: normalizeRuleSeverity(
    options.noUselessRecovery,
    defaultResultarRulesOptions.noUselessRecovery,
  ),
  preferAndThen: normalizeRuleSeverity(
    options.preferAndThen,
    defaultResultarRulesOptions.preferAndThen,
  ),
  preferMapErr: normalizeRuleSeverity(
    options.preferMapErr,
    defaultResultarRulesOptions.preferMapErr,
  ),
  preferTaggedError: normalizeRuleSeverity(
    options.preferTaggedError,
    defaultResultarRulesOptions.preferTaggedError,
  ),
  taggedErrorNameMatch: normalizeRuleSeverity(
    options.taggedErrorNameMatch,
    defaultResultarRulesOptions.taggedErrorNameMatch,
  ),
  typedCatchMapper: normalizeRuleSeverity(
    options.typedCatchMapper,
    defaultResultarRulesOptions.typedCatchMapper,
  ),
  unsafeResultTypeAssertion: normalizeRuleSeverity(
    options.unsafeResultTypeAssertion,
    defaultResultarRulesOptions.unsafeResultTypeAssertion,
  ),
  yieldStarInSafeTry: normalizeRuleSeverity(
    options.yieldStarInSafeTry,
    defaultResultarRulesOptions.yieldStarInSafeTry,
  ),
});

export const onlyResultarRule = (
  ruleName: ResultarRuleName,
  severity: ResultarRuleSeverity = "error",
): Partial<ResultarRulesOptions> => {
  const options: MutableResultarRulesOptions = { noDiscard: "off" };

  for (const name of ruleNamesWithoutNoDiscard) {
    options[ruleOptionNameByRule[name]] = "off";
  }

  options[ruleOptionNameByRule[ruleName]] = severity;

  return options;
};

const getRuleSeverity = (
  options: ResultarRulesOptions,
  rule: ResultarRuleName,
): EnabledRuleSeverity | undefined => {
  const severity = options[ruleOptionNameByRule[rule]];

  return severity === "off" ? undefined : severity;
};

const getTokenPosOfNode = (context: RuleContext, node: ts.Node): number => {
  const tokenPos = callObjectMethod(context.tsApi, "getTokenPosOfNode", [node, context.sourceFile]);

  return typeof tokenPos === "number" ? tokenPos : node.pos;
};

const getNodeStart = (context: RuleContext, node: ts.Node): number =>
  typeof node.getStart === "function"
    ? node.getStart(context.sourceFile)
    : getTokenPosOfNode(context, node);

const getIdentifierText = (identifier: IdentifierText): string => {
  if (typeof identifier.text === "string") {
    return identifier.text;
  }

  const { escapedText } = identifier;

  return typeof escapedText === "string" || typeof escapedText === "number" ? `${escapedText}` : "";
};

const getNodeWidth = (context: RuleContext, node: ts.Node): number => {
  if (typeof node.getWidth === "function") {
    return node.getWidth(context.sourceFile);
  }

  const start = getNodeStart(context, node);

  return node.end - start;
};

const createFinding = (
  context: RuleContext,
  node: ts.Node,
  rule: ResultarRuleName,
  severity: EnabledRuleSeverity,
  message: string,
  type?: string,
): ResultarLintFinding => {
  const start = getNodeStart(context, node);
  const position = context.tsApi.getLineAndCharacterOfPosition(context.sourceFile, start);
  const base = {
    column: position.character + 1,
    file: context.sourceFile.fileName,
    length: getNodeWidth(context, node),
    line: position.line + 1,
    message,
    rule,
    severity,
    start,
  };

  return type === undefined ? base : { ...base, type };
};

const visitSourceFile = (context: RuleContext, visitor: (node: ts.Node) => void): void => {
  const visit = (node: ts.Node): void => {
    visitor(node);
    context.tsApi.forEachChild(node, visit);
  };

  visit(context.sourceFile);
};

const getPropertyNameText = (tsApi: TypeScriptApi, name: ts.PropertyName): string | undefined => {
  if (tsApi.isIdentifier(name)) {
    return getIdentifierText(name);
  }

  if (tsApi.isStringLiteral(name) || tsApi.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
};

const getExpressionName = (tsApi: TypeScriptApi, expression: ts.Expression): string | undefined => {
  const unwrapped = unwrapExpression(tsApi, expression);

  if (tsApi.isIdentifier(unwrapped)) {
    return getIdentifierText(unwrapped);
  }

  if (tsApi.isPropertyAccessExpression(unwrapped)) {
    return getIdentifierText(unwrapped.name);
  }

  return undefined;
};

const getCallPath = (tsApi: TypeScriptApi, expression: ts.Expression): string | undefined => {
  const unwrapped = unwrapExpression(tsApi, expression);

  if (tsApi.isIdentifier(unwrapped)) {
    return getIdentifierText(unwrapped);
  }

  if (tsApi.isPropertyAccessExpression(unwrapped)) {
    const parentPath = getCallPath(tsApi, unwrapped.expression);
    const propertyName = getIdentifierText(unwrapped.name);

    return parentPath === undefined || propertyName === undefined
      ? undefined
      : `${parentPath}.${propertyName}`;
  }

  return undefined;
};

const getMethodCall = (
  tsApi: TypeScriptApi,
  node: ts.Node,
):
  | {
      readonly methodName: string;
      readonly nameNode: ts.Identifier;
      readonly receiver: ts.Expression;
    }
  | undefined => {
  if (!tsApi.isCallExpression(node)) {
    return undefined;
  }

  const expression = unwrapExpression(tsApi, node.expression);

  if (!tsApi.isPropertyAccessExpression(expression)) {
    return undefined;
  }

  if (!tsApi.isIdentifier(expression.name)) {
    return undefined;
  }

  return {
    methodName: getIdentifierText(expression.name),
    nameNode: expression.name,
    receiver: expression.expression,
  };
};

const getTypeName = (context: RuleContext, node: ts.Node, type: ts.Type | undefined): string =>
  type === undefined
    ? "unknown"
    : context.checker.typeToString(type, node, context.tsApi.TypeFormatFlags.NoTruncation);

const getSymbolName = (symbol: unknown): string | undefined => {
  if (!isObject(symbol)) {
    return undefined;
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

  const aliasName = getSymbolName(
    callObjectMethod(type, "getAliasSymbol") ?? getObjectProperty(type, "aliasSymbol"),
  );

  if (aliasName !== undefined) {
    return aliasName;
  }

  const symbolName = getSymbolName(
    callObjectMethod(type, "getSymbol") ?? getObjectProperty(type, "symbol"),
  );

  if (symbolName !== undefined) {
    return symbolName;
  }

  const target = getObjectProperty(type, "target");

  return isObject(target) ? getSymbolName(getObjectProperty(target, "symbol")) : undefined;
};

const getUnionOrIntersectionTypes = (
  context: RuleContext,
  type: ts.Type | undefined,
): readonly ts.Type[] | undefined => {
  if (
    type === undefined ||
    (type.flags & (context.tsApi.TypeFlags.Union | context.tsApi.TypeFlags.Intersection)) === 0
  ) {
    return undefined;
  }

  const getTypesResult = callObjectMethod(type, "getTypes");
  const types = getTypesResult ?? getObjectProperty(type, "types");

  return isTypeArray(types) ? types : [];
};

const getTypeArguments = (_context: RuleContext, type: ts.Type): readonly ts.Type[] => {
  const aliasTypeArguments =
    callObjectMethod(type, "getAliasTypeArguments") ??
    getObjectProperty(type, "aliasTypeArguments");

  if (isTypeArray(aliasTypeArguments) && aliasTypeArguments.length > 0) {
    return aliasTypeArguments;
  }

  return [];
};

const getResultTypeParts = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): readonly ResultTypeParts[] => {
  if (type === undefined) {
    return [];
  }

  const [directOkType, directErrorType] = getTypeArguments(context, type);

  if (
    (directOkType !== undefined || directErrorType !== undefined) &&
    isResultLikeType(context.tsApi, context.checker, node, type)
  ) {
    return [{ error: directErrorType, ok: directOkType }];
  }

  const unionOrIntersectionTypes = getUnionOrIntersectionTypes(context, type);

  if (unionOrIntersectionTypes !== undefined) {
    return unionOrIntersectionTypes.flatMap((innerType) =>
      getResultTypeParts(context, node, innerType),
    );
  }

  if (!isResultLikeType(context.tsApi, context.checker, node, type)) {
    return [];
  }

  const [okType, errorType] = getTypeArguments(context, type);

  return [{ error: errorType, ok: okType }];
};

const isResultAsyncLikeType = (context: RuleContext, node: ts.Node, type: ts.Type): boolean => {
  const unionOrIntersectionTypes = getUnionOrIntersectionTypes(context, type);

  if (unionOrIntersectionTypes !== undefined) {
    return unionOrIntersectionTypes.some((innerType) =>
      isResultAsyncLikeType(context, node, innerType),
    );
  }

  const symbolName = getTypeSymbolName(type);

  void node;
  return symbolName !== undefined && resultAsyncTypeNames.has(symbolName);
};

const isResultLikeExpression = (context: RuleContext, expression: ts.Expression): boolean => {
  const type = context.checker.getTypeAtLocation(expression);

  return isResultLikeType(context.tsApi, context.checker, expression, type);
};

const getUnionTypes = (context: RuleContext, type: ts.Type): readonly ts.Type[] | undefined =>
  (type.flags & context.tsApi.TypeFlags.Union) === 0
    ? undefined
    : getUnionOrIntersectionTypes(context, type);

const everyUnionPart = (
  context: RuleContext,
  type: ts.Type,
  predicate: (type: ts.Type) => boolean,
): boolean => {
  const unionTypes = getUnionTypes(context, type);

  return unionTypes === undefined
    ? predicate(type)
    : unionTypes.every((innerType) => predicate(innerType));
};

const isResultAsyncLikeAwaitType = (context: RuleContext, node: ts.Node, type: ts.Type): boolean =>
  everyUnionPart(context, type, (innerType) => isResultAsyncLikeType(context, node, innerType));

const isResultLikeAwaitedType = (context: RuleContext, node: ts.Node, type: ts.Type): boolean =>
  everyUnionPart(context, type, (innerType) =>
    isResultLikeType(context.tsApi, context.checker, node, innerType),
  );

const getPromisedTypeOfPromise = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): ts.Type | undefined => {
  if (type === undefined) {
    return undefined;
  }

  const checker = context.checker as ts.TypeChecker & {
    readonly getPromisedTypeOfPromise?: (type: ts.Type, errorNode?: ts.Node) => ts.Type | undefined;
  };

  return checker.getPromisedTypeOfPromise?.(type, node);
};

const isPromiseTypeName = (typeName: string): boolean => /^Promise(?:Like)?<.+>$/u.test(typeName);

const splitTopLevelGenericArguments = (value: string): readonly string[] => {
  const argumentsText: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "<" || char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ">" || char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      argumentsText.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  argumentsText.push(value.slice(start).trim());

  return argumentsText;
};

const getGenericArgumentTexts = (
  typeName: string,
  genericName: string,
): readonly string[] | undefined => {
  const prefix = `${genericName}<`;
  const qualifiedPrefix = `.${genericName}<`;

  if (!typeName.endsWith(">")) {
    return undefined;
  }

  if (typeName.startsWith(prefix)) {
    return splitTopLevelGenericArguments(typeName.slice(prefix.length, -1));
  }

  const qualifiedIndex = typeName.lastIndexOf(qualifiedPrefix);

  if (qualifiedIndex === -1 || typeName.slice(0, qualifiedIndex).includes("<")) {
    return undefined;
  }

  return splitTopLevelGenericArguments(typeName.slice(qualifiedIndex + qualifiedPrefix.length, -1));
};

const getSingleGenericArgumentText = (
  typeName: string,
  genericName: string,
): string | undefined => {
  const argumentTexts = getGenericArgumentTexts(typeName, genericName);

  return argumentTexts?.length === 1 ? argumentTexts[0] : undefined;
};

const resultLikeTypeNamePattern =
  /^(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)(?:<|$)/u;

const isResultLikeTypeName = (typeName: string): boolean =>
  typeName.split(/\s*[|&]\s*/u).some((part) => resultLikeTypeNamePattern.test(part.trim()));

const isResultarChannelAwaitExpression = (
  context: RuleContext,
  expression: ts.Expression,
): boolean => {
  const expressionType = context.checker.getTypeAtLocation(expression);

  if (expressionType === undefined) {
    return false;
  }

  if (isResultAsyncLikeAwaitType(context, expression, expressionType)) {
    return true;
  }

  const promisedType = getPromisedTypeOfPromise(context, expression, expressionType);

  if (promisedType !== undefined) {
    return isResultLikeAwaitedType(context, expression, promisedType);
  }

  const promiseTypeName =
    getSingleGenericArgumentText(getTypeName(context, expression, expressionType), "Promise") ??
    getSingleGenericArgumentText(getTypeName(context, expression, expressionType), "PromiseLike");

  return promiseTypeName !== undefined && isResultLikeTypeName(promiseTypeName);
};

const isSafeAwaitExpression = (
  context: RuleContext,
  expression: ts.Expression,
  ignoredCallPaths: ReadonlySet<string>,
): boolean => {
  if (isIgnoredUnsafeAwaitCallExpression(context, expression, ignoredCallPaths)) {
    return true;
  }

  if (isRunPromiseAwaitExpression(context, expression)) {
    return true;
  }

  if (isResultarChannelAwaitExpression(context, expression)) {
    return true;
  }

  const expressionType = context.checker.getTypeAtLocation(expression);

  return (
    getPromisedTypeOfPromise(context, expression, expressionType) === undefined &&
    !isPromiseTypeName(getTypeName(context, expression, expressionType))
  );
};

function isIgnoredUnsafeAwaitCallExpression(
  context: RuleContext,
  expression: ts.Expression,
  ignoredCallPaths: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapExpression(context.tsApi, expression);

  if (!context.tsApi.isCallExpression(unwrapped)) {
    return false;
  }

  const callPath = getCallPath(context.tsApi, unwrapped.expression);

  return callPath !== undefined && ignoredCallPaths.has(callPath);
}

function isRunPromiseAwaitExpression(context: RuleContext, expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(context.tsApi, expression);

  if (!context.tsApi.isCallExpression(unwrapped)) {
    return false;
  }

  if (getExpressionName(context.tsApi, unwrapped.expression) !== "runPromise") {
    return false;
  }

  const [resultArgument] = unwrapped.arguments;

  if (resultArgument === undefined) {
    return false;
  }

  const argumentType = context.checker.getTypeAtLocation(resultArgument);

  return (
    argumentType !== undefined && isResultAsyncLikeAwaitType(context, resultArgument, argumentType)
  );
}

const isPromiseOfResultLikeType = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): boolean => {
  if (type === undefined) {
    return false;
  }

  const unionOrIntersectionTypes = getUnionOrIntersectionTypes(context, type);

  if (unionOrIntersectionTypes !== undefined) {
    return unionOrIntersectionTypes.some((innerType) =>
      isPromiseOfResultLikeType(context, node, innerType),
    );
  }

  const promisedType = getPromisedTypeOfPromise(context, node, type);

  if (promisedType !== undefined) {
    return isResultLikeAwaitedType(context, node, promisedType);
  }

  const promiseTypeName =
    getSingleGenericArgumentText(getTypeName(context, node, type), "Promise") ??
    getSingleGenericArgumentText(getTypeName(context, node, type), "PromiseLike");

  return promiseTypeName !== undefined && isResultLikeTypeName(promiseTypeName);
};

const isResultarAsyncContextReturnType = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): boolean =>
  (type !== undefined && isResultAsyncLikeType(context, node, type)) ||
  isPromiseOfResultLikeType(context, node, type);

const getFunctionLikeReturnType = (context: RuleContext, node: ts.Node): ts.Type | undefined => {
  if (!isFunctionLike(context.tsApi, node)) {
    return undefined;
  }

  const signature = context.checker.getSignatureFromDeclaration(node);

  if (signature !== undefined) {
    return context.checker.getReturnTypeOfSignature(signature);
  }

  const functionType = context.checker.getTypeAtLocation(node);

  if (functionType === undefined) {
    return undefined;
  }

  const [callSignature] = context.checker.getSignaturesOfType(
    functionType,
    context.tsApi.SignatureKind.Call,
  );

  return callSignature === undefined
    ? undefined
    : context.checker.getReturnTypeOfSignature(callSignature);
};

const isResultarAsyncFunctionContext = (context: RuleContext, node: ts.Node): boolean => {
  if (!isFunctionLike(context.tsApi, node)) {
    return false;
  }

  const returnType = getFunctionLikeReturnType(context, node);

  return returnType !== undefined && isResultarAsyncContextReturnType(context, node, returnType);
};

const isUnknownOrAnyType = (tsApi: TypeScriptApi, type: ts.Type | undefined): boolean =>
  type !== undefined &&
  (Boolean(type.flags & tsApi.TypeFlags.Unknown) || Boolean(type.flags & tsApi.TypeFlags.Any));

const isNeverType = (tsApi: TypeScriptApi, type: ts.Type | undefined): boolean =>
  type !== undefined && Boolean(type.flags & tsApi.TypeFlags.Never);

const getReturnedExpressions = (
  tsApi: TypeScriptApi,
  callback: ts.Expression,
): readonly ts.Expression[] => {
  const expressions: ts.Expression[] = [];

  if (!tsApi.isArrowFunction(callback) && !tsApi.isFunctionExpression(callback)) {
    return expressions;
  }

  if (tsApi.isArrowFunction(callback) && !tsApi.isBlock(callback.body)) {
    return [callback.body];
  }

  const { body } = callback;
  const visitReturnedExpressions = (node: ts.Node): void => {
    if (node !== body && isFunctionLike(tsApi, node)) {
      return;
    }

    if (tsApi.isReturnStatement(node) && node.expression !== undefined) {
      expressions.push(node.expression);
      return;
    }

    tsApi.forEachChild(node, visitReturnedExpressions);
  };

  visitReturnedExpressions(body);

  return expressions;
};

const isFunctionLike = (tsApi: TypeScriptApi, node: ts.Node): node is SafeTryBody =>
  tsApi.isArrowFunction(node) ||
  tsApi.isFunctionDeclaration(node) ||
  tsApi.isFunctionExpression(node) ||
  tsApi.isMethodDeclaration(node);

const isErrConstructorCall = (tsApi: TypeScriptApi, expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(tsApi, expression);

  if (!tsApi.isCallExpression(unwrapped)) {
    return false;
  }

  return getExpressionName(tsApi, unwrapped.expression) === "err";
};

const hasObjectCatchProperty = (tsApi: TypeScriptApi, expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(tsApi, expression);

  if (!tsApi.isObjectLiteralExpression(unwrapped)) {
    return false;
  }

  return unwrapped.properties.some((property) => {
    if (tsApi.isPropertyAssignment(property) || tsApi.isMethodDeclaration(property)) {
      return getPropertyNameText(tsApi, property.name) === "catch";
    }

    return false;
  });
};

const hasMapperArgument = (tsApi: TypeScriptApi, call: ts.CallExpression): boolean => {
  const [firstArgument, secondArgument] = call.arguments;

  return (
    secondArgument !== undefined ||
    (firstArgument !== undefined && hasObjectCatchProperty(tsApi, firstArgument))
  );
};

const getObjectTryBody = (
  tsApi: TypeScriptApi,
  objectLiteral: ts.ObjectLiteralExpression,
): SafeTryBody | undefined => {
  for (const property of objectLiteral.properties) {
    if (
      tsApi.isMethodDeclaration(property) &&
      getPropertyNameText(tsApi, property.name) === "try"
    ) {
      return property;
    }

    if (
      tsApi.isPropertyAssignment(property) &&
      getPropertyNameText(tsApi, property.name) === "try" &&
      (tsApi.isArrowFunction(property.initializer) ||
        tsApi.isFunctionExpression(property.initializer))
    ) {
      return property.initializer;
    }
  }

  return undefined;
};

const getSafeTryBody = (tsApi: TypeScriptApi, call: ts.CallExpression): SafeTryBody | undefined => {
  if (getExpressionName(tsApi, call.expression) !== "safeTry") {
    return undefined;
  }

  const [firstArgument] = call.arguments;

  if (firstArgument === undefined) {
    return undefined;
  }

  const unwrapped = unwrapExpression(tsApi, firstArgument);

  if (tsApi.isArrowFunction(unwrapped) || tsApi.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }

  if (!tsApi.isObjectLiteralExpression(unwrapped)) {
    return undefined;
  }

  return getObjectTryBody(tsApi, unwrapped);
};

const getResultarAwaitBoundaryBody = (
  tsApi: TypeScriptApi,
  call: ts.CallExpression,
): SafeTryBody | undefined => {
  const callName = getExpressionName(tsApi, call.expression);

  if (callName === undefined || !asyncAwaitBoundaryCallNames.has(callName)) {
    return undefined;
  }

  const [firstArgument] = call.arguments;

  if (firstArgument === undefined) {
    return undefined;
  }

  const unwrapped = unwrapExpression(tsApi, firstArgument);

  if (tsApi.isArrowFunction(unwrapped) || tsApi.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }

  if (tsApi.isObjectLiteralExpression(unwrapped)) {
    return getObjectTryBody(tsApi, unwrapped);
  }

  return undefined;
};

const getResultarAwaitContextBody = (
  tsApi: TypeScriptApi,
  call: ts.CallExpression,
): SafeTryBody | undefined =>
  getSafeTryBody(tsApi, call) ?? getResultarAwaitBoundaryBody(tsApi, call);

const visitSafeTryBody = (
  tsApi: TypeScriptApi,
  body: SafeTryBody,
  visitor: (node: ts.Node) => void,
): void => {
  const root = body.body;

  if (root === undefined) {
    return;
  }

  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(tsApi, node)) {
      return;
    }

    visitor(node);
    tsApi.forEachChild(node, visit);
  };

  visit(root);
};

const getCreateTaggedErrorOptions = (
  tsApi: TypeScriptApi,
  node: ts.ClassDeclaration,
): ts.ObjectLiteralExpression | undefined => {
  for (const heritageClause of node.heritageClauses ?? []) {
    if (heritageClause.token !== tsApi.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const heritageType of heritageClause.types) {
      const { expression } = heritageType;

      if (
        tsApi.isCallExpression(expression) &&
        getExpressionName(tsApi, expression.expression) === "createTaggedError"
      ) {
        const [options] = expression.arguments;

        return options !== undefined && tsApi.isObjectLiteralExpression(options)
          ? options
          : undefined;
      }
    }
  }

  return undefined;
};

const getTaggedErrorName = (
  tsApi: TypeScriptApi,
  options: ts.ObjectLiteralExpression,
): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined => {
  for (const property of options.properties) {
    if (
      tsApi.isPropertyAssignment(property) &&
      getPropertyNameText(tsApi, property.name) === "name" &&
      (tsApi.isStringLiteral(property.initializer) ||
        tsApi.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      return property.initializer;
    }
  }

  return undefined;
};

const classExtendsNativeError = (tsApi: TypeScriptApi, node: ts.ClassDeclaration): boolean =>
  (node.heritageClauses ?? []).some(
    (heritageClause) =>
      heritageClause.token === tsApi.SyntaxKind.ExtendsKeyword &&
      heritageClause.types.some(
        (heritageType) => getExpressionName(tsApi, heritageType.expression) === "Error",
      ),
  );

const isNativeErrorInstance = (tsApi: TypeScriptApi, expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(tsApi, expression);

  return (
    tsApi.isNewExpression(unwrapped) && getExpressionName(tsApi, unwrapped.expression) === "Error"
  );
};

const getFirstResultErrorTypes = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): readonly ts.Type[] =>
  getResultTypeParts(context, node, type)
    .map((part) => part.error)
    .filter((errorType): errorType is ts.Type => errorType !== undefined);

const getFirstResultErrorTypeName = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type | undefined,
): string | undefined => {
  if (type === undefined) {
    return undefined;
  }

  const typeName = getTypeName(context, node, type);

  for (const resultLikeTypeName of resultLikeTypeNames) {
    const argumentTexts = getGenericArgumentTexts(typeName, resultLikeTypeName);
    const errorTypeName = argumentTexts?.[1]?.trim();

    if (errorTypeName !== undefined && errorTypeName !== "") {
      return errorTypeName;
    }
  }

  return undefined;
};

const getPreferMapErrFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    const call = context.tsApi.isCallExpression(node) ? node : undefined;
    const methodCall = getMethodCall(context.tsApi, node);

    if (call === undefined || methodCall?.methodName !== "orElse") {
      return;
    }

    if (!isResultLikeExpression(context, methodCall.receiver)) {
      return;
    }

    const [callback] = call.arguments;
    const returnedExpressions =
      callback === undefined ? [] : getReturnedExpressions(context.tsApi, callback);

    if (
      returnedExpressions.length === 0 ||
      !returnedExpressions.every(
        (expression) =>
          isErrConstructorCall(context.tsApi, expression) &&
          isResultLikeExpression(context, expression),
      )
    ) {
      return;
    }

    findings.push(
      createFinding(
        context,
        methodCall.nameNode,
        "prefer-map-err",
        severity,
        "`orElse` only replaces the failure with another Err. Use `mapErr` when the Ok value cannot recover.",
      ),
    );
  });

  return findings;
};

const getPreferAndThenFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    const call = context.tsApi.isCallExpression(node) ? node : undefined;
    const methodCall = getMethodCall(context.tsApi, node);

    if (call === undefined || methodCall?.methodName !== "map") {
      return;
    }

    const receiverType = context.checker.getTypeAtLocation(methodCall.receiver);

    if (!isResultLikeType(context.tsApi, context.checker, methodCall.receiver, receiverType)) {
      return;
    }

    const [callback] = call.arguments;
    const returnedExpressions =
      callback === undefined ? [] : getReturnedExpressions(context.tsApi, callback);
    const returnedResult = returnedExpressions.find((expression) =>
      isResultLikeExpression(context, expression),
    );

    if (returnedResult === undefined) {
      return;
    }

    const returnedType = context.checker.getTypeAtLocation(returnedResult);
    const receiverIsResultAsync =
      receiverType !== undefined &&
      isResultAsyncLikeType(context, methodCall.receiver, receiverType);
    const returnedIsResultAsync =
      returnedType !== undefined && isResultAsyncLikeType(context, returnedResult, returnedType);
    const methodName = !receiverIsResultAsync && returnedIsResultAsync ? "asyncAndThen" : "andThen";

    findings.push(
      createFinding(
        context,
        methodCall.nameNode,
        "prefer-and-then",
        severity,
        `\`map\` creates a nested Result when its callback returns ${getTypeName(
          context,
          returnedResult,
          returnedType,
        )}. Use \`${methodName}\` for fallible composition.`,
      ),
    );
  });

  return findings;
};

const getTypedCatchMapperFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const callName = getExpressionName(context.tsApi, node.expression);

    if (
      callName === undefined ||
      !tryMapperCallNames.has(callName) ||
      hasMapperArgument(context.tsApi, node)
    ) {
      return;
    }

    if (callName !== "fromThrowable" && callName !== "fromThrowableAsync") {
      const returnType = context.checker.getTypeAtLocation(node);
      const errorTypes = getFirstResultErrorTypes(context, node, returnType);

      if (
        errorTypes.length > 0 &&
        errorTypes.every((errorType) => !isUnknownOrAnyType(context.tsApi, errorType))
      ) {
        return;
      }
    }

    findings.push(
      createFinding(
        context,
        node.expression,
        "typed-catch-mapper",
        severity,
        `\`${callName}\` without a catch mapper leaves the error channel as \`unknown\`. Map the caught value to a specific Resultar error.`,
      ),
    );
  });

  return findings;
};

const getNoThrowFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isThrowStatement(node)) {
      return;
    }

    findings.push(
      createFinding(
        context,
        node,
        "no-throw",
        severity,
        "Do not throw for expected Resultar failures. Return `Err`/`errAsync` or wrap uncontrolled external code with a Resultar catch boundary.",
      ),
    );
  });

  return findings;
};

const collectResultarAwaitBoundaryBodies = (context: RuleContext): ReadonlySet<ts.Node> => {
  const bodies = new Set<ts.Node>();

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const body = getResultarAwaitBoundaryBody(context.tsApi, node);

    if (body !== undefined) {
      bodies.add(body);
    }
  });

  return bodies;
};

const collectResultarAwaitContextBodies = (context: RuleContext): ReadonlySet<ts.Node> => {
  const bodies = new Set<ts.Node>();

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const body = getResultarAwaitContextBody(context.tsApi, node);

    if (body !== undefined) {
      bodies.add(body);
    }
  });

  return bodies;
};

const getNoUnsafeAwaitFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
  mode: NoUnsafeAwaitMode,
  ignoredCalls: readonly string[],
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];
  const boundaryBodies = collectResultarAwaitBoundaryBodies(context);
  const contextBodies = collectResultarAwaitContextBodies(context);
  const ignoredCallPaths = new Set(ignoredCalls);

  const visit = (
    node: ts.Node,
    insideResultarBoundary: boolean,
    insideResultarContext: boolean,
  ): void => {
    const startsResultarBoundary = boundaryBodies.has(node);
    const currentInsideBoundary = insideResultarBoundary || startsResultarBoundary;
    const startsResultarContext =
      contextBodies.has(node) || isResultarAsyncFunctionContext(context, node);
    const currentInsideContext = insideResultarContext || startsResultarContext;
    const shouldCheckAwait = mode === "all" || currentInsideContext;

    if (shouldCheckAwait && context.tsApi.isAwaitExpression(node) && !currentInsideBoundary) {
      if (isResultarChannelAwaitExpression(context, node.expression) && !currentInsideContext) {
        findings.push(
          createFinding(
            context,
            node,
            "no-unsafe-await",
            severity,
            "Do not unwrap a Resultar async value inside a raw Promise boundary. Return ResultAsync or Promise<Result> so failures stay in the Resultar error channel.",
          ),
        );
      } else if (!isSafeAwaitExpression(context, node.expression, ignoredCallPaths)) {
        findings.push(
          createFinding(
            context,
            node,
            "no-unsafe-await",
            severity,
            "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel.",
          ),
        );
      }
    }

    if (node !== context.sourceFile && isFunctionLike(context.tsApi, node)) {
      context.tsApi.forEachChild(node, (child) => {
        visit(child, startsResultarBoundary, startsResultarContext);
      });
      return;
    }

    context.tsApi.forEachChild(node, (child) => {
      visit(child, currentInsideBoundary, currentInsideContext);
    });
  };

  visit(context.sourceFile, false, false);

  return findings;
};

const getNoTryCatchInSafeTryFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const safeTryBody = getSafeTryBody(context.tsApi, node);

    if (safeTryBody === undefined) {
      return;
    }

    visitSafeTryBody(context.tsApi, safeTryBody, (bodyNode) => {
      if (context.tsApi.isTryStatement(bodyNode)) {
        findings.push(
          createFinding(
            context,
            bodyNode,
            "no-try-catch-in-safe-try",
            severity,
            "Avoid raw try/catch inside `safeTry`. Use `safeTry({ try, catch })`, `tryResult`, or `tryResultAsync` to keep failures typed.",
          ),
        );
      }
    });
  });

  return findings;
};

const getNoTryCatchFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isTryStatement(node) || node.catchClause === undefined) {
      return;
    }

    findings.push(
      createFinding(
        context,
        node,
        "no-try-catch",
        severity,
        "Avoid raw try/catch for expected failures. Use tryResult or tryResultAsync to preserve the typed error channel.",
      ),
    );
  });

  return findings;
};

const getNoAwaitInSafeTryFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const safeTryBody = getSafeTryBody(context.tsApi, node);

    if (safeTryBody === undefined) {
      return;
    }

    visitSafeTryBody(context.tsApi, safeTryBody, (bodyNode) => {
      if (context.tsApi.isAwaitExpression(bodyNode)) {
        findings.push(
          createFinding(
            context,
            bodyNode,
            "no-await-in-safe-try",
            severity,
            "Do not use `await` inside `safeTry`. Use `yield*` for Resultar values and wrap raw Promises before yielding them.",
          ),
        );
      }
    });
  });

  return findings;
};

const getYieldStarInSafeTryFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isCallExpression(node)) {
      return;
    }

    const safeTryBody = getSafeTryBody(context.tsApi, node);

    if (safeTryBody === undefined) {
      return;
    }

    visitSafeTryBody(context.tsApi, safeTryBody, (bodyNode) => {
      if (
        context.tsApi.isYieldExpression(bodyNode) &&
        bodyNode.asteriskToken === undefined &&
        bodyNode.expression !== undefined &&
        isResultLikeExpression(context, bodyNode.expression)
      ) {
        findings.push(
          createFinding(
            context,
            bodyNode,
            "yield-star-in-safe-try",
            severity,
            "Use `yield*` when unwrapping Resultar values inside `safeTry`.",
          ),
        );
      }
    });
  });

  return findings;
};

const getUnsafeResultTypeAssertionFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isAsExpression(node) && !context.tsApi.isTypeAssertionExpression(node)) {
      return;
    }

    const { expression } = node;
    const originalType = context.checker.getTypeAtLocation(expression);
    const assertedType = context.checker.getTypeAtLocation(node);
    const originalParts = getResultTypeParts(context, expression, originalType);
    const assertedParts = getResultTypeParts(context, node, assertedType);

    if (originalParts.length === 0 || assertedParts.length === 0) {
      return;
    }

    const isRenderedUnionNarrowing = (original: ts.Type, asserted: ts.Type): boolean => {
      const originalName = getTypeName(context, expression, original);
      const assertedName = getTypeName(context, node, asserted);

      return (
        originalName !== assertedName &&
        originalName.split(/\s*\|\s*/u).some((part) => part.trim() === assertedName)
      );
    };
    const narrowedErrors = originalParts.flatMap((originalPart) => {
      const originalError = originalPart.error;

      if (originalError === undefined || isUnknownOrAnyType(context.tsApi, originalError)) {
        return [];
      }

      return assertedParts.flatMap((assertedPart) => {
        const assertedError = assertedPart.error;

        if (
          assertedError === undefined ||
          (context.checker.isTypeAssignableTo(originalError, assertedError) &&
            !isRenderedUnionNarrowing(originalError, assertedError))
        ) {
          return [];
        }

        return [{ asserted: assertedError, original: originalError }];
      });
    });

    if (narrowedErrors.length === 0) {
      return;
    }

    const details = narrowedErrors
      .map(
        ({ asserted, original }) =>
          `\`${getTypeName(context, expression, original)}\` to \`${getTypeName(context, node, asserted)}\``,
      )
      .join(", ");

    findings.push(
      createFinding(
        context,
        node,
        "unsafe-result-type-assertion",
        severity,
        `This assertion narrows the Resultar error channel unsafely (${details}). Prefer a real recovery or mapping step.`,
      ),
    );
  });

  return findings;
};

const getPreferTaggedErrorFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (context.tsApi.isClassDeclaration(node) && classExtendsNativeError(context.tsApi, node)) {
      findings.push(
        createFinding(
          context,
          node.name ?? node,
          "prefer-tagged-error",
          severity,
          "Prefer `createTaggedError` for Resultar domain errors so failures keep a stable tag and typed metadata.",
        ),
      );
      return;
    }

    if (context.tsApi.isThrowStatement(node) && node.expression !== undefined) {
      if (isNativeErrorInstance(context.tsApi, node.expression)) {
        findings.push(
          createFinding(
            context,
            node.expression,
            "prefer-tagged-error",
            severity,
            "Prefer a `createTaggedError` instance over throwing `new Error(...)` so failures keep a stable tag and typed metadata.",
          ),
        );
      }

      return;
    }

    if (
      !context.tsApi.isCallExpression(node) ||
      getExpressionName(context.tsApi, node.expression) !== "err"
    ) {
      return;
    }

    const [errorArgument] = node.arguments;

    if (errorArgument === undefined) {
      return;
    }

    if (isNativeErrorInstance(context.tsApi, errorArgument)) {
      findings.push(
        createFinding(
          context,
          errorArgument,
          "prefer-tagged-error",
          severity,
          "Prefer a `createTaggedError` instance over `new Error(...)` in Resultar error channels.",
        ),
      );
    }
  });

  return findings;
};

const getTaggedErrorNameMatchFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (!context.tsApi.isClassDeclaration(node) || node.name === undefined) {
      return;
    }

    const options = getCreateTaggedErrorOptions(context.tsApi, node);
    const nameInitializer =
      options === undefined ? undefined : getTaggedErrorName(context.tsApi, options);
    const className = getIdentifierText(node.name);

    if (nameInitializer === undefined || nameInitializer.text === className) {
      return;
    }

    findings.push(
      createFinding(
        context,
        nameInitializer,
        "tagged-error-name-match",
        severity,
        `Tagged error name \`${nameInitializer.text}\` should match class name \`${className}\`.`,
      ),
    );
  });

  return findings;
};

const getNoTaggedErrorConstructorOverrideFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    if (
      !context.tsApi.isClassDeclaration(node) ||
      getCreateTaggedErrorOptions(context.tsApi, node) === undefined
    ) {
      return;
    }

    for (const member of node.members) {
      if (context.tsApi.isConstructorDeclaration(member)) {
        findings.push(
          createFinding(
            context,
            member,
            "no-tagged-error-constructor-override",
            severity,
            "Do not override the constructor generated by `createTaggedError`; it owns template props, cause, and serialization behavior.",
          ),
        );
      }
    }
  });

  return findings;
};

const getNoUselessRecoveryFindings = (
  context: RuleContext,
  severity: EnabledRuleSeverity,
): readonly ResultarLintFinding[] => {
  const findings: ResultarLintFinding[] = [];

  visitSourceFile(context, (node) => {
    const methodCall = getMethodCall(context.tsApi, node);

    if (methodCall === undefined || !recoveryMethods.has(methodCall.methodName)) {
      return;
    }

    const receiverType = context.checker.getTypeAtLocation(methodCall.receiver);
    const errorTypes = getFirstResultErrorTypes(context, methodCall.receiver, receiverType);
    const errorTypeName = getFirstResultErrorTypeName(context, methodCall.receiver, receiverType);
    const hasNeverErrorChannel =
      errorTypes.length === 0
        ? errorTypeName === "never"
        : errorTypes.every((errorType) => isNeverType(context.tsApi, errorType));

    if (!hasNeverErrorChannel) {
      return;
    }

    findings.push(
      createFinding(
        context,
        methodCall.nameNode,
        "no-useless-recovery",
        severity,
        `\`${methodCall.methodName}\` cannot run because this Resultar value has \`never\` in the error channel.`,
      ),
    );
  });

  return findings;
};

export const getSourceFileResultarFindings = (
  tsApi: TypeScriptApi,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  options: Partial<ResultarRulesOptions> = {},
): readonly ResultarLintFinding[] => {
  const normalizedOptions = normalizeResultarRulesOptions(options);

  if (!shouldInspectSourceFile(sourceFile, normalizedOptions)) {
    return [];
  }

  const context: RuleContext = { checker, sourceFile, tsApi };
  const findings: ResultarLintFinding[] = [];
  const noDiscardSeverity = getRuleSeverity(normalizedOptions, "no-discard");

  if (noDiscardSeverity !== undefined) {
    findings.push(
      ...getSourceFileNoDiscardFindings(tsApi, checker, sourceFile, {
        mode: normalizedOptions.noDiscardMode,
      }).map((finding) => ({ ...finding, severity: noDiscardSeverity })),
    );
  }

  const noUnsafeAwaitSeverity = getRuleSeverity(normalizedOptions, "no-unsafe-await");

  if (noUnsafeAwaitSeverity !== undefined) {
    findings.push(
      ...getNoUnsafeAwaitFindings(
        context,
        noUnsafeAwaitSeverity,
        normalizedOptions.noUnsafeAwaitMode,
        normalizedOptions.noUnsafeAwaitIgnoreCalls,
      ),
    );
  }

  const ruleFns: readonly (readonly [
    Exclude<ResultarRuleName, "no-discard" | "no-unsafe-await">,
    (context: RuleContext, severity: EnabledRuleSeverity) => readonly ResultarLintFinding[],
  ])[] = [
    ["prefer-map-err", getPreferMapErrFindings],
    ["prefer-and-then", getPreferAndThenFindings],
    ["typed-catch-mapper", getTypedCatchMapperFindings],
    ["no-throw", getNoThrowFindings],
    ["no-try-catch", getNoTryCatchFindings],
    ["no-await-in-safe-try", getNoAwaitInSafeTryFindings],
    ["no-try-catch-in-safe-try", getNoTryCatchInSafeTryFindings],
    ["yield-star-in-safe-try", getYieldStarInSafeTryFindings],
    ["unsafe-result-type-assertion", getUnsafeResultTypeAssertionFindings],
    ["prefer-tagged-error", getPreferTaggedErrorFindings],
    ["tagged-error-name-match", getTaggedErrorNameMatchFindings],
    ["no-tagged-error-constructor-override", getNoTaggedErrorConstructorOverrideFindings],
    ["no-useless-recovery", getNoUselessRecoveryFindings],
  ];

  for (const [ruleName, ruleFn] of ruleFns) {
    const severity = getRuleSeverity(normalizedOptions, ruleName);

    if (severity !== undefined) {
      findings.push(...ruleFn(context, severity));
    }
  }

  return findings.toSorted(
    (left, right) => left.start - right.start || left.rule.localeCompare(right.rule),
  );
};

export const getProgramResultarFindings = (
  tsApi: TypeScriptApi,
  program: ts.Program,
  options: Partial<ResultarRulesOptions> = {},
): readonly ResultarLintFinding[] => {
  const checker = program.getTypeChecker();
  const findings: ResultarLintFinding[] = [];
  const normalizedOptions = normalizeResultarRulesOptions(options);

  for (const sourceFile of program.getSourceFiles()) {
    if (shouldInspectSourceFile(sourceFile, normalizedOptions)) {
      findings.push(
        ...getSourceFileResultarFindings(tsApi, checker, sourceFile, normalizedOptions),
      );
    }
  }

  return findings;
};
