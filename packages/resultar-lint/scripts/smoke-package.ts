import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
  readonly bin?: Record<string, string>;
  readonly deprecated?: string;
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
  "package.json",
] as const;

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing deprecated lint wrapper smoke file: ${file}`);
  }
}

if (packageJson.bin?.["resultar-check"] !== undefined) {
  throw new Error("Deprecated resultar-lint wrapper must not expose resultar-check");
}

if (packageJson.bin?.["resultar-lint"] === undefined) {
  throw new Error("Deprecated resultar-lint wrapper should expose the legacy resultar-lint binary");
}

if (packageJson.deprecated === undefined) {
  throw new Error("Deprecated resultar-lint wrapper package must include a deprecation message");
}

const cjsEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.cjs")).href)) as {
  readonly default?: Record<PropertyKey, unknown>;
};
const esmEntrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.js")).href)) as {
  readonly default?: Record<PropertyKey, unknown>;
};

if (typeof cjsEntrypoint.default?.runResultarCheckCli !== "function") {
  throw new TypeError("CJS deprecated lint wrapper is missing runResultarCheckCli");
}

if (typeof esmEntrypoint.default?.runResultarCheckCli !== "function") {
  throw new TypeError("ESM deprecated lint wrapper is missing runResultarCheckCli");
}

execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: rootDir, encoding: "utf8" });

process.stdout.write("Deprecated resultar-lint wrapper smoke passed.\n");
