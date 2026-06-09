import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deepEqual, equal, notEqual, ok as isTrue } from "node:assert";
import { afterEach, before, describe, it } from "node:test";

import * as ts from "typescript";

interface TypeScriptPatchResult {
  readonly modules: readonly TypeScriptPatchModuleStatus[];
  readonly typescriptVersion: string;
}

interface TypeScriptPatchModuleStatus {
  readonly changed: boolean;
  readonly file: string;
  readonly patched: boolean;
}

type CreateLanguageServicePlugin = (modules: { readonly typescript: typeof ts }) => {
  readonly create: (info: ts.server.PluginCreateInfo) => ts.LanguageService;
};

type GetProgramNoDiscardDiagnostics = (
  tsApi: typeof ts,
  program: ts.Program,
) => readonly ts.Diagnostic[];

type TypeScriptPatchCommand = (options: {
  readonly dir?: string;
}) => Promise<TypeScriptPatchResult>;

interface LoadedLanguageServiceModules {
  readonly createLanguageServicePlugin: CreateLanguageServicePlugin;
  readonly getProgramNoDiscardDiagnostics: GetProgramNoDiscardDiagnostics;
  readonly patchTypeScriptPackage: TypeScriptPatchCommand;
  readonly unpatchTypeScriptPackage: TypeScriptPatchCommand;
}

const tempDirs: string[] = [];
let loadedModules: LoadedLanguageServiceModules | undefined = undefined;
const workspaceDir = fileURLToPath(new URL("../../..", import.meta.url));

const getLoadedModules = (): LoadedLanguageServiceModules => {
  if (loadedModules === undefined) {
    throw new Error("Language-service modules were not loaded");
  }

  return loadedModules;
};

before(() => {
  execFileSync("pnpm", ["--filter", "resultar-ls", "build"], { cwd: workspaceDir, stdio: "pipe" });

  const require = createRequire(import.meta.url);
  const distDir = join(workspaceDir, "packages/resultar-ls/dist");
  const diagnostics = require(join(distDir, "diagnostics.js")) as {
    readonly getProgramNoDiscardDiagnostics: GetProgramNoDiscardDiagnostics;
  };
  const patch = require(join(distDir, "patch.js")) as {
    readonly patchTypeScriptPackage: TypeScriptPatchCommand;
    readonly unpatchTypeScriptPackage: TypeScriptPatchCommand;
  };
  const plugin = require(join(distDir, "plugin.js")) as {
    readonly createLanguageServicePlugin: CreateLanguageServicePlugin;
  };

  loadedModules = {
    createLanguageServicePlugin: plugin.createLanguageServicePlugin,
    getProgramNoDiscardDiagnostics: diagnostics.getProgramNoDiscardDiagnostics,
    patchTypeScriptPackage: patch.patchTypeScriptPackage,
    unpatchTypeScriptPackage: patch.unpatchTypeScriptPackage,
  };
});

const createTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
};

const createFixtureProgram = async (source: string): Promise<ts.Program> => {
  const rootDir = await createTempDir("resultar-ls-");
  const sourceFile = join(rootDir, "fixture.ts");
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
      include: ["fixture.ts"],
    }),
  );

  const config = ts.readConfigFile(tsconfigFile, (fileName) => ts.sys.readFile(fileName));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
    undefined,
    tsconfigFile,
  );

  return ts.createProgram(parsed.fileNames, parsed.options);
};

const createLanguageService = (source: string): ts.LanguageService => {
  const fileName = join(process.cwd(), "fixture.ts");
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    plugins: [{ name: "resultar-ls" }],
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host: ts.LanguageServiceHost = {
    directoryExists: (directoryName) => ts.sys.directoryExists(directoryName),
    fileExists: (requestedFileName) => ts.sys.fileExists(requestedFileName),
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: (directoryName) => ts.sys.getDirectories(directoryName),
    getScriptFileNames: () => [fileName],
    getScriptSnapshot: (requestedFileName) => {
      if (requestedFileName === fileName) {
        return ts.ScriptSnapshot.fromString(source);
      }

      const file = ts.sys.readFile(requestedFileName);

      return file === undefined ? undefined : ts.ScriptSnapshot.fromString(file);
    },
    getScriptVersion: () => "1",
    readDirectory: (...args) => ts.sys.readDirectory(...args),
    readFile: (requestedFileName) => ts.sys.readFile(requestedFileName),
  };
  const languageService = ts.createLanguageService(host);
  const { createLanguageServicePlugin } = getLoadedModules();
  const plugin = createLanguageServicePlugin({ typescript: ts });

  return plugin.create({
    config: { noDiscard: "error" },
    languageService,
  } as ts.server.PluginCreateInfo);
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

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

describe("Resultar language-service no-discard diagnostics", () => {
  it("flags ignored Result and ResultAsync values while allowing handled values", async () => {
    const program = await createFixtureProgram(sourceWithDiscardCases);
    const { getProgramNoDiscardDiagnostics } = getLoadedModules();
    const diagnostics = getProgramNoDiscardDiagnostics(ts, program);

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

  it("reports no-discard diagnostics through the TypeScript language service plugin", () => {
    const languageService = createLanguageService(sourceWithDiscardCases);
    const diagnostics = languageService.getSemanticDiagnostics(join(process.cwd(), "fixture.ts"));
    const resultarDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.source === "resultar",
    );

    deepEqual(
      resultarDiagnostics.map((diagnostic) => diagnostic.code),
      [91_001, 91_001],
    );
  });

  it("patches TypeScript so tsc fails builds on discarded Resultar values", async () => {
    const tempDir = await createTempDir("resultar-ls-patch-");
    const { patchTypeScriptPackage, unpatchTypeScriptPackage } = getLoadedModules();
    const require = createRequire(import.meta.url);
    const sourceTypeScriptDir = dirname(require.resolve("typescript/package.json"));
    const typeScriptDir = join(tempDir, "node_modules", "typescript");
    const projectDir = join(tempDir, "project");

    await mkdir(dirname(typeScriptDir), { recursive: true });
    await cp(sourceTypeScriptDir, typeScriptDir, { dereference: true, recursive: true });
    await unpatchTypeScriptPackage({ dir: typeScriptDir });
    await mkdir(projectDir);
    await writeFile(
      join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          plugins: [{ name: "resultar-ls", noDiscard: "error" }],
          strict: true,
          target: "ESNext",
        },
        include: ["fixture.ts"],
      }),
    );
    await writeFile(
      join(projectDir, "fixture.ts"),
      `
type Result<T, E> = { readonly error?: E; readonly value?: T }
declare function saveUser(input: string): Result<string, Error>
saveUser('ignored')
`,
    );

    const runTsc = () =>
      spawnSync(
        process.execPath,
        [join(typeScriptDir, "lib", "tsc.js"), "-p", projectDir, "--pretty", "false"],
        { encoding: "utf8" },
      );

    equal(runTsc().status, 0);

    await patchTypeScriptPackage({ dir: typeScriptDir });
    const secondPatch = await patchTypeScriptPackage({ dir: typeScriptDir });
    isTrue(secondPatch.modules.every((moduleStatus) => !moduleStatus.changed));

    const patchedRun = runTsc();
    notEqual(patchedRun.status, 0);
    isTrue(`${patchedRun.stdout}${patchedRun.stderr}`.includes("[resultar/noDiscard]"));

    await unpatchTypeScriptPackage({ dir: typeScriptDir });
    equal(runTsc().status, 0);
  });
});
