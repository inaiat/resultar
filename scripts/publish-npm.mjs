import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");

const packages = [
  "packages/resultar",
  "packages/resultar-lint",
  "packages/resultar-tsgo",
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

function packageExists(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--registry", "https://registry.npmjs.org"],
    { cwd: rootDir, encoding: "utf8", stdio: "pipe" },
  );

  if (result.status === 0) {
    return true;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes("E404") || output.includes("No match found") || output.includes("Not Found")) {
    return false;
  }

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error(`Could not check ${name}@${version} on npm`);
}

for (const packageDir of packages) {
  const packageJsonPath = join(rootDir, packageDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const id = `${packageJson.name}@${packageJson.version}`;

  if (!dryRun && packageExists(packageJson.name, packageJson.version)) {
    console.log(`${id} already exists on npm; skipping`);
    continue;
  }

  const publishArgs = [
    "publish",
    "--tag",
    "alpha",
    "--access",
    "public",
    "--provenance",
    "--no-git-checks",
    "--registry",
    "https://registry.npmjs.org",
  ];

  if (dryRun) {
    publishArgs.push("--dry-run");
  }

  console.log(`${dryRun ? "Dry-running" : "Publishing"} ${id}`);
  run("pnpm", publishArgs, { cwd: join(rootDir, packageDir) });
}
