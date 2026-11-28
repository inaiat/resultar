import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "jsonc-parser";

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

void test("forced editor setup preserves JSONC comments, custom language servers and tasks", () => {
  const dir = makeTempProject();
  try {
    for (const sub of [".vscode", ".zed"]) mkdirSync(join(dir, sub));
    const zed = join(dir, ".zed/settings.json");
    const tasks = join(dir, ".vscode/tasks.json");
    writeFileSync(
      zed,
      '{// team settings\n"languages":{"TypeScript":{"language_servers":["custom", "...",],},},}',
    );
    writeFileSync(tasks, '{/* keep */ "tasks":[{"label":"custom",},],}');
    const result = runCli(dir, ["init", "--editor", "all", "--force", "--project", "."]);
    assert.equal(result.status, 0, result.stderr);
    const settings = readFileSync(zed, "utf8");
    assert.match(settings, /team settings/);
    const parsedSettings = parse(settings) as {
      languages: { TypeScript: { language_servers: string[] } };
    };
    assert.deepEqual(parsedSettings.languages.TypeScript.language_servers, [
      "custom",
      "vtsls",
      "typescript-language-server",
      "...",
    ]);
    const configuredTasks = readFileSync(tasks, "utf8");
    assert.match(configuredTasks, /keep/);
    const parsedTasks = parse(configuredTasks) as { tasks: { label: string }[] };
    assert.equal(parsedTasks.tasks[0]?.label, "custom");
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
    assert.ok(
      readFileSync(join(dir, ".cursor", "rules", "resultar-check.mdc"), "utf8").includes(
        "node_modules/resultar-check/dist/agent/SKILL.md",
      ),
    );
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

void test("doctor reports malformed extension recommendations and continues checking editors", () => {
  const dir = makeTempProject();
  try {
    assert.equal(runCli(dir, ["init", "--editor", "all"]).status, 0);
    writeFileSync(join(dir, ".vscode/extensions.json"), "{invalid");
    const checked = runCli(dir, ["doctor", "--editor", "all"]);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout + checked.stderr, /VS Code extensions/);
    assert.match(checked.stdout + checked.stderr, /Cursor rule/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

void test("doctor walks parent directories for hoisted node_modules/.bin/resultar-check", () => {
  const root = mkdtempSync(join(tmpdir(), "resultar-check-monorepo-"));
  const subpkg = join(root, "packages", "web");
  try {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(subpkg, { recursive: true });
    writeFileSync(join(subpkg, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n', "utf8");
    const binName = process.platform === "win32" ? "resultar-check.cmd" : "resultar-check";
    const hoistedBin = join(root, "node_modules", ".bin", binName);
    writeFileSync(hoistedBin, "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") {
      chmodSync(hoistedBin, 0o755);
    }

    const doctor = runCli(subpkg, ["doctor", "--editor", "zed"]);
    assert.match(doctor.stdout, /✓ resultar-check binary:/u);
    assert.ok(doctor.stdout.includes(hoistedBin), doctor.stdout);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

void test("vscode problemMatcher maps error/warning and suggestion/message severities cleanly", () => {
  const dir = makeTempProject();
  try {
    const init = runCli(dir, ["init", "--editor", "vscode"]);
    assert.equal(init.status, 0, init.stderr);
    const tasksFile = JSON.parse(readFileSync(join(dir, ".vscode", "tasks.json"), "utf8")) as {
      readonly tasks: readonly {
        readonly label: string;
        readonly problemMatcher: readonly {
          readonly owner: string;
          readonly severity?: string;
          readonly pattern: {
            readonly regexp: string;
            readonly severity?: number;
            readonly message: number;
          };
        }[];
      }[];
    };
    const matchers = tasksFile.tasks[0]?.problemMatcher;
    assert.ok(matchers !== undefined && matchers.length === 2);
    const [errWarnMatcher, infoMatcher] = matchers;
    assert.ok(errWarnMatcher !== undefined && infoMatcher !== undefined);
    assert.equal(infoMatcher.severity, "info");

    const errWarnRe = new RegExp(errWarnMatcher.pattern.regexp, "u");
    const infoRe = new RegExp(infoMatcher.pattern.regexp, "u");

    const errMatch = errWarnRe.exec("src/a.ts:1:2 resultar/no-discard (error) - Unhandled");
    assert.equal(errMatch?.[5], "error");
    const warnMatch = errWarnRe.exec("src/a.ts:3:4 resultar/prefer-map (warning) - Use map");
    assert.equal(warnMatch?.[5], "warning");
    assert.equal(
      errWarnRe.test("src/a.ts:5:6 resultar/prefer-as-void (suggestion) - Use asVoid"),
      false,
    );

    const suggMatch = infoRe.exec("src/a.ts:5:6 resultar/prefer-as-void (suggestion) - Use asVoid");
    assert.equal(suggMatch?.[5], "Use asVoid");
    const msgMatch = infoRe.exec("src/a.ts:7:8 resultar/unnecessary-pipe (message) - Unwrap pipe");
    assert.equal(msgMatch?.[5], "Unwrap pipe");
    assert.equal(infoRe.test("src/a.ts:1:2 resultar/no-discard (error) - Unhandled"), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
