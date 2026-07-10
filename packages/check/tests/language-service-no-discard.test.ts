import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepEqual, equal, ok as isTrue } from "node:assert";
import { afterEach, beforeAll, describe, it } from "vite-plus/test";

import * as ts from "../src/typescript-api.js";

import { getProgramNoDiscardDiagnostics } from "../src/diagnostics.js";
import {
  createLanguageServicePlugin,
  type LanguageServiceLike,
  type PluginCreateInfo,
} from "../src/plugin.js";
import { type FixtureProgram, openFixtureProgram } from "./typescript-fixture.js";

type CreateLanguageServicePlugin = (modules: { readonly typescript: typeof ts }) => {
  readonly create: (info: PluginCreateInfo) => LanguageServiceLike;
};

type GetProgramNoDiscardDiagnostics = (
  tsApi: typeof ts,
  program: ts.Program,
  options?: {
    readonly ignoreFilePatterns?: readonly string[];
    readonly noDiscard: "error" | "off";
    readonly noDiscardMode?: "direct" | "must-use";
  },
) => readonly ts.Diagnostic[];

interface LoadedLanguageServiceModules {
  readonly createLanguageServicePlugin: CreateLanguageServicePlugin;
  readonly getProgramNoDiscardDiagnostics: GetProgramNoDiscardDiagnostics;
}

const tempDirs: string[] = [];
const fixtures: FixtureProgram[] = [];
const workspaceDir = fileURLToPath(new URL("../../..", import.meta.url));
const loadedModules: LoadedLanguageServiceModules = {
  createLanguageServicePlugin,
  getProgramNoDiscardDiagnostics,
};

const getLoadedModules = (): LoadedLanguageServiceModules => loadedModules;

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "resultar-check", "build"], {
    cwd: workspaceDir,
    stdio: "pipe",
  });
});

const createTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
};

const createFixtureProgram = async (
  source: string,
  fileName = "fixture.ts",
): Promise<FixtureProgram> => {
  const rootDir = await createTempDir("resultar-check-");
  const sourceFile = join(rootDir, fileName);
  const tsconfigFile = join(rootDir, "tsconfig.json");

  await writeFile(sourceFile, source);
  await writeFile(
    tsconfigFile,
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ESNext",
      },
      include: [fileName],
    }),
  );

  const fixture = openFixtureProgram(rootDir, fileName);
  fixtures.push(fixture);

  return fixture;
};

const createLanguageService = async (
  source: string,
  config: Record<string, unknown> = { noDiscard: "error" },
  fileName = "fixture.ts",
): Promise<{ readonly fileName: string; readonly languageService: LanguageServiceLike }> => {
  const fixture = await createFixtureProgram(source, fileName);
  const languageService: LanguageServiceLike = {
    getProgram: () => fixture.program,
    getSemanticDiagnostics: () => [],
  };
  const { createLanguageServicePlugin: loadedCreateLanguageServicePlugin } = getLoadedModules();
  const plugin = loadedCreateLanguageServicePlugin({ typescript: ts });

  return {
    fileName: fixture.sourceFile.fileName,
    languageService: plugin.create({ config, languageService }),
  };
};

const sourceWithDiscardCases = `
type Result<T, E> = { readonly error?: E; readonly value?: T }
class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  then<A, B>(
    successCallback?: (result: Result<T, E>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>,
  ): PromiseLike<A | B> {
    throw new Error('fixture')
  }
}
declare function saveUser(input: string): Result<string, Error>
declare function saveUserAsync(input: string): ResultAsync<string, Error>

saveUser('ignored')
saveUserAsync('ignored-async')
const assigned = saveUser('assigned')
void saveUser('voided')
function returned(): Result<string, Error> {
  return saveUser('returned')
}
async function awaited(): Promise<Result<string, Error>> {
  return await saveUserAsync('awaited')
}
assigned.value
`;

const sourceWithMustUseCases = `
type Result<T, E> = {
  readonly error?: E
  readonly value?: T
  match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
}
declare function saveUser(input: string): Result<string, Error>
declare function externalFunction(value: unknown): void

const unhandled = saveUser('unhandled')
externalFunction(unhandled)

const handled = saveUser('handled')
handled.match((value) => value, (error) => error.message)
`;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
  }

  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("Resultar language-service no-discard diagnostics", () => {
  it("flags ignored Result and ResultAsync values while allowing handled values", async () => {
    const fixture = await createFixtureProgram(sourceWithDiscardCases);
    const { getProgramNoDiscardDiagnostics: loadedGetProgramNoDiscardDiagnostics } =
      getLoadedModules();
    const diagnostics = loadedGetProgramNoDiscardDiagnostics(ts, fixture.program);

    deepEqual(
      diagnostics.map(
        (diagnostic) => diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line,
      ),
      [13, 14],
    );
    equal(diagnostics[0]?.source, "resultar");
    equal(diagnostics[0]?.code, 91_001);
    isTrue(String(diagnostics[0]?.messageText).includes("[resultar/noDiscard]"));
    isTrue(String(diagnostics[1]?.messageText).includes("ResultAsync<string, Error>"));
  });

  it("reports no-discard diagnostics through the TypeScript language service plugin", async () => {
    const { fileName, languageService } = await createLanguageService(sourceWithDiscardCases, {
      noDiscard: "error",
      preferTaggedError: "off",
    });
    const diagnostics = languageService.getSemanticDiagnostics(fileName);
    const resultarDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.source === "resultar",
    );

    deepEqual(
      resultarDiagnostics.map((diagnostic) => diagnostic.code),
      [91_001, 91_001],
    );
  });

  it("ignores files matching configured ignoreFilePatterns through the language service", async () => {
    const { fileName, languageService } = await createLanguageService(
      sourceWithDiscardCases,
      { ignoreFilePatterns: ["*.test.ts"], noDiscard: "error" },
      "fixture.test.ts",
    );
    const diagnostics = languageService.getSemanticDiagnostics(fileName);
    const resultarDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.source === "resultar",
    );

    deepEqual(resultarDiagnostics, []);
  });

  it("reports assigned-but-unhandled Result values by default", async () => {
    const fixture = await createFixtureProgram(sourceWithMustUseCases);
    const { getProgramNoDiscardDiagnostics: loadedGetProgramNoDiscardDiagnostics } =
      getLoadedModules();
    const diagnostics = loadedGetProgramNoDiscardDiagnostics(ts, fixture.program, {
      noDiscard: "error",
    });

    equal(diagnostics.length, 1);
    isTrue(String(diagnostics[0]?.messageText).includes("assigned to `unhandled`"));
  });

  it("reports must-use diagnostics through the TypeScript language service plugin by default", async () => {
    const { fileName, languageService } = await createLanguageService(sourceWithMustUseCases);
    const diagnostics = languageService.getSemanticDiagnostics(fileName);
    const resultarDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.source === "resultar",
    );

    equal(resultarDiagnostics.length, 1);
    isTrue(String(resultarDiagnostics[0]?.messageText).includes("assigned to `unhandled`"));
  });
});
