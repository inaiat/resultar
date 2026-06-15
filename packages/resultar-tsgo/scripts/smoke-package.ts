import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;

const rootDir = process.cwd();

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.d.ts",
  "dist/cli.js",
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
    throw new Error(`Missing tsgo package smoke file: ${file}`);
  }
}

const cliSource = readFileSync(join(rootDir, "dist/cli.js"), "utf8");

if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("TSGo wrapper binary is missing the node shebang");
}

const versionOutput = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "--version"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!versionOutput.includes("Version ")) {
  throw new Error("TSGo wrapper version output is missing expected TypeScript version text");
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = sortStrings(parsePackedFiles(packOutput));

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed tsgo package is missing required file: ${file}`);
  }
}

const allowedPackedFile = /^(?:LICENSE|README\.md|package\.json|dist\/[^/]+\.(?:js|d\.ts|map))$/;
const unexpectedFiles = packedFiles.filter((file: string) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed tsgo package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

process.stdout.write(`TSGo package smoke passed with ${packedFiles.length} packed files.\n`);
