import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const registry = "https://jsr.io";

const packages = [
  "packages/resultar",
  "packages/check",
  "packages/request",
  "packages/request-typebox",
  "packages/request-zod",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function jsrVersionExists(name, version) {
  const response = await fetch(`${registry}/${name}/${version}_meta.json`);

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`Could not fetch JSR metadata for ${name}@${version}: HTTP ${response.status}`);
  }

  return true;
}

for (const packageDir of packages) {
  const jsrJsonPath = join(rootDir, packageDir, "jsr.json");
  const jsrJson = JSON.parse(await readFile(jsrJsonPath, "utf8"));
  const id = `${jsrJson.name}@${jsrJson.version}`;

  if (typeof jsrJson.name !== "string" || typeof jsrJson.version !== "string") {
    throw new TypeError(`${jsrJsonPath} must contain string name and version fields`);
  }

  if (!dryRun && (await jsrVersionExists(jsrJson.name, jsrJson.version))) {
    console.log(`${id} already exists on JSR; skipping`);
    continue;
  }

  const publishArgs = ["exec", "--yes", "--package", "jsr@0.14.3", "--", "jsr", "publish"];

  if (dryRun) {
    publishArgs.push("--dry-run", "--allow-dirty");
  }

  console.log(`${dryRun ? "Dry-running" : "Publishing"} ${id}`);
  run("npm", publishArgs, { cwd: join(rootDir, packageDir) });
}
