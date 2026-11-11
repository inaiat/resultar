import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const registry = "https://jsr.io";

const packages = [
  "packages/resultar",
  "packages/di",
  "packages/request",
  "packages/request-typebox",
  "packages/request-zod",
];

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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync("npm", publishArgs, {
      cwd: join(rootDir, packageDir),
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (!result.error && result.status === 0) break;

    const output = `${result.stdout}\n${result.stderr}`;
    const transient =
      /connection reset|ECONNRESET|ETIMEDOUT|connection timed out|HTTP (502|503|504)\b/iu.test(
        output,
      );
    if (result.error || dryRun || !transient || attempt === 3) {
      throw new Error(`Publishing ${id} failed with exit code ${result.status ?? "unknown"}`, {
        cause: result.error,
      });
    }
    console.log(
      `Transient JSR failure for ${id}; checking availability before retry ${attempt + 1}/3`,
    );
    await setTimeout(attempt * 5_000);
    if (await jsrVersionExists(jsrJson.name, jsrJson.version)) {
      console.log(`${id} now exists on JSR; skipping upload retry`);
      break;
    }
  }
}
