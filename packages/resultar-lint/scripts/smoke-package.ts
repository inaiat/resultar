import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
};

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.cjs",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/index.cjs",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/oxlint-plugin.cjs",
  "dist/oxlint-plugin.d.ts",
  "dist/oxlint-plugin.js",
  "package.json",
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

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing lint package smoke file: ${file}`);
  }
}

const help = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "help"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!help.includes("Usage: resultar-lint")) {
  throw new Error("Lint binary help output is missing expected usage text");
}

const checkHelp = execFileSync(
  process.execPath,
  [join(rootDir, "dist/cli.js"), "check", "--help"],
  { cwd: rootDir, encoding: "utf8" },
);

if (!checkHelp.includes("Usage: resultar-lint check")) {
  throw new Error("Lint check help output is missing expected usage text");
}

const packageRequire = createRequire(join(rootDir, "package.json"));
const cjsEntrypoint = packageRequire("resultar-lint") as Record<PropertyKey, unknown>;
const esmEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.js")).href)) as {
  readonly default?: Record<PropertyKey, unknown>;
};
const oxlintPlugin = (await import(pathToFileURL(join(rootDir, "dist/oxlint-plugin.js")).href)) as {
  readonly default?: { readonly meta?: { readonly name?: string } };
};

if (typeof cjsEntrypoint.getProgramResultarDiagnostics !== "function") {
  throw new TypeError("CJS Resultar lint entrypoint is missing getProgramResultarDiagnostics");
}

if (typeof esmEntrypoint.default?.getProgramResultarDiagnostics !== "function") {
  throw new TypeError("ESM Resultar lint entrypoint is missing getProgramResultarDiagnostics");
}

if (oxlintPlugin.default?.meta?.name !== "resultar") {
  throw new Error("ESM Oxlint plugin entrypoint is missing the Resultar plugin default export");
}

if (packageJson.bin?.["resultar-no-discard"] !== undefined) {
  throw new Error("Lint package should not expose the legacy resultar-no-discard binary");
}

if (packageJson.exports?.["./no-discard"] !== undefined) {
  throw new Error("Lint package should not expose the legacy ./no-discard entrypoint");
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = sortStrings(parsePackedFiles(packOutput));

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed lint package is missing required file: ${file}`);
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|package\.json|dist\/[^/]+\.(?:cjs|js|d\.ts|map))$/;
const unexpectedFiles = packedFiles.filter((file: string) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed lint package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

process.stdout.write(`Lint package smoke passed with ${packedFiles.length} packed files.\n`);
