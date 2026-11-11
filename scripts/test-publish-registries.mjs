import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function publish(context, registry, scenario, dryRun = false) {
  const fixture = mkdtempSync(join(tmpdir(), "resultar-publish-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts"));
  const script = `scripts/publish-${registry}.mjs`;
  const source = readFileSync(join(root, script), "utf8");
  cpSync(join(root, script), join(fixture, script));
  const directories = [...source.matchAll(/"(packages\/[a-z0-9/-]+)"/gu)].map((match) => match[1]);
  for (const directory of directories) {
    mkdirSync(join(fixture, directory), { recursive: true });
    const manifest = registry === "npm" ? "package.json" : "jsr.json";
    cpSync(join(root, directory, manifest), join(fixture, directory, manifest));
  }
  writeFileSync(
    join(fixture, "mock.mjs"),
    `import childProcess from "node:child_process";
import timers from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const target = ${JSON.stringify(directories[0])};
let uploads = 0;
let checks = 0;
let waits = 0;
const record = (value) => appendFileSync("calls.jsonl", JSON.stringify(value) + "\\n");
const success = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const failure = (stderr) => ({ status: 1, stdout: "", stderr });
timers.setTimeout = async () => { waits++; record({ wait: true }); };
childProcess.spawnSync = (command, args, options) => {
  record({ command, args, cwd: options.cwd });
  if (args[0] === "view" && args[2] === "version") {
    if (!args[1].startsWith("resultar-check-darwin-arm64@")) return success('"5.0.0"');
    checks++;
    if (scenario === "lookup-auth") return failure("E401 Unauthorized");
    return checks > 1 && waits > 0 && scenario !== "pending"
      ? success('"5.0.0"') : failure("E404 Not Found");
  }
  if (args[0] === "view" && args[2] === "dist-tags") return success("{}");
  const isUpload = args[0] === "publish" || args.includes("jsr");
  if (!isUpload || !options.cwd.endsWith(target)) return success();
  uploads++;
  if (args.includes("--dry-run")) return success();
  if (scenario === "staged" || scenario === "pending")
    return failure('HTTP 409: Cannot publish over previously staged version "5.0.0".');
  if (scenario === "auth") return failure("E401 Unauthorized");
  if (scenario === "network" || scenario === "accepted" || (scenario === "retry" && uploads === 1))
    return failure("error sending request: connection error: connection reset");
  return success();
};
globalThis.fetch = async (url) => {
  record({ fetch: url });
  const exists = !url.includes("/resultar/") || (scenario === "accepted" && uploads > 0);
  return { status: exists ? 200 : 404, ok: exists };
};
syncBuiltinESMExports();
`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "./mock.mjs", script, ...(dryRun ? ["--dry-run"] : [])],
    { cwd: fixture, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.error, undefined);
  const calls = readFileSync(join(fixture, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const uploads = calls.filter(
    (call) =>
      call.cwd?.endsWith(directories[0]) &&
      (call.args[0] === "publish" || call.args.includes("jsr")),
  );
  return { ...result, calls, uploads };
}

for (const scenario of ["staged", "success"]) {
  test(`npm waits for ${scenario} uploads without republishing`, (context) => {
    const result = publish(context, "npm", scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.uploads.length, 1);
    assert.equal(result.calls.filter((call) => call.wait).length, 1);
    assert.match(result.stdout, /Waiting for npm availability/u);
    const tag = result.calls.findIndex(
      (call) =>
        call.args?.[0] === "dist-tag" && call.args[2].startsWith("resultar-check-darwin-arm64@"),
    );
    assert.ok(tag > result.calls.findIndex((call) => call.wait));
  });
}

test("npm fails clearly when a staged version remains unavailable", (context) => {
  const result = publish(context, "npm", "pending");
  assert.notEqual(result.status, 0);
  assert.equal(result.uploads.length, 1);
  assert.equal(result.calls.filter((call) => call.wait).length, 30);
  assert.match(result.stderr, /still unavailable after 15 minutes/u);
});

for (const registry of ["npm", "jsr"]) {
  test(`${registry} does not retry authentication failures`, (context) => {
    const result = publish(context, registry, "auth");
    assert.notEqual(result.status, 0);
    assert.equal(result.uploads.length, 1);
    assert.equal(result.calls.filter((call) => call.wait).length, 0);
    assert.match(result.stderr, /E401 Unauthorized/u);
  });
  test(`${registry} dry runs do not query registries or wait`, (context) => {
    const result = publish(context, registry, "staged", true);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.uploads.every((call) => call.args.includes("--dry-run")));
    assert.equal(
      result.calls.filter((call) => call.fetch || call.wait || call.args?.[0] === "view").length,
      0,
    );
  });
}

test("npm lookup authentication errors are not treated as absent versions", (context) => {
  const result = publish(context, "npm", "lookup-auth");
  assert.notEqual(result.status, 0);
  assert.equal(result.uploads.length, 0);
});

test("JSR retries a transient connection failure", (context) => {
  const result = publish(context, "jsr", "retry");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.uploads.length, 2);
});

test("JSR does not upload again after a partially successful publish", (context) => {
  const result = publish(context, "jsr", "accepted");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.uploads.length, 1);
  assert.match(result.stdout, /now exists on JSR/u);
});

test("JSR limits retries for persistent connection failures", (context) => {
  const result = publish(context, "jsr", "network");
  assert.notEqual(result.status, 0);
  assert.equal(result.uploads.length, 3);
});
