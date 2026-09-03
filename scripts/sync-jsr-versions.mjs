import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const packages = [
  "packages/resultar",
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

for (const packageDir of packages) {
  const packageJsonPath = join(rootDir, packageDir, "package.json");
  const jsrJsonPath = join(rootDir, packageDir, "jsr.json");

  const packageJson = parseJsonRecord(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  const jsrJson = parseJsonRecord(await readFile(jsrJsonPath, "utf8"), jsrJsonPath);

  if (typeof packageJson.version !== "string") {
    throw new TypeError(`Expected ${packageJsonPath} to contain a string version`);
  }

  jsrJson.version = packageJson.version;

  await writeFile(jsrJsonPath, `${JSON.stringify(jsrJson, null, 2)}\n`);
}
