import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url).pathname;

const makeTempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "resultar-check-setup-"));
  writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n', "utf8");
  return dir;
};

const runCli = (cwd: string, args: readonly string[]) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

void test("init defaults to zed and supports --force merge", () => {
  const dir = makeTempProject();
  try {
    const initial = runCli(dir, ["init"]);
    assert.equal(initial.status, 0, initial.stderr);
    const zedPath = join(dir, ".zed", "settings.json");
    assert.equal(existsSync(zedPath), true);

    const parsed = JSON.parse(readFileSync(zedPath, "utf8")) as Record<string, unknown>;
    writeFileSync(zedPath, JSON.stringify({ ...parsed, theme: "One Dark" }, undefined, 2), "utf8");

    const forced = runCli(dir, ["init", "--force", "--project", "tsconfig.json"]);
    assert.equal(forced.status, 0, forced.stderr);
    const updated = JSON.parse(readFileSync(zedPath, "utf8")) as Record<string, unknown>;
    assert.equal(updated.theme, "One Dark");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

void test("init --editor vscode writes tasks.json and preserves unrelated tasks on --force", () => {
  const dir = makeTempProject();
  try {
    mkdirSync(join(dir, ".vscode"), { recursive: true });
    writeFileSync(
      join(dir, ".vscode", "tasks.json"),
      JSON.stringify(
        { version: "2.0.0", tasks: [{ label: "custom-build", type: "shell", command: "echo hi" }] },
        undefined,
        2,
      ),
      "utf8",
    );

    const skipped = runCli(dir, ["init", "--editor", "vscode"]);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /already exists/u);

    const updated = runCli(dir, ["init", "--editor=vscode", "--force"]);
    assert.equal(updated.status, 0, updated.stderr);
    const tasksFile = JSON.parse(readFileSync(join(dir, ".vscode", "tasks.json"), "utf8")) as {
      readonly tasks: readonly { readonly label: string }[];
    };
    const labels = tasksFile.tasks.map((task) => task.label);
    assert.deepEqual(labels, ["custom-build", "resultar-check", "resultar-check: fix"]);

    const extensionsFile = JSON.parse(
      readFileSync(join(dir, ".vscode", "extensions.json"), "utf8"),
    ) as { readonly recommendations: readonly string[] };
    assert.deepEqual(extensionsFile.recommendations, ["inaiat.resultar-check"]);

    const doctor = runCli(dir, ["doctor", "--editor", "vscode"]);
    assert.match(doctor.stdout, /✓ VS Code tasks:/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

void test("init --editor cursor and --editor all create tasks, cursor rule, and zed settings", () => {
  const dir = makeTempProject();
  try {
    const cursorInit = runCli(dir, ["init", "--editor", "cursor"]);
    assert.equal(cursorInit.status, 0, cursorInit.stderr);
    assert.equal(existsSync(join(dir, ".vscode", "tasks.json")), true);
    assert.equal(existsSync(join(dir, ".cursor", "rules", "resultar-check.mdc")), true);
    assert.equal(existsSync(join(dir, ".zed", "settings.json")), false);

    const doctorCursor = runCli(dir, ["doctor", "--editor", "cursor"]);
    assert.match(doctorCursor.stdout, /✓ VS Code tasks:/u);
    assert.match(doctorCursor.stdout, /✓ Cursor rule:/u);

    const allInit = runCli(dir, ["init", "--editor", "all", "--force"]);
    assert.equal(allInit.status, 0, allInit.stderr);
    assert.equal(existsSync(join(dir, ".zed", "settings.json")), true);
    assert.equal(existsSync(join(dir, ".vscode", "tasks.json")), true);
    assert.equal(existsSync(join(dir, ".cursor", "rules", "resultar-check.mdc")), true);

    const doctorAll = runCli(dir, ["doctor", "--editor", "all"]);
    assert.match(doctorAll.stdout, /✓ Zed LSP:/u);
    assert.match(doctorAll.stdout, /✓ VS Code tasks:/u);
    assert.match(doctorAll.stdout, /✓ Cursor rule:/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

void test("init rejects unknown --editor values", () => {
  const dir = makeTempProject();
  try {
    const result = runCli(dir, ["init", "--editor", "emacs"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown --editor value: emacs/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
