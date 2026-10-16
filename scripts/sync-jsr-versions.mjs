import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const formatter = fileURLToPath(import.meta.resolve("vite-plus/bin"));

const packages = [
  "packages/resultar",
  "packages/di",
  "packages/request",
  "packages/request-typebox",
  "packages/request-zod",
];

const parseJsonRecord = (contents, filePath) => {
  const parsed = JSON.parse(contents);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Expected ${filePath} to contain a JSON object`);
  }

  return parsed;
};

const entries = [];
const versionByJsrName = new Map();

for (const packageDir of packages) {
  const packageJsonPath = join(rootDir, packageDir, "package.json");
  const jsrJsonPath = join(rootDir, packageDir, "jsr.json");

  const packageJson = parseJsonRecord(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  const jsrJson = parseJsonRecord(await readFile(jsrJsonPath, "utf8"), jsrJsonPath);

  if (typeof packageJson.version !== "string") {
    throw new TypeError(`Expected ${packageJsonPath} to contain a string version`);
  }

  if (typeof jsrJson.name === "string") {
    versionByJsrName.set(jsrJson.name, packageJson.version);
  }

  entries.push({ jsrJsonPath, packageJson, jsrJson });
}

for (const { jsrJsonPath, packageJson, jsrJson } of entries) {
  jsrJson.version = packageJson.version;

  if (
    typeof jsrJson.imports === "object" &&
    jsrJson.imports !== null &&
    !Array.isArray(jsrJson.imports)
  ) {
    for (const [alias, specifier] of Object.entries(jsrJson.imports)) {
      if (typeof specifier !== "string" || !specifier.startsWith("jsr:")) {
        continue;
      }
      const match = /^jsr:(@[^@/]+\/[^@]+)@/.exec(specifier);
      if (!match) {
        continue;
      }
      const targetVersion = versionByJsrName.get(match[1]);
      if (targetVersion !== undefined) {
        jsrJson.imports[alias] = `jsr:${match[1]}@^${targetVersion}`;
      }
    }
  }

  await writeFile(jsrJsonPath, `${JSON.stringify(jsrJson, null, 2)}\n`);
  execFileSync(process.execPath, [formatter, "fmt", "jsr.json"], {
    cwd: dirname(jsrJsonPath),
    stdio: "inherit",
  });
}
