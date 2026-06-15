import { equal, ok as isTrue } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vite-plus/test";

import plugin from "../src/oxlint-plugin.js";

const tempDirs: string[] = [];

type OxlintContext = Parameters<(typeof plugin.rules)["no-discard"]["createOnce"]>[0];
type OxlintDiagnostic = Parameters<OxlintContext["report"]>[0];

const createFixtureProject = async (
  source = [
    "type Result<T, E> = { readonly error?: E; readonly value?: T }",
    "declare function saveUser(): Result<string, Error>",
    "",
    "saveUser()",
    "void saveUser()",
    "",
  ].join("\n"),
  project = "tsconfig.json",
): Promise<{ readonly rootDir: string; readonly sourceFile: string }> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-oxlint-plugin-"));
  const sourceFile = join(rootDir, "fixture.ts");
  tempDirs.push(rootDir);

  await writeFile(
    join(rootDir, project),
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
  await writeFile(sourceFile, source);

  return { rootDir, sourceFile };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("Resultar Oxlint plugin", () => {
  it("exports the resultar/no-discard rule", () => {
    equal(plugin.meta.name, "resultar");
    isTrue(plugin.rules["no-discard"] !== undefined);
    equal(plugin.rules["no-discard"].meta.type, "problem");
    isTrue(plugin.rules["no-discard"].meta.docs.recommended);
    equal(plugin.rules["prefer-map-err"].meta.docs.recommended, false);
    equal(plugin.rules["prefer-map-err"].meta.schema.length, 1);
  });

  it("reports no-discard diagnostics through the Oxlint rule visitor", async () => {
    const { rootDir, sourceFile } = await createFixtureProject();
    const diagnostics: OxlintDiagnostic[] = [];
    const visitor = plugin.rules["no-discard"].createOnce({
      cwd: rootDir,
      filename: sourceFile,
      options: [],
      physicalFilename: sourceFile,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    visitor.Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 4);
    equal(diagnostics[0]?.loc.column, 0);
    equal(
      diagnostics[0]?.message,
      "Ignored Result<string, Error> value. Handle it or explicitly discard it with `void`.",
    );
  });

  it("reports must-use diagnostics through the Oxlint rule visitor by default", async () => {
    const { rootDir, sourceFile } = await createFixtureProject(
      [
        "type Result<T, E> = {",
        "  readonly error?: E",
        "  readonly value?: T",
        "  match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B",
        "}",
        "declare function saveUser(): Result<string, Error>",
        "declare function externalFunction(value: unknown): void",
        "",
        "const unhandled = saveUser()",
        "externalFunction(unhandled)",
        "",
        "const handled = saveUser()",
        "handled.match((value) => value, (error) => error.message)",
        "",
      ].join("\n"),
    );
    const diagnostics: OxlintDiagnostic[] = [];
    const visitor = plugin.rules["no-discard"].createOnce({
      cwd: rootDir,
      filename: sourceFile,
      options: [],
      physicalFilename: sourceFile,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    visitor.Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 9);
    equal(
      diagnostics[0]?.message,
      "Unhandled Result<string, Error> value assigned to `unhandled`. Handle it, return it, or explicitly discard it with `void`.",
    );
  });

  it("uses configured projects and direct mode from rule options", async () => {
    const { rootDir, sourceFile } = await createFixtureProject(
      [
        "type Result<T, E> = { readonly error?: E; readonly value?: T }",
        "declare function saveUser(): Result<string, Error>",
        "",
        "saveUser()",
        "const assigned = saveUser()",
        "void assigned",
        "",
      ].join("\n"),
      "custom-tsconfig.json",
    );
    const diagnostics: OxlintDiagnostic[] = [];
    const visitor = plugin.rules["no-discard"].createOnce({
      cwd: rootDir,
      filename: sourceFile,
      options: [{ mode: "direct", project: "custom-tsconfig.json" }],
      physicalFilename: sourceFile,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    visitor.Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 4);
  });

  it("uses default project when rule options omit project", async () => {
    const { rootDir, sourceFile } = await createFixtureProject();
    const diagnostics: OxlintDiagnostic[] = [];
    const visitor = plugin.rules["no-discard"].createOnce({
      cwd: rootDir,
      filename: sourceFile,
      options: [{ mode: "direct" }],
      physicalFilename: sourceFile,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    visitor.Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 4);
  });

  it("uses filename when Oxlint provides virtual text input", async () => {
    const { rootDir, sourceFile } = await createFixtureProject();
    const diagnostics: OxlintDiagnostic[] = [];
    const visitor = plugin.rules["no-discard"].createOnce({
      cwd: rootDir,
      filename: sourceFile,
      options: [],
      physicalFilename: "<text>",
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    visitor.Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 4);
  });

  it("reports project failures only once for a cached rule result", async () => {
    const { rootDir, sourceFile } = await createFixtureProject();
    const diagnostics: OxlintDiagnostic[] = [];
    const context: OxlintContext = {
      cwd: rootDir,
      filename: sourceFile,
      options: [{ project: "missing-tsconfig.json" }],
      physicalFilename: sourceFile,
      report: (diagnostic) => diagnostics.push(diagnostic),
    };

    plugin.rules["no-discard"].createOnce(context).Program();
    plugin.rules["no-discard"].createOnce(context).Program();

    equal(diagnostics.length, 1);
    equal(diagnostics[0]?.loc.line, 1);
    equal(diagnostics[0]?.loc.column, 0);
    isTrue(diagnostics[0]?.message.startsWith("Resultar check failed:"));
  });
});
