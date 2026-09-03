import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly main?: string;
  readonly module?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly version?: string;
  readonly types?: string;
};
const nativePackageName = `resultar-check-${process.platform}-${process.arch}`;
const nativePackageRoot = join(
  rootDir,
  "native-packages",
  nativePackageName.replace(/^resultar-check-/u, ""),
);
const nativeBinaryPath =
  process.platform === "win32" ? "bin/resultar-check.exe" : "bin/resultar-check";
const nativeExecutable = join(nativePackageRoot, nativeBinaryPath);
const nativePackageJson = JSON.parse(
  readFileSync(join(nativePackageRoot, "package.json"), "utf8"),
) as { readonly bin?: Record<string, string> };

const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.cjs",
  "dist/cli.d.ts",
  "dist/cli.js",
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

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing check package smoke file: ${file}`);
  }
}

for (const removedFile of ["dist/index.cjs", "dist/index.d.ts", "dist/index.js"]) {
  if (existsSync(join(rootDir, removedFile))) {
    throw new Error(`Native-only package must not contain ${removedFile}`);
  }
}

if (packageJson.optionalDependencies?.[nativePackageName] === undefined) {
  throw new Error(`Check package is missing optional dependency ${nativePackageName}`);
}

if (!existsSync(nativeExecutable)) {
  throw new Error(`Missing current native executable: ${nativeExecutable}`);
}

if (nativePackageJson.bin?.["resultar-check-native"] === undefined) {
  throw new Error(`${nativePackageName} must declare its executable in package.json#bin`);
}

if (
  packageJson.main !== undefined ||
  packageJson.module !== undefined ||
  packageJson.types !== undefined
) {
  throw new Error("Native-only package must not expose a JavaScript library entrypoint");
}

const packageExports = sortStrings(Object.keys(packageJson.exports ?? {}));

if (JSON.stringify(packageExports) !== JSON.stringify(["./schema.json"])) {
  throw new Error(`Check package exposes unexpected entrypoints: ${packageExports.join(", ")}`);
}

const cliBundle = readFileSync(join(rootDir, "dist", "cli.js"), "utf8");

if (cliBundle.includes("typescript/")) {
  throw new Error("Public check CLI bundle must not contain TypeScript runtime code");
}

const help = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "help"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!help.includes("Usage: resultar-check")) {
  throw new Error("Check binary help output is missing expected usage text");
}

const version = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "--version"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();

if (packageJson.version === undefined || version !== packageJson.version) {
  throw new Error(`Check binary version mismatch: expected ${packageJson.version}, got ${version}`);
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

const sarifCheck = spawnSync(
  process.execPath,
  [join(rootDir, "dist/cli.js"), "--format", "sarif"],
  { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (sarifCheck.status !== 0) {
  throw new Error(`Check binary SARIF output failed: ${sarifCheck.stderr}`);
}

const sarif = JSON.parse(sarifCheck.stdout) as { readonly version?: string };

if (sarif.version !== "2.1.0") {
  throw new Error("Check binary SARIF output is missing version 2.1.0");
}

const lspHelp = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "lsp", "--help"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!lspHelp.includes("Usage: resultar-check lsp")) {
  throw new Error("Check binary LSP help output is missing expected usage text");
}

if (packageJson.bin?.["resultar-check"] !== "./dist/cli.js") {
  throw new Error("Check package must expose the native launcher as resultar-check");
}

const schema = JSON.parse(readFileSync(join(rootDir, "schema.json"), "utf8")) as {
  readonly properties?: { readonly compilerOptions?: unknown };
};

if (schema.properties?.compilerOptions === undefined) {
  throw new Error("Check package schema must describe tsconfig compilerOptions");
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
  /^(?:LICENSE|README\.md|package\.json|schema\.json|dist\/cli\.(?:cjs|js|d\.ts))$/;
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed check package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

const nativePackOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: nativePackageRoot,
  encoding: "utf8",
});
const nativePackedFiles = sortStrings(parsePackedFiles(nativePackOutput));

if (!nativePackedFiles.includes(nativeBinaryPath)) {
  throw new Error(`${nativePackageName} tarball is missing ${nativeBinaryPath}`);
}

process.stdout.write(
  `Check package smoke passed with ${packedFiles.length} launcher files and ${nativePackedFiles.length} native files.\n`,
);
