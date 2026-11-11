import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");

const packages = [
  "packages/check/native-packages/darwin-arm64",
  "packages/check/native-packages/darwin-x64",
  "packages/check/native-packages/linux-arm64",
  "packages/check/native-packages/linux-x64",
  "packages/check/native-packages/win32-arm64",
  "packages/check/native-packages/win32-x64",
  "packages/resultar",
  "packages/di",
  "packages/hono",
  "packages/fastify",
  "packages/nestjs",
  "packages/check",
  "packages/request",
  "packages/request-typebox",
  "packages/request-zod",
];
const registry = "https://registry.npmjs.org";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
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
  if (
    output.includes("E404") ||
    output.includes("No match found") ||
    output.includes("Not Found")
  ) {
    return false;
  }

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error(`Could not check ${name}@${version} on npm`);
}

function readDistTags(name) {
  const result = spawnSync("npm", ["view", name, "dist-tags", "--json", "--registry", registry], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe",
  });

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

run("pnpm", ["--filter", "resultar-check", "native:build:all"]);
const pending = new Map();

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
  const result = spawnSync("pnpm", publishArgs, {
    cwd: join(rootDir, packageDir),
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const output = `${result.stdout}\n${result.stderr}`;
  const staged = !dryRun && /Cannot publish over previously staged version/u.test(output);
  if (result.error || (result.status !== 0 && !staged)) {
    throw new Error(`Publishing ${id} failed with exit code ${result.status ?? "unknown"}`, {
      cause: result.error,
    });
  }
  if (!dryRun)
    pending.set(id, { name: packageJson.name, version: packageJson.version, publishTag });
}

// Upload acceptance does not guarantee availability while npm scans a release.
// Submit all packages first, then wait up to 15 minutes without republishing.
for (let attempt = 0; pending.size > 0; attempt += 1) {
  for (const [id, { name, version, publishTag }] of pending) {
    if (!packageExists(name, version)) continue;
    ensureDistTag(name, version, publishTag);
    if (publishTag === "latest") removeStalePrereleaseTags(name, version);
    pending.delete(id);
  }
  if (pending.size === 0) break;
  if (attempt === 30) {
    throw new Error(
      `npm versions are still unavailable after 15 minutes: ${[...pending.keys()].join(", ")}. Check their registry staging/review status before retrying; do not publish replacement versions.`,
    );
  }
  console.log(`Waiting for npm availability: ${[...pending.keys()].join(", ")}`);
  await setTimeout(30_000);
}
