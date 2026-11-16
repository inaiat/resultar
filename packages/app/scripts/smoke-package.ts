import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Install published archives outside the workspace to catch undeclared dependencies.
const directory = mkdtempSync(join(tmpdir(), "resultar-app-smoke-"));
try {
  const archives: Record<string, string> = {};
  for (const [folder, name] of [
    ["resultar", "resultar"],
    ["di", "resultar-di"],
    ["config", "resultar-config"],
    ["app", "resultar-app"],
  ] as const) {
    const archive = join(directory, `${name}.tgz`);
    execFileSync("pnpm", ["--config.ignore-scripts=true", "pack", "--out", archive], {
      cwd: resolve("..", folder),
      stdio: "pipe",
    });
    archives[name] = `file:${archive}`;
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "resultar-app-consumer",
      private: true,
      type: "module",
      dependencies: { "resultar-app": archives["resultar-app"] },
    }),
  );
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    `autoInstallPeers: false\noverrides:\n${Object.entries(archives)
      .map(([name, path]) => `  ${name}: ${JSON.stringify(path)}`)
      .join("\n")}\n`,
  );
  execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd: directory, stdio: "pipe" });
  const packed = JSON.parse(
    readFileSync(join(directory, "node_modules/resultar-app/package.json"), "utf8"),
  ) as { readonly dependencies: Readonly<Record<string, string>> };
  assert.deepEqual(Object.keys(packed.dependencies).toSorted(), [
    "resultar",
    "resultar-config",
    "resultar-di",
  ]);
  for (const version of Object.values(packed.dependencies))
    assert.ok(!version.startsWith("workspace:"));
  writeFileSync(
    join(directory, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { ConfigError, createModule, defineAppConfig, ResultTask, service, t } from "resultar-app";
const config = defineAppConfig({ properties: { PORT: t.Integer() }, source: { PORT: "9000" } });
const Server = service("server", ResultTask.ok({ ready: true }));
const module = createModule().merge(config).singleton(Server);
const port = await module.use(["appConfig", "server"], ({ appConfig, server }) => {
  assert.equal(server.ready, true);
  return ResultTask.ok(appConfig.PORT);
}).runPromise();
assert.equal(port, 9000);
const invalid = await defineAppConfig({ properties: { PORT: t.Integer() }, source: {} }).load().runResult();
assert.ok(invalid.isErr());
assert.ok(invalid.error instanceof ConfigError);
`,
  );
  execFileSync("node", ["smoke.mjs"], { cwd: directory, stdio: "pipe" });
  process.stdout.write(
    "Package smoke passed: consumer installs only resultar-app and loads typed configuration/services.\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
