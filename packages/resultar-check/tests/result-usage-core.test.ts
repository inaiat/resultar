import { equal, ok } from "node:assert";

import { describe, it } from "vite-plus/test";
import * as ts from "typescript";

import {
  isCallLikeDiscard,
  isExplicitDiscard,
  isResultLikeType,
  normalizeNoDiscardMode,
  unwrapExpression,
} from "../src/result-usage-core.js";

const getInitializer = (sourceText: string): ts.Expression => {
  const sourceFile = ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements.find(ts.isVariableStatement);
  const declaration = statement?.declarationList.declarations[0];

  ok(declaration?.initializer, "Expected fixture variable to have an initializer");
  return declaration.initializer;
};

const getTypeReference = (sourceText: string): ts.TypeReferenceNode => {
  const sourceFile = ts.createSourceFile("fixture.ts", sourceText, ts.ScriptTarget.Latest, true);
  const statement = sourceFile.statements.find(ts.isTypeAliasDeclaration);

  ok(statement !== undefined && ts.isTypeReferenceNode(statement.type));
  return statement.type;
};

describe("result usage core helpers", () => {
  it("recognizes Result-like types through symbol fallbacks and qualified type references", () => {
    const checker = {} as ts.TypeChecker;
    const aliasFallbackType = {
      aliasSymbol: { escapedName: "Result" },
      flags: 0,
    } as unknown as ts.Type;
    const symbolFallbackType = {
      flags: 0,
      symbol: { escapedName: "StrictResultAsync" },
    } as unknown as ts.Type;
    const unionType = {
      flags: ts.TypeFlags.Union,
      types: [symbolFallbackType],
    } as unknown as ts.Type;
    const qualifiedReference = getTypeReference(
      "type Output = Resultar.StrictResult<string, Error>",
    );
    const anonymousType = { flags: 0 } as unknown as ts.Type;

    equal(isResultLikeType(ts, checker, {} as ts.Node, aliasFallbackType), true);
    equal(isResultLikeType(ts, checker, {} as ts.Node, unionType), true);
    equal(isResultLikeType(ts, checker, qualifiedReference, anonymousType), true);
  });

  it("unwraps supported expression wrappers before classifying discards", () => {
    const wrappedCall = getInitializer(`
      const value = ((saveUser() as Result<string, Error>)! satisfies Result<string, Error>)
    `);
    const explicitDiscard = getInitializer(`
      const value = void (saveUser() as Result<string, Error>)
    `);
    const conditionalDiscard = getInitializer(`
      const value = flag ? false : saveUser()
    `);
    const nonDiscardBinary = getInitializer(`
      const value = flag + saveUser()
    `);

    equal(ts.isCallExpression(unwrapExpression(ts, wrappedCall)), true);
    equal(isExplicitDiscard(ts, explicitDiscard), true);
    equal(isCallLikeDiscard(ts, conditionalDiscard), true);
    equal(isCallLikeDiscard(ts, nonDiscardBinary), false);
    equal(normalizeNoDiscardMode("direct"), "direct");
    equal(normalizeNoDiscardMode("unknown"), "must-use");
  });
});
