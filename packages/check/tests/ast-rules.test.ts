import { deepEqual, equal } from "node:assert";
import { describe, it } from "vite-plus/test";

import type { AstNode } from "../src/core/ast.js";
import denoPlugin from "../src/deno/plugin.js";
import eslintPlugin from "../src/eslint/plugin.js";
import { type ResultarLintRuleName, rules } from "../src/rules.js";

const identifier = (name: string): AstNode => ({ name, type: "Identifier" });
const literal = (value: string): AstNode => ({ type: "Literal", value });
const callExpression = (name: string, args: readonly AstNode[] = []): AstNode => ({
  arguments: args,
  callee: identifier(name),
  type: "CallExpression",
});
const blockStatement = (body: readonly AstNode[]): AstNode => ({ body, type: "BlockStatement" });
const functionExpression = (body: readonly AstNode[]): AstNode => ({
  body: blockStatement(body),
  type: "FunctionExpression",
});
const expressionStatement = (expression: AstNode): AstNode => ({
  expression,
  type: "ExpressionStatement",
});
const objectExpression = (properties: readonly AstNode[]): AstNode => ({
  properties,
  type: "ObjectExpression",
});
const property = (name: string, value: AstNode): AstNode => ({
  key: identifier(name),
  type: "Property",
  value,
});
const safeTryCall = (body: readonly AstNode[]): AstNode =>
  callExpression("safeTry", [functionExpression(body)]);

const runRule = (
  ruleName: ResultarLintRuleName,
  visitorName: string,
  node: AstNode,
): readonly string[] => {
  const reports: string[] = [];
  const listener = rules[ruleName].create({
    report: (descriptor) => {
      reports.push(descriptor.message);
    },
  });

  listener[visitorName]?.(node);

  return reports;
};

describe("resultar-check AST-only rules", () => {
  it("exports ESLint/Oxlint and Deno plugin surfaces", () => {
    equal(eslintPlugin.rules["no-await-in-safe-try"], rules["no-await-in-safe-try"]);
    equal(denoPlugin.name, "resultar");
    equal(denoPlugin.rules["typed-catch-mapper"], rules["typed-catch-mapper"]);
    equal(eslintPlugin.configs.recommended?.rules?.["resultar/no-await-in-safe-try"], "error");
  });

  it("flags raw throws", () => {
    const reports = runRule("no-throw", "ThrowStatement", {
      argument: callExpression("createTaggedError"),
      type: "ThrowStatement",
    });

    equal(reports.length, 1);
  });

  it("flags raw try/catch inside safeTry", () => {
    const reports = runRule(
      "no-try-catch-in-safe-try",
      "CallExpression",
      safeTryCall([{ handler: {}, type: "TryStatement" }]),
    );

    equal(reports.length, 1);
  });

  it("flags await inside safeTry", () => {
    const awaitedCall = callExpression("loadUser");
    const reports = runRule(
      "no-await-in-safe-try",
      "CallExpression",
      safeTryCall([expressionStatement({ argument: awaitedCall, type: "AwaitExpression" })]),
    );

    equal(reports.length, 1);
  });

  it("flags yield without star inside safeTry", () => {
    const yieldedCall = callExpression("loadUser");
    const reports = runRule(
      "yield-star-in-safe-try",
      "CallExpression",
      safeTryCall([
        expressionStatement({ argument: yieldedCall, delegate: false, type: "YieldExpression" }),
      ]),
    );

    equal(reports.length, 1);
  });

  it("requires typed catch mappers on try helpers", () => {
    const reports = runRule(
      "typed-catch-mapper",
      "CallExpression",
      callExpression("tryResult", [functionExpression([])]),
    );

    equal(reports.length, 1);
  });

  it("allows object catch mappers on try helpers", () => {
    const tryMapper = property("try", functionExpression([]));
    const catchMapper = property("catch", functionExpression([]));
    const options = objectExpression([tryMapper, catchMapper]);
    const reports = runRule(
      "typed-catch-mapper",
      "CallExpression",
      callExpression("tryResultAsync", [options]),
    );

    equal(reports.length, 0);
  });

  it("flags native Error values where tagged errors are expected", () => {
    const reports = [
      ...runRule(
        "prefer-tagged-error",
        "CallExpression",
        callExpression("err", [{ callee: identifier("Error"), type: "NewExpression" }]),
      ),
      ...runRule("prefer-tagged-error", "ClassDeclaration", {
        id: identifier("LegacyError"),
        superClass: identifier("Error"),
        type: "ClassDeclaration",
      }),
      ...runRule("prefer-tagged-error", "ThrowStatement", {
        argument: { callee: identifier("Error"), type: "NewExpression" },
        type: "ThrowStatement",
      }),
    ];

    equal(reports.length, 3);
  });

  it("flags createTaggedError class name mismatches", () => {
    const reports = runRule("tagged-error-name-match", "ClassDeclaration", {
      body: blockStatement([]),
      id: identifier("ActualError"),
      superClass: callExpression("createTaggedError", [
        {
          properties: [
            { key: identifier("name"), type: "Property", value: literal("DifferentError") },
          ],
          type: "ObjectExpression",
        },
      ]),
      type: "ClassDeclaration",
    });

    equal(reports.length, 1);
  });

  it("flags constructors on createTaggedError classes", () => {
    const reports = runRule("no-tagged-error-constructor-override", "ClassDeclaration", {
      body: blockStatement([{ kind: "constructor", type: "MethodDefinition" }]),
      id: identifier("ActualError"),
      superClass: callExpression("createTaggedError", [
        {
          properties: [
            { key: identifier("name"), type: "Property", value: literal("ActualError") },
          ],
          type: "ObjectExpression",
        },
      ]),
      type: "ClassDeclaration",
    });

    equal(reports.length, 1);
  });

  it("keeps recommended rule names stable", () => {
    deepEqual(Object.keys(rules).toSorted(), [
      "no-await-in-safe-try",
      "no-tagged-error-constructor-override",
      "no-throw",
      "no-try-catch-in-safe-try",
      "prefer-tagged-error",
      "tagged-error-name-match",
      "typed-catch-mapper",
      "yield-star-in-safe-try",
    ]);
  });
});
