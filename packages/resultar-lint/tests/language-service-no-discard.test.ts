import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deepEqual, equal, ok as isTrue, notEqual } from "node:assert";
import { afterEach, beforeAll, describe, it } from "vite-plus/test";

import * as ts from "typescript";

import { getProgramNoDiscardDiagnostics } from "../src/diagnostics.js";
import { patchTypeScriptPackage, unpatchTypeScriptPackage } from "../src/patch.js";
import { createLanguageServicePlugin } from "../src/plugin.js";

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
  options?: { readonly noDiscard: "error" | "off"; readonly noDiscardMode?: "direct" | "must-use" },
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
const workspaceDir = fileURLToPath(new URL("../../..", import.meta.url));
const loadedModules: LoadedLanguageServiceModules = {
  createLanguageServicePlugin,
  getProgramNoDiscardDiagnostics,
  patchTypeScriptPackage,
  unpatchTypeScriptPackage,
};

const getLoadedModules = (): LoadedLanguageServiceModules => loadedModules;

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "resultar-lint", "build"], {
    cwd: workspaceDir,
    stdio: "pipe",
  });
});

const createTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
};

const createFixtureProgram = async (source: string): Promise<ts.Program> => {
  const rootDir = await createTempDir("resultar-lint-");
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

const createLanguageService = (
  source: string,
  config: Record<string, unknown> = { noDiscard: "error" },
): ts.LanguageService => {
  const fileName = join(process.cwd(), "fixture.ts");
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    plugins: [{ name: "resultar-lint" }],
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

  return plugin.create({ config, languageService } as ts.server.PluginCreateInfo);
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
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })),
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

  it("reports assigned-but-unhandled Result values by default", async () => {
    const program = await createFixtureProgram(sourceWithMustUseCases);
    const { getProgramNoDiscardDiagnostics } = getLoadedModules();
    const diagnostics = getProgramNoDiscardDiagnostics(ts, program, { noDiscard: "error" });

    equal(diagnostics.length, 1);
    isTrue(String(diagnostics[0]?.messageText).includes("assigned to `unhandled`"));
  });

  it("reports must-use diagnostics through the TypeScript language service plugin by default", () => {
    const languageService = createLanguageService(sourceWithMustUseCases);
    const diagnostics = languageService.getSemanticDiagnostics(join(process.cwd(), "fixture.ts"));
    const resultarDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.source === "resultar",
    );

    equal(resultarDiagnostics.length, 1);
    isTrue(String(resultarDiagnostics[0]?.messageText).includes("assigned to `unhandled`"));
  });

  it("patches TypeScript so tsc fails builds on Resultar diagnostics", async () => {
    const tempDir = await createTempDir("resultar-lint-patch-");
    const { patchTypeScriptPackage, unpatchTypeScriptPackage } = getLoadedModules();
    const require = createRequire(import.meta.url);
    const sourceTypeScriptDir = dirname(require.resolve("typescript/package.json"));
    const typeScriptDir = join(tempDir, "node_modules", "typescript");
    const lintPackageDir = join(tempDir, "node_modules", "resultar-lint");
    const projectDir = join(tempDir, "project");

    await mkdir(dirname(typeScriptDir), { recursive: true });
    await cp(sourceTypeScriptDir, typeScriptDir, { dereference: true, recursive: true });
    await symlink(join(workspaceDir, "packages/resultar-lint"), lintPackageDir, "dir");
    await unpatchTypeScriptPackage({ dir: typeScriptDir });
    await mkdir(projectDir);
    await writeFile(
      join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          plugins: [{ name: "resultar-lint", noDiscard: "error", preferMapErr: "error" }],
          strict: true,
          target: "ESNext",
        },
        include: ["fixture.ts"],
      }),
    );
    await writeFile(
      join(projectDir, "fixture.ts"),
      `
type Result<T, E> = {
  readonly error?: E
  readonly value?: T
  orElse(callback: (error: E) => Result<T, E>): Result<T, E>
}
declare function err<T, E>(error: E): Result<T, E>
declare function saveUser(input: string): Result<string, Error>
declare function externalFunction(value: unknown): void
saveUser('ignored')
const unhandled = saveUser('unhandled')
externalFunction(unhandled)
saveUser('prefer-map-err').orElse((error) => err(new Error(error.message)))
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
    isTrue(`${patchedRun.stdout}${patchedRun.stderr}`.includes("[resultar/prefer-map-err]"));
    isTrue(`${patchedRun.stdout}${patchedRun.stderr}`.includes("assigned to `unhandled`"));

    await unpatchTypeScriptPackage({ dir: typeScriptDir });
    equal(runTsc().status, 0);
  });
});
