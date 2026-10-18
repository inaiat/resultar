import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const formatter = fileURLToPath(import.meta.resolve("vite-plus/bin"));
const packages = ["resultar", "di", "request", "request-typebox", "request-zod"];

test("JSR synchronization updates versions, preserves metadata, and respects package formatting", (context) => {
  const fixture = mkdtempSync(join(tmpdir(), "resultar-jsr-sync-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "scripts"));
  cpSync(
    join(root, "scripts/sync-jsr-versions.mjs"),
    join(fixture, "scripts/sync-jsr-versions.mjs"),
  );
  cpSync(join(root, "vite.config.ts"), join(fixture, "vite.config.ts"));
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", private: true }));
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "junction");

  const expected = new Map();
  for (const name of packages) {
    const source = join(root, "packages", name);
    const directory = join(fixture, "packages", name);
    mkdirSync(directory, { recursive: true });
    cpSync(join(source, "vite.config.ts"), join(directory, "vite.config.ts"));
    const metadata = JSON.parse(readFileSync(join(source, "jsr.json"), "utf8"));
    expected.set(name, { ...metadata, version: "99.0.0" });
    writeFileSync(join(directory, "jsr.json"), JSON.stringify(metadata, null, 2) + "\n");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version: "99.0.0", type: "module" }),
    );
  }

  const synchronize = () =>
    execFileSync(process.execPath, ["scripts/sync-jsr-versions.mjs"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 60000,
    });
  synchronize();

  const snapshots = new Map();
  for (const name of packages) {
    const directory = join(fixture, "packages", name);
    const contents = readFileSync(join(directory, "jsr.json"), "utf8");
    assert.deepEqual(JSON.parse(contents), expected.get(name));
    execFileSync(process.execPath, [formatter, "fmt", "--check", "jsr.json"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 60000,
    });
    snapshots.set(name, contents);
  }

  synchronize();
  for (const name of packages) {
    assert.equal(
      readFileSync(join(fixture, "packages", name, "jsr.json"), "utf8"),
      snapshots.get(name),
    );
  }
});
