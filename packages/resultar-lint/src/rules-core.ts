import type * as ts from "typescript";

import type { ResultarLintFinding, ResultarRuleName, ResultarRuleSeverity } from "./finding.js";
import {
  type NoDiscardMode,
  getSourceFileNoDiscardFindings,
  isResultLikeType,
  normalizeNoDiscardMode,
  unwrapExpression,
} from "./result-usage-core.js";

type TypeScriptApi = typeof ts;

type EnabledRuleSeverity = Exclude<ResultarRuleSeverity, "off">;
type ResultarRuleOptionName = Exclude<keyof ResultarRulesOptions, "noDiscardMode">;
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

export interface ResultarRulesOptions {
  readonly noDiscard: ResultarRuleSeverity;
  readonly noDiscardMode: NoDiscardMode;
  readonly noTaggedErrorConstructorOverride: ResultarRuleSeverity;
  readonly noTryCatchInSafeTry: ResultarRuleSeverity;
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
  "no-try-catch-in-safe-try",
  "yield-star-in-safe-try",
  "unsafe-result-type-assertion",
  "prefer-tagged-error",
  "tagged-error-name-match",
  "no-tagged-error-constructor-override",
  "no-useless-recovery",
];

export const ruleOptionNameByRule: Record<ResultarRuleName, ResultarRuleOptionName> = {
  "no-discard": "noDiscard",
  "no-tagged-error-constructor-override": "noTaggedErrorConstructorOverride",
  "no-try-catch-in-safe-try": "noTryCatchInSafeTry",
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
  noDiscard: "error",
  noDiscardMode: "must-use",
  noTaggedErrorConstructorOverride: "warning",
  noTryCatchInSafeTry: "warning",
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

export const normalizeResultarRulesOptions = (
  options: Partial<ResultarRulesOptions> = {},
): ResultarRulesOptions => ({
  noDiscard: normalizeRuleSeverity(options.noDiscard, defaultResultarRulesOptions.noDiscard),
  noDiscardMode: normalizeNoDiscardMode(options.noDiscardMode),
  noTaggedErrorConstructorOverride: normalizeRuleSeverity(
    options.noTaggedErrorConstructorOverride,
    defaultResultarRulesOptions.noTaggedErrorConstructorOverride,
  ),
  noTryCatchInSafeTry: normalizeRuleSeverity(
    options.noTryCatchInSafeTry,
    defaultResultarRulesOptions.noTryCatchInSafeTry,
  ),
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
  const getTokenPos = (
    context.tsApi as unknown as {
      readonly getTokenPosOfNode?: (node: ts.Node, sourceFile?: ts.SourceFile) => number;
    }
  ).getTokenPosOfNode;

  return getTokenPos === undefined ? node.pos : getTokenPos(node, context.sourceFile);
};

const getNodeStart = (context: RuleContext, node: ts.Node): number =>
  typeof node.getStart === "function"
    ? node.getStart(context.sourceFile)
    : getTokenPosOfNode(context, node);

const getIdentifierText = (identifier: IdentifierText): string => {
  if (typeof identifier.text === "string") {
    return identifier.text;
  }

  return identifier.escapedText === undefined ? "" : String(identifier.escapedText);
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

const getTypeName = (context: RuleContext, node: ts.Node, type: ts.Type): string =>
  context.checker.typeToString(type, node, context.tsApi.TypeFormatFlags.NoTruncation);

const getUnionOrIntersectionTypes = (
  context: RuleContext,
  type: ts.Type,
): readonly ts.Type[] | undefined =>
  (type.flags & (context.tsApi.TypeFlags.Union | context.tsApi.TypeFlags.Intersection)) === 0
    ? undefined
    : ((type as ts.UnionOrIntersectionType).types ?? []);

const getTypeArguments = (context: RuleContext, type: ts.Type): readonly ts.Type[] => {
  const { aliasTypeArguments } = type;

  if (aliasTypeArguments !== undefined && aliasTypeArguments.length > 0) {
    return aliasTypeArguments;
  }

  const reference = type as ts.TypeReference;

  return reference.target === undefined ? [] : context.checker.getTypeArguments(reference);
};

const getResultTypeParts = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type,
): readonly ResultTypeParts[] => {
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

  return /\b(?:DisposableResultAsync|ResultAsync|StrictResultAsync)\b/.test(
    getTypeName(context, node, type),
  );
};

const isResultLikeExpression = (context: RuleContext, expression: ts.Expression): boolean => {
  const type = context.checker.getTypeAtLocation(expression);

  return isResultLikeType(context.tsApi, context.checker, expression, type);
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
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionLike(tsApi, node)) {
      return;
    }

    if (tsApi.isReturnStatement(node) && node.expression !== undefined) {
      expressions.push(node.expression);
      return;
    }

    tsApi.forEachChild(node, visit);
  };

  visit(body);

  return expressions;
};

const isFunctionLike = (tsApi: TypeScriptApi, node: ts.Node): boolean =>
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

  for (const property of unwrapped.properties) {
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

const getFirstResultErrorTypes = (
  context: RuleContext,
  node: ts.Node,
  type: ts.Type,
): readonly ts.Type[] =>
  getResultTypeParts(context, node, type)
    .map((part) => part.error)
    .filter((errorType): errorType is ts.Type => errorType !== undefined);

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
    const methodName =
      !isResultAsyncLikeType(context, methodCall.receiver, receiverType) &&
      isResultAsyncLikeType(context, returnedResult, returnedType)
        ? "asyncAndThen"
        : "andThen";

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

    const narrowedErrors = originalParts.flatMap((originalPart) =>
      assertedParts
        .filter(
          (assertedPart) =>
            originalPart.error !== undefined &&
            assertedPart.error !== undefined &&
            !isUnknownOrAnyType(context.tsApi, originalPart.error) &&
            !context.checker.isTypeAssignableTo(originalPart.error, assertedPart.error),
        )
        .map((assertedPart) => ({ asserted: assertedPart.error!, original: originalPart.error! })),
    );

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

    const unwrappedErrorArgument = unwrapExpression(context.tsApi, errorArgument);

    if (
      context.tsApi.isNewExpression(unwrappedErrorArgument) &&
      getExpressionName(context.tsApi, unwrappedErrorArgument.expression) === "Error"
    ) {
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

    if (
      errorTypes.length === 0 ||
      !errorTypes.every((errorType) => isNeverType(context.tsApi, errorType))
    ) {
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

  const ruleFns: readonly (readonly [
    Exclude<ResultarRuleName, "no-discard">,
    (context: RuleContext, severity: EnabledRuleSeverity) => readonly ResultarLintFinding[],
  ])[] = [
    ["prefer-map-err", getPreferMapErrFindings],
    ["prefer-and-then", getPreferAndThenFindings],
    ["typed-catch-mapper", getTypedCatchMapperFindings],
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

  for (const sourceFile of program.getSourceFiles()) {
    if (
      !sourceFile.isDeclarationFile &&
      !sourceFile.fileName.includes("/node_modules/") &&
      !sourceFile.fileName.includes("\\node_modules\\")
    ) {
      findings.push(...getSourceFileResultarFindings(tsApi, checker, sourceFile, options));
    }
  }

  return findings;
};
