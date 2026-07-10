import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as ts from "../src/typescript-api.js";
import type { LanguageServiceLike, PluginCreateInfo, PluginModule } from "../src/plugin.js";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;
type ResultarCheckPlugin = ((modules: { readonly typescript: typeof ts }) => PluginModule) & {
  readonly createLanguageServicePlugin: unknown;
  readonly findResultarLintFindings: unknown;
  readonly getProgramResultarDiagnostics: unknown;
  readonly runResultarCheckCli: unknown;
};

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly main?: string;
};
const requirePackage = createRequire(import.meta.url);

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.cjs",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/deno/plugin.cjs",
  "dist/deno/plugin.d.ts",
  "dist/deno/plugin.js",
  "dist/eslint/plugin.cjs",
  "dist/eslint/plugin.d.ts",
  "dist/eslint/plugin.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
  "schema.json",
] as const;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isPackFile = (value: unknown): value is PackFile =>
  isRecord(value) && typeof value.path === "string";

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) && Array.isArray(value.files) && value.files.every(isPackFile);

const parseJsonArrayFromNpmOutput = (packOutput: string): unknown => {
  const trimmed = packOutput.trim();
  let index = trimmed.indexOf("[");

  while (index >= 0) {
    try {
      return JSON.parse(trimmed.slice(index)) as unknown;
    } catch {
      index = trimmed.indexOf("[", index + 1);
    }
  }

  throw new TypeError("npm pack did not include JSON output");
};

const parsePackedFiles = (packOutput: string): readonly string[] => {
  const parsed = parseJsonArrayFromNpmOutput(packOutput);

  if (!Array.isArray(parsed) || !isPackManifest(parsed[0])) {
    throw new TypeError("npm pack returned an unexpected manifest shape");
  }

  return parsed[0].files.map((file) => file.path);
};

const sortStrings = (items: readonly string[]): readonly string[] =>
  [...items].toSorted((left, right) => left.localeCompare(right));

const getPluginInitializer = (value: unknown, label: string): ResultarCheckPlugin => {
  if (typeof value !== "function") {
    throw new TypeError(`${label} should load the plugin initializer function`);
  }

  const plugin = value as Partial<ResultarCheckPlugin>;

  if (typeof plugin.createLanguageServicePlugin !== "function") {
    throw new TypeError(`${label} is missing createLanguageServicePlugin`);
  }

  if (typeof plugin.findResultarLintFindings !== "function") {
    throw new TypeError(`${label} is missing findResultarLintFindings`);
  }

  if (typeof plugin.getProgramResultarDiagnostics !== "function") {
    throw new TypeError(`${label} is missing getProgramResultarDiagnostics`);
  }

  if (typeof plugin.runResultarCheckCli !== "function") {
    throw new TypeError(`${label} is missing runResultarCheckCli`);
  }

  return value as ResultarCheckPlugin;
};

const createFixtureLanguageService = (
  source: string,
): {
  readonly close: () => void;
  readonly fileName: string;
  readonly service: LanguageServiceLike;
} => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "resultar-check-smoke-"));
  const fileName = join(fixtureRoot, "fixture.ts");
  const tsconfigFile = join(fixtureRoot, "tsconfig.json");

  writeFileSync(fileName, source);
  writeFileSync(
    tsconfigFile,
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        plugins: [{ name: "resultar-check" }],
        strict: true,
        target: "ESNext",
      },
      include: ["fixture.ts"],
    }),
  );

  const api = new ts.API({ cwd: fixtureRoot });
  const snapshot = api.updateSnapshot({ openProjects: [tsconfigFile] });
  const project = snapshot.getProject(tsconfigFile) ?? snapshot.getProjects()[0];

  if (project === undefined) {
    api.close();
    throw new Error("Unable to open smoke fixture TypeScript project");
  }

  const sourceFiles = project.program
    .getSourceFileNames()
    .map((sourceFileName) => project.program.getSourceFile(sourceFileName))
    .filter((sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined);
  const program: ts.Program = {
    getSourceFile: (sourceFileName) => project.program.getSourceFile(sourceFileName),
    getSourceFiles: () => sourceFiles,
    getTypeChecker: () => project.checker,
  };

  return {
    close: () => {
      api.close();
      rmSync(fixtureRoot, { force: true, recursive: true });
    },
    fileName,
    service: { getProgram: () => program, getSemanticDiagnostics: () => [] },
  };
};

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing check package smoke file: ${file}`);
  }
}

if (packageJson.main !== "dist/index.cjs") {
  throw new Error("Check package main must point at dist/index.cjs for tsserver require() loading");
}

const help = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "help"], {
  cwd: rootDir,
  encoding: "utf8",
});

const schema = JSON.parse(readFileSync(join(rootDir, "schema.json"), "utf8")) as {
  readonly properties?: { readonly compilerOptions?: unknown };
};

if (schema.properties?.compilerOptions === undefined) {
  throw new Error("Check package schema must describe tsconfig compilerOptions");
}

if (!help.includes("Usage: resultar-check")) {
  throw new Error("Check binary help output is missing expected usage text");
}

const removedCheck = spawnSync(process.execPath, [join(rootDir, "dist/cli.js"), "check"], {
  cwd: rootDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (
  removedCheck.status !== 1 ||
  !`${removedCheck.stdout}${removedCheck.stderr}`.includes("Use resultar-check")
) {
  throw new Error("Check binary should reject the removed check subcommand");
}

const bareCheck = spawnSync(process.execPath, [join(rootDir, "dist/cli.js")], {
  cwd: rootDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (
  bareCheck.status !== 0 ||
  `${bareCheck.stdout}${bareCheck.stderr}`.includes("Usage: resultar-check")
) {
  throw new Error("Check binary should run diagnostics with default arguments");
}

const packageRootEntrypoint = getPluginInitializer(
  requirePackage(rootDir) as unknown,
  "Package root require()",
);

getPluginInitializer(
  requirePackage(join(rootDir, "dist/index.cjs")) as unknown,
  "Direct CJS require()",
);

const cjsEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.cjs")).href)) as {
  readonly default?: Record<PropertyKey, unknown>;
};
const esmEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.js")).href)) as {
  readonly default?: Record<PropertyKey, unknown>;
};

if (typeof cjsEntrypoint.default?.getProgramResultarDiagnostics !== "function") {
  throw new TypeError("CJS Resultar check entrypoint is missing getProgramResultarDiagnostics");
}

if (typeof esmEntrypoint.default?.getProgramResultarDiagnostics !== "function") {
  throw new TypeError("ESM Resultar check entrypoint is missing getProgramResultarDiagnostics");
}

const consumerDir = mkdtempSync(join(tmpdir(), "resultar-check-consumer-"));

try {
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer" }));
  mkdirSync(join(consumerDir, "node_modules"), { recursive: true });
  symlinkSync(
    rootDir,
    join(consumerDir, "node_modules", "resultar-check"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const consumerRequire = createRequire(join(consumerDir, "package.json"));

  getPluginInitializer(
    consumerRequire("resultar-check") as unknown,
    'Consumer require("resultar-check")',
  );
} finally {
  rmSync(consumerDir, { force: true, recursive: true });
}

const fixtureSource = `
type Result<T, E> = { readonly error?: E; readonly value?: T }
declare function saveUser(input: string): Result<string, Error>

saveUser("ignored")
`;
const fixture = createFixtureLanguageService(fixtureSource);
try {
  const pluginModule = packageRootEntrypoint({ typescript: ts });
  const wrappedService = pluginModule.create({
    config: { noDiscard: "error" },
    languageService: fixture.service,
  } satisfies PluginCreateInfo);
  const resultarDiagnostics = wrappedService
    .getSemanticDiagnostics(fixture.fileName)
    .filter((diagnostic) => diagnostic.source === "resultar");

  if (!resultarDiagnostics.some((diagnostic) => diagnostic.code === 91_001)) {
    throw new Error(
      "Package-root plugin initializer did not emit a resultar/no-discard diagnostic",
    );
  }
} finally {
  fixture.close();
}

if (packageJson.bin?.["resultar-no-discard"] !== undefined) {
  throw new Error("Check package should not expose the legacy resultar-no-discard binary");
}

if (packageJson.exports?.["./no-discard"] !== undefined) {
  throw new Error("Check package should not expose the legacy ./no-discard entrypoint");
}

if (packageJson.exports?.["./oxlint"] !== undefined) {
  throw new Error("Check package should not expose the removed ./oxlint entrypoint");
}

for (const exportName of ["./deno", "./eslint"]) {
  if (packageJson.exports?.[exportName] === undefined) {
    throw new Error(`Check package is missing AST lint package export: ${exportName}`);
  }
}

const eslintEntrypoint = (await import(
  pathToFileURL(join(rootDir, "dist/eslint/plugin.js")).href
)) as {
  readonly default?: {
    readonly configs?: { readonly recommended?: { readonly rules?: Record<string, unknown> } };
    readonly meta?: { readonly name?: string };
    readonly rules?: Record<string, unknown>;
  };
};
const denoEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/deno/plugin.js")).href)) as {
  readonly default?: { readonly name?: string; readonly rules?: Record<string, unknown> };
};

if (
  eslintEntrypoint.default?.meta?.name !== "resultar-check" ||
  eslintEntrypoint.default.rules?.["no-await-in-safe-try"] === undefined
) {
  throw new TypeError("ESLint/Oxlint plugin export is missing expected metadata or rules");
}

if (
  eslintEntrypoint.default?.configs?.recommended?.rules?.["resultar/yield-star-in-safe-try"] !==
  "error"
) {
  throw new TypeError("Recommended ESLint/Oxlint config is missing yield-star-in-safe-try");
}

if (
  denoEntrypoint.default?.name !== "resultar" ||
  denoEntrypoint.default.rules?.["typed-catch-mapper"] === undefined
) {
  throw new TypeError("Deno plugin export is missing expected metadata or rules");
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = sortStrings(parsePackedFiles(packOutput));

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed check package is missing required file: ${file}`);
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|package\.json|schema\.json|dist\/(?:[^/]+\/)?[^/]+\.(?:cjs|js|d\.ts|map))$/;
const unexpectedFiles = packedFiles.filter((file: string) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed check package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

process.stdout.write(`Check package smoke passed with ${packedFiles.length} packed files.\n`);
