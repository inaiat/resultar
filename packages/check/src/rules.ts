import {
  type AstNode,
  classExtendsNativeError,
  classHasConstructor,
  getClassName,
  getCreateTaggedErrorOptions,
  getObjectProperty,
  getSafeTryBody,
  getStringPropertyValue,
  isCallExpressionNamed,
  isNativeErrorNewExpression,
  isNode,
  isTryMapperCall,
  isUnknownArray,
  visitSameFunctionDescendants,
} from "./core/ast.js";

/** Rule names implemented by the Deno Lint and ESLint adapters. */
export type ResultarLintRuleName =
  | "no-await-in-safe-try"
  | "no-tagged-error-constructor-override"
  | "no-throw"
  | "no-try-catch"
  | "no-try-catch-in-safe-try"
  | "prefer-tagged-error"
  | "tagged-error-name-match"
  | "typed-catch-mapper"
  | "yield-star-in-safe-try";

/** A finding reported by a Resultar syntax-only lint rule. */
export interface RuleReportDescriptor {
  /** Human-readable guidance for resolving the finding. */
  readonly message: string;
  /** AST node that caused the finding. */
  readonly node: AstNode;
}

/** Minimal lint-host context consumed by Resultar rule implementations. */
export interface RuleContext {
  /** Reports a finding to the active lint host. */
  readonly report: (descriptor: RuleReportDescriptor) => void;
}

/** AST visitor callbacks returned by a Resultar rule. */
export type RuleListener = Record<string, (node: AstNode) => void>;

/** Host-neutral shape of a Resultar syntax-only lint rule. */
export interface ResultarRuleModule {
  /** Creates the rule's AST listeners for a lint run. */
  readonly create: (context: RuleContext) => RuleListener;
  /** Metadata consumed by Deno Lint and ESLint. */
  readonly meta: {
    readonly docs: { readonly description: string };
    readonly schema: readonly unknown[];
    readonly type: "problem" | "suggestion";
  };
}

const createRule = (
  description: string,
  create: (context: RuleContext) => RuleListener,
  type: "problem" | "suggestion" = "problem",
): ResultarRuleModule => ({ create, meta: { docs: { description }, schema: [], type } });

const reportSafeTryBodyNodes = (
  context: RuleContext,
  callNode: AstNode,
  predicate: (node: AstNode) => boolean,
  message: string,
): void => {
  const safeTryBody = getSafeTryBody(callNode);

  if (safeTryBody === undefined) {
    return;
  }

  visitSameFunctionDescendants(safeTryBody, (node) => {
    if (predicate(node)) {
      context.report({ message, node });
    }
  });
};

const noThrow = createRule("Disallow raw throw statements in Resultar code.", (context) => ({
  ThrowStatement(node) {
    context.report({
      message:
        "Do not throw for expected Resultar failures. Return Err/errAsync or wrap external code with a Resultar catch boundary.",
      node,
    });
  },
}));

const noTryCatch = createRule("Disallow raw try/catch blocks in Resultar code.", (context) => ({
  TryStatement(node) {
    if (!isNode(node.handler) || node.handler.type !== "CatchClause") {
      return;
    }

    context.report({
      message:
        "Avoid raw try/catch for expected failures. Use tryResult or tryResultAsync to preserve the typed error channel.",
      node,
    });
  },
}));

const noTryCatchInSafeTry = createRule(
  "Disallow raw try/catch blocks inside safeTry.",
  (context) => ({
    CallExpression(node) {
      reportSafeTryBodyNodes(
        context,
        node,
        (candidate) => candidate.type === "TryStatement",
        "Avoid raw try/catch inside safeTry. Use safeTry({ try, catch }), tryResult, or tryResultAsync to keep failures typed.",
      );
    },
  }),
);

const noAwaitInSafeTry = createRule("Disallow await inside safeTry bodies.", (context) => ({
  CallExpression(node) {
    reportSafeTryBodyNodes(
      context,
      node,
      (candidate) => candidate.type === "AwaitExpression",
      "Do not use await inside safeTry. Use yield* for Resultar values and wrap raw Promises before yielding them.",
    );
  },
}));

const yieldStarInSafeTry = createRule(
  "Require yield* when unwrapping Resultar values inside safeTry.",
  (context) => ({
    CallExpression(node) {
      reportSafeTryBodyNodes(
        context,
        node,
        (candidate) => candidate.type === "YieldExpression" && candidate.delegate !== true,
        "Use yield* when unwrapping Resultar values inside safeTry.",
      );
    },
  }),
);

const typedCatchMapper = createRule(
  "Require catch mappers for Resultar try helpers.",
  (context) => ({
    CallExpression(node) {
      if (!isTryMapperCall(node) || !isUnknownArray(node.arguments)) {
        return;
      }

      const [firstArgument] = node.arguments;

      if (node.arguments.length >= 2 || getObjectProperty(firstArgument, "catch") !== undefined) {
        return;
      }

      context.report({
        message:
          "Resultar try helpers without a catch mapper leave the error channel as unknown. Map the caught value to a specific Resultar error.",
        node,
      });
    },
  }),
);

const preferTaggedError = createRule(
  "Prefer createTaggedError for Resultar domain errors.",
  (context) => ({
    CallExpression(node) {
      if (
        !isCallExpressionNamed(node, new Set(["err", "errAsync"])) ||
        !Array.isArray(node.arguments) ||
        !isNativeErrorNewExpression(node.arguments[0])
      ) {
        return;
      }

      context.report({
        message:
          "Prefer a createTaggedError instance over new Error(...) in Resultar error channels.",
        node,
      });
    },
    ClassDeclaration(node) {
      if (!classExtendsNativeError(node)) {
        return;
      }

      context.report({
        message: "Prefer createTaggedError for Resultar domain error classes.",
        node,
      });
    },
    ThrowStatement(node) {
      if (!isNativeErrorNewExpression(node.argument)) {
        return;
      }

      context.report({
        message:
          "Prefer createTaggedError over throwing new Error(...) so failures keep a stable tag and typed metadata.",
        node,
      });
    },
  }),
  "suggestion",
);

const taggedErrorNameMatch = createRule(
  "Require createTaggedError name to match the class name.",
  (context) => ({
    ClassDeclaration(node) {
      const options = getCreateTaggedErrorOptions(node);
      const className = getClassName(node);
      const tagName = getStringPropertyValue(options, "name");

      if (className === undefined || tagName === undefined || className === tagName) {
        return;
      }

      context.report({
        message: `Tagged error name ${tagName} should match class name ${className}.`,
        node,
      });
    },
  }),
  "suggestion",
);

const noTaggedErrorConstructorOverride = createRule(
  "Disallow constructors on createTaggedError classes.",
  (context) => ({
    ClassDeclaration(node) {
      if (!isNode(getCreateTaggedErrorOptions(node)) || !classHasConstructor(node)) {
        return;
      }

      context.report({
        message:
          "Do not override the constructor generated by createTaggedError; it owns template props, cause, and serialization behavior.",
        node,
      });
    },
  }),
  "suggestion",
);

/** Syntax-only Resultar rules shared by the Deno Lint and ESLint adapters. */
export const rules: Record<ResultarLintRuleName, ResultarRuleModule> = {
  "no-await-in-safe-try": noAwaitInSafeTry,
  "no-tagged-error-constructor-override": noTaggedErrorConstructorOverride,
  "no-throw": noThrow,
  "no-try-catch": noTryCatch,
  "no-try-catch-in-safe-try": noTryCatchInSafeTry,
  "prefer-tagged-error": preferTaggedError,
  "tagged-error-name-match": taggedErrorNameMatch,
  "typed-catch-mapper": typedCatchMapper,
  "yield-star-in-safe-try": yieldStarInSafeTry,
};

/** Recommended severity for each syntax-only Resultar rule. */
export const recommendedSeverities: Record<ResultarLintRuleName, "error" | "warn"> = {
  "no-await-in-safe-try": "error",
  "no-tagged-error-constructor-override": "warn",
  "no-throw": "warn",
  "no-try-catch": "warn",
  "no-try-catch-in-safe-try": "warn",
  "prefer-tagged-error": "warn",
  "tagged-error-name-match": "warn",
  "typed-catch-mapper": "warn",
  "yield-star-in-safe-try": "error",
};
