import { execFileSync } from "node:child_process";
import { access, glob, readFile, readdir, writeFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const formatter = fileURLToPath(import.meta.resolve("vite-plus/bin"));

const packages = [];
for (const entry of await readdir(join(rootDir, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = join("packages", entry.name);
  try {
    await access(join(rootDir, packageDir, "jsr.json"));
    packages.push(packageDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const parseJsonRecord = (contents, filePath) => {
  const parsed = JSON.parse(contents);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Expected ${filePath} to contain a JSON object`);
  }

  return parsed;
};

const manifests = [];
const versions = new Map();
for (const packageDir of packages) {
  const packageJsonPath = join(rootDir, packageDir, "package.json");
  const jsrJsonPath = join(rootDir, packageDir, "jsr.json");

  const packageJson = parseJsonRecord(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  const jsrJson = parseJsonRecord(await readFile(jsrJsonPath, "utf8"), jsrJsonPath);

  if (typeof packageJson.version !== "string") {
    throw new TypeError(`Expected ${packageJsonPath} to contain a string version`);
  }

  versions.set(jsrJson.name, packageJson.version);
  manifests.push({ packageDir, jsrJsonPath, jsrJson, version: packageJson.version });
}

const checkOnly = process.argv.includes("--check");
for (const { packageDir, jsrJsonPath, jsrJson, version } of manifests) {
  const original = JSON.stringify(jsrJson);
  jsrJson.version = version;
  for (const [specifier, target] of Object.entries(jsrJson.imports ?? {})) {
    const internal = /^jsr:(@inaiat\/[^@/]+)@[^/]+(.*)$/.exec(target);
    if (!internal) continue;
    const expected = versions.get(internal[1]);
    if (!expected) throw new Error(`Unknown internal JSR dependency ${target} in ${jsrJsonPath}`);
    jsrJson.imports[specifier] = `jsr:${internal[1]}@^${expected}${internal[2]}`;
  }

  for await (const relativePath of glob("src/**/*.ts", { cwd: join(rootDir, packageDir) })) {
    const path = join(rootDir, packageDir, relativePath);
    const source = await readFile(path, "utf8");
    const ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "decorators-legacy"],
      createImportExpressions: true,
    });
    const pending = [ast.program];
    while (pending.length > 0) {
      const node = pending.pop();
      const specifier = node.type === "TSImportType" ? node.argument?.value : node.source?.value;
      if (
        typeof specifier === "string" &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("node:") &&
        !Object.hasOwn(jsrJson.imports ?? {}, specifier)
      ) {
        throw new Error(`Missing ${specifier} in ${jsrJsonPath} (used by ${relativePath})`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) pending.push(...value.filter((child) => child?.type));
        else if (value?.type) pending.push(value);
      }
    }
  }
  if (checkOnly) {
    if (JSON.stringify(jsrJson) !== original) throw new Error(`Stale versions in ${jsrJsonPath}`);
    continue;
  }
  await writeFile(jsrJsonPath, `${JSON.stringify(jsrJson, null, 2)}\n`);
  execFileSync(process.execPath, [formatter, "fmt", "jsr.json"], {
    cwd: dirname(jsrJsonPath),
    stdio: "inherit",
  });
}
