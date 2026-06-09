import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;

const rootDir = process.cwd();

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.d.ts",
  "dist/cli.js",
  "dist/diagnostics.d.ts",
  "dist/diagnostics.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/no-discard.d.ts",
  "dist/no-discard.js",
  "dist/package.json",
  "dist/patch.d.ts",
  "dist/patch.js",
  "dist/plugin.d.ts",
  "dist/plugin.js",
  "dist/plugin-options.d.ts",
  "dist/plugin-options.js",
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
  [...items].sort((left, right) => left.localeCompare(right));

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing language-service package smoke file: ${file}`);
  }
}

const help = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "help"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!help.includes("Usage: resultar-ls")) {
  throw new Error("Language-service binary help output is missing expected usage text");
}

const noDiscardHelp = execFileSync(
  process.execPath,
  [join(rootDir, "dist/no-discard.js"), "--help"],
  {
    cwd: rootDir,
    encoding: "utf8",
  },
);

if (!noDiscardHelp.includes("Usage: resultar-no-discard")) {
  throw new Error("Language-service no-discard help output is missing expected usage text");
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = sortStrings(parsePackedFiles(packOutput));

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed language-service package is missing required file: ${file}`);
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|package\.json|dist\/package\.json|dist\/[^/]+\.(?:js|d\.ts))$/;
const unexpectedFiles = packedFiles.filter((file: string) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(
    `Packed language-service package contains unexpected files:\n${unexpectedFiles.join("\n")}`,
  );
}

process.stdout.write(
  `Language-service package smoke passed with ${packedFiles.length} packed files.\n`,
);
