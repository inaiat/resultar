export interface AstNode {
  readonly type?: string;
  readonly [key: string]: unknown;
}

const childKeysToSkip = new Set(["end", "loc", "parent", "range", "start", "type"]);
const functionNodeTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const expressionWrapperTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const tryMapperCallNames = new Set([
  "fromThrowable",
  "fromThrowableAsync",
  "tryAsync",
  "tryCatch",
  "tryCatchAsync",
  "tryResult",
  "tryResultAsync",
]);
const safeTryCallNames = new Set(["safeTry"]);

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

export const isNode = (value: unknown): value is AstNode =>
  isUnknownRecord(value) && typeof value.type === "string";

export const getIdentifierName = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

export const unwrapExpression = (node: unknown): AstNode | undefined => {
  let current = isNode(node) ? node : undefined;

  while (current !== undefined && expressionWrapperTypes.has(current.type ?? "")) {
    current = isNode(current.expression) ? current.expression : undefined;
  }

  return current;
};

export const getCalleeName = (callee: unknown): string | undefined => {
  const unwrapped = unwrapExpression(callee);

  return getIdentifierName(unwrapped);
};

export const isCallExpressionNamed = (node: AstNode, names: ReadonlySet<string>): boolean =>
  node.type === "CallExpression" && names.has(getCalleeName(node.callee) ?? "");

export const isTryMapperCall = (node: AstNode): boolean =>
  isCallExpressionNamed(node, tryMapperCallNames);

export const isNativeErrorNewExpression = (node: unknown): boolean => {
  const unwrapped = unwrapExpression(node);

  return unwrapped?.type === "NewExpression" && getCalleeName(unwrapped.callee) === "Error";
};

export const isCreateTaggedErrorCall = (node: unknown): boolean => {
  const unwrapped = unwrapExpression(node);

  return (
    unwrapped?.type === "CallExpression" && getCalleeName(unwrapped.callee) === "createTaggedError"
  );
};

export const getObjectProperty = (
  objectNode: unknown,
  propertyName: string,
): AstNode | undefined => {
  const unwrapped = unwrapExpression(objectNode);

  const properties = unwrapped?.properties;

  if (unwrapped?.type !== "ObjectExpression" || !isUnknownArray(properties)) {
    return undefined;
  }

  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") {
      continue;
    }

    const keyName =
      getIdentifierName(property.key) ??
      (isNode(property.key) &&
      property.key.type === "Literal" &&
      typeof property.key.value === "string"
        ? property.key.value
        : undefined);

    if (keyName === propertyName && isNode(property.value)) {
      return property.value;
    }
  }

  return undefined;
};

export const getStringPropertyValue = (
  objectNode: unknown,
  propertyName: string,
): string | undefined => {
  const value = getObjectProperty(objectNode, propertyName);

  return value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
};

export const getCreateTaggedErrorOptions = (classNode: AstNode): AstNode | undefined => {
  const superClass = unwrapExpression(classNode.superClass);
  const superClassArguments = superClass?.arguments;

  if (
    superClass === undefined ||
    !isCreateTaggedErrorCall(superClass) ||
    !isUnknownArray(superClassArguments)
  ) {
    return undefined;
  }

  return isNode(superClassArguments[0]) ? superClassArguments[0] : undefined;
};

export const classExtendsNativeError = (classNode: AstNode): boolean =>
  getIdentifierName(unwrapExpression(classNode.superClass)) === "Error";

export const classHasConstructor = (classNode: AstNode): boolean => {
  const classBody = isNode(classNode.body) ? classNode.body.body : undefined;
  const body = isUnknownArray(classBody) ? classBody : [];

  return body.some(
    (member) => isNode(member) && (member.kind === "constructor" || member.type === "Constructor"),
  );
};

export const getClassName = (classNode: AstNode): string | undefined =>
  getIdentifierName(classNode.id);

export const getSafeTryBody = (callNode: AstNode): AstNode | undefined => {
  const callArguments = callNode.arguments;

  if (!isCallExpressionNamed(callNode, safeTryCallNames) || !isUnknownArray(callArguments)) {
    return undefined;
  }

  const [firstArgument] = callArguments;
  const unwrapped = unwrapExpression(firstArgument);

  if (unwrapped !== undefined && functionNodeTypes.has(unwrapped.type ?? "")) {
    return unwrapped;
  }

  return getObjectProperty(unwrapped, "try");
};

export const visitSameFunctionDescendants = (
  root: AstNode,
  visitor: (node: AstNode) => void,
): void => {
  const walk = (node: AstNode): void => {
    for (const key in node) {
      if (childKeysToSkip.has(key)) {
        continue;
      }

      const child = node[key];
      const children = isUnknownArray(child) ? child : [child];

      for (const entry of children) {
        if (!isNode(entry)) {
          continue;
        }

        visitor(entry);

        if (!functionNodeTypes.has(entry.type ?? "")) {
          walk(entry);
        }
      }
    }
  };

  walk(root);
};
