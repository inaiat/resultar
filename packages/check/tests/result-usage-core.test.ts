import { equal, ok } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it } from "vite-plus/test";
import * as ts from "../src/typescript-api.js";

import {
  isCallLikeDiscard,
  isExplicitDiscard,
  isResultLikeType,
  normalizeNoDiscardMode,
  unwrapExpression,
} from "../src/result-usage-core.js";
import { type FixtureProgram, openFixtureProgram } from "./typescript-fixture.js";

const tempDirs: string[] = [];
const fixtures: FixtureProgram[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
  }

  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

const openSourceFile = async (sourceText: string): Promise<ts.SourceFile> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-check-core-"));
  tempDirs.push(rootDir);

  await writeFile(
    join(rootDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ESNext",
      },
      include: ["fixture.ts"],
    }),
  );
  await writeFile(join(rootDir, "fixture.ts"), sourceText);

  const fixture = openFixtureProgram(rootDir);
  fixtures.push(fixture);

  return fixture.sourceFile;
};

const getInitializer = async (sourceText: string): Promise<ts.Expression> => {
  const sourceFile = await openSourceFile(sourceText);
  const statement = sourceFile.statements.find(ts.isVariableStatement);
  const declaration = statement?.declarationList.declarations[0];

  ok(declaration?.initializer, "Expected fixture variable to have an initializer");
  return declaration.initializer;
};

const getTypeReference = async (sourceText: string): Promise<ts.TypeReferenceNode> => {
  const sourceFile = await openSourceFile(sourceText);
  const statement = sourceFile.statements.find(ts.isTypeAliasDeclaration);

  ok(statement !== undefined && ts.isTypeReferenceNode(statement.type));
  return statement.type;
};

describe("result usage core helpers", () => {
  it("recognizes Result-like types through symbol fallbacks and qualified type references", async () => {
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
    const qualifiedReference = await getTypeReference(
      "type Output = Resultar.StrictResult<string, Error>",
    );
    const anonymousType = { flags: 0 } as unknown as ts.Type;

    equal(isResultLikeType(ts, checker, {} as ts.Node, aliasFallbackType), true);
    equal(isResultLikeType(ts, checker, {} as ts.Node, unionType), true);
    equal(isResultLikeType(ts, checker, qualifiedReference, anonymousType), true);
  });

  it("unwraps supported expression wrappers before classifying discards", async () => {
    const wrappedCall = await getInitializer(`
      const value = ((saveUser() as Result<string, Error>)! satisfies Result<string, Error>)
    `);
    const explicitDiscard = await getInitializer(`
      const value = void (saveUser() as Result<string, Error>)
    `);
    const conditionalDiscard = await getInitializer(`
      const value = flag ? false : saveUser()
    `);
    const nonDiscardBinary = await getInitializer(`
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
