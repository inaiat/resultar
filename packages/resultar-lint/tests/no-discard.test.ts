import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deepEqual, equal, ok as isTrue } from "node:assert";
import { afterEach, describe, it } from "node:test";

type NoDiscardModule = typeof import("../src/no-discard.js");

const require = createRequire(import.meta.url);
const { findDiscardedResults } = require("../dist/no-discard.js") as NoDiscardModule;

const tempDirs: string[] = [];

const createFixtureProject = async (
  source: string,
  compilerOptions: Record<string, unknown> = {},
): Promise<string> => {
  const rootDir = await mkdtemp(join(tmpdir(), "resultar-lint-"));
  tempDirs.push(rootDir);

  await writeFile(
    join(rootDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        ...compilerOptions,
        strict: true,
        target: "ESNext",
      },
      include: ["fixture.ts"],
    }),
  );
  await writeFile(join(rootDir, "fixture.ts"), source);

  return rootDir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

describe("no-discard Result check", () => {
  it("flags ignored Result and ResultAsync expressions", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      class ResultAsync<T, E> {
        constructor(readonly result: Result<T, E>) {}
      }
      declare function saveUser(input: string): Result<string, Error>
      declare function saveUserAsync(input: string): ResultAsync<string, Error>

      saveUser('a')
      saveUserAsync('b')
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    const findings = result.findings;
    deepEqual(
      findings.map((finding) => finding.line),
      [9, 10],
    );
    equal(findings[0]?.type, "Result<string, Error>");
    equal(findings[1]?.type, "ResultAsync<string, Error>");
  });

  it("allows explicit void discards and handled results", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      const result = saveUser('a')
      void saveUser('b')
      result.value
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("allows assigned Result values in direct mode", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>
      declare function externalFunction(value: unknown): void

      const result = saveUser('a')
      externalFunction(result)
    `);

    const result = findDiscardedResults({ mode: "direct", rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("flags assigned Result values that are not handled by default", async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = {
        readonly error?: E
        readonly value?: T
        match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
        unwrapOr(defaultValue: T): T
        isErr(): boolean
      }
      declare function saveUser(input: string): Result<string, Error>
      declare function externalFunction(value: unknown): void

      const unhandled = saveUser('unhandled')
      externalFunction(unhandled)

      const matched = saveUser('matched')
      matched.match((value) => value, (error) => error.message)

      const unwrapped = saveUser('unwrapped')
      unwrapped.unwrapOr('fallback')

      const checked = saveUser('checked')
      if (checked.isErr()) {
        externalFunction(checked.error)
      }

      const returned = saveUser('returned')
      function passThrough(): Result<string, Error> {
        return returned
      }

      const discarded = saveUser('discarded')
      void discarded
    `);

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    equal(result.findings.length, 1);
    equal(result.findings[0]?.line, 12);
    equal(
      result.findings[0]?.message,
      "Unhandled Result<string, Error> value assigned to `unhandled`. Handle it, return it, or explicitly discard it with `void`.",
    );
  });

  it("uses direct mode from tsconfig plugin config when no mode is passed", async () => {
    const rootDir = await createFixtureProject(
      `
        type Result<T, E> = { readonly error?: E; readonly value?: T }
        declare function saveUser(input: string): Result<string, Error>
        declare function externalFunction(value: unknown): void

        const unhandled = saveUser('unhandled')
        externalFunction(unhandled)
      `,
      { plugins: [{ name: "resultar-lint", noDiscard: "error", noDiscardMode: "direct" }] },
    );

    const result = findDiscardedResults({ rootDir });

    if (!result.ok) {
      throw result.error;
    }

    deepEqual(result.findings, []);
  });

  it("returns an Err when the project cannot be parsed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "resultar-lint-invalid-"));
    tempDirs.push(rootDir);
    await writeFile(join(rootDir, "tsconfig.json"), "{");

    const result = findDiscardedResults({ rootDir });

    isTrue(!result.ok);
    isTrue(result.error instanceof Error);
  });

  it("resolves TypeScript from the checked project before falling back to the package copy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "resultar-lint-local-ts-"));
    tempDirs.push(rootDir);
    const typeScriptDir = join(rootDir, "node_modules", "typescript");

    await mkdir(typeScriptDir, { recursive: true });
    await writeFile(join(rootDir, "tsconfig.json"), "{}");
    await writeFile(join(typeScriptDir, "package.json"), JSON.stringify({ main: "index.js" }));
    await writeFile(
      join(typeScriptDir, "index.js"),
      `
module.exports = {
  sys: { readFile: () => '' },
  readConfigFile: () => ({ error: {} }),
  formatDiagnosticsWithColorAndContext: () => 'project-local-typescript-used'
}
`,
    );

    const result = findDiscardedResults({ rootDir });

    isTrue(!result.ok);
    isTrue(result.error.message.includes("project-local-typescript-used"));
  });
});
