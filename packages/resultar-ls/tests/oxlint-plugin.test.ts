import { equal, ok as isTrue } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

type OxlintPlugin = typeof import("../src/oxlint-plugin.js");

const require = createRequire(import.meta.url);
const plugin = require("../dist/oxlint-plugin.js") as OxlintPlugin;
const tempDirs: string[] = [];

type OxlintContext = Parameters<(typeof plugin.rules)["no-discard"]["createOnce"]>[0];
type OxlintDiagnostic = Parameters<OxlintContext["report"]>[0];

const createFixtureProject = async (): Promise<{
  readonly rootDir: string;
  readonly sourceFile: string;
}> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-oxlint-plugin-"));
  const sourceFile = join(rootDir, "fixture.ts");
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
  await writeFile(
    sourceFile,
    [
      "type Result<T, E> = { readonly error?: E; readonly value?: T }",
      "declare function saveUser(): Result<string, Error>",
      "",
      "saveUser()",
      "void saveUser()",
      "",
    ].join("\n"),
  );

  return { rootDir, sourceFile };
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

describe("Resultar Oxlint plugin", () => {
  it("exports the resultar/no-discard rule", () => {
    equal(plugin.meta.name, "resultar");
    isTrue(plugin.rules["no-discard"] !== undefined);
    equal(plugin.rules["no-discard"].meta.type, "problem");
    isTrue(plugin.rules["no-discard"].meta.docs.recommended);
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
});
