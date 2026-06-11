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
const registry = "https://registry.npmjs.org";

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

function publishTagForVersion(version) {
  const prerelease = /-(?<tag>[0-9A-Za-z-]+)(?:[.-]|$)/u.exec(version);
  return prerelease?.groups?.tag ?? "latest";
}

function packageExists(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--registry", registry],
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

function readDistTags(name) {
  const result = spawnSync(
    "npm",
    ["view", name, "dist-tags", "--json", "--registry", registry],
    { cwd: rootDir, encoding: "utf8", stdio: "pipe" },
  );

  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`Could not read npm dist-tags for ${name}`);
  }

  return JSON.parse(result.stdout);
}

function ensureDistTag(name, version, tag) {
  run("npm", ["dist-tag", "add", `${name}@${version}`, tag, "--registry", registry]);
}

function removeStalePrereleaseTags(name, version) {
  const distTags = readDistTags(name);

  for (const [tag, taggedVersion] of Object.entries(distTags)) {
    if (tag !== "latest" && taggedVersion === version) {
      run("npm", ["dist-tag", "rm", name, tag, "--registry", registry]);
    }
  }
}

for (const packageDir of packages) {
  const packageJsonPath = join(rootDir, packageDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const id = `${packageJson.name}@${packageJson.version}`;
  const publishTag = publishTagForVersion(packageJson.version);

  if (!dryRun && packageExists(packageJson.name, packageJson.version)) {
    console.log(`${id} already exists on npm; ensuring dist-tag ${publishTag}`);
    ensureDistTag(packageJson.name, packageJson.version, publishTag);

    if (publishTag === "latest") {
      removeStalePrereleaseTags(packageJson.name, packageJson.version);
    }

    continue;
  }

  const publishArgs = [
    "publish",
    "--tag",
    publishTag,
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
