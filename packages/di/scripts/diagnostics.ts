import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "resultar-di-diagnostics-"));
const imports = `import { createModule, service, Service } from ${JSON.stringify(resolve(root, "dist/index.js"))};
import { ResultTask } from ${JSON.stringify(resolve(root, "../resultar/dist/index.js"))};
const Cache = service("cache", {}, () => 1);
`;
const cases = [
  [
    "duplicate-value",
    'createModule().value("cache", 1).value("cache", 2);',
    "use override() to replace it",
  ],
  [
    "duplicate-token",
    "createModule().singleton(Cache).singleton(Cache);",
    "use override() to replace it",
  ],
  ["async-factory", 'service("async", {}, () => Promise.resolve(1));', "Use service(name, task)"],
  [
    "wrong-contract",
    'const User = service("user", {cache: Cache}, ({cache}) => cache); createModule().value("cache", "wrong").scoped(User);',
    "incompatibleServices",
  ],
  [
    "missing-dependency",
    'const User = service("user", {cache: Cache}, ({cache}) => cache); createModule().scoped(User).http(["user"], () => new Response());',
    "missingServices",
  ],
  [
    "requires-wrong-contract",
    'const User = Service("user", {requires: {cache: Cache}, make: ({cache}) => ResultTask.succeed(cache)}); createModule().value("cache", "wrong").scoped(User);',
    "incompatibleServices",
  ],
  [
    "requires-missing-dependency",
    'const User = Service("user", {requires: {cache: Service.require<number>()("cache")}, make: ({cache}) => ResultTask.succeed(cache)}); createModule().scoped(User).http(["user"], () => new Response());',
    "missingServices",
  ],
  [
    "requires-promise-factory",
    'Service("user", {requires: {}, make: () => Promise.resolve(1)});',
    "ResultTask",
  ],
  [
    "named-missing-dependency",
    'createModule().scoped("user", ["missing"], ({missing}) => missing);',
    "unknownService",
  ],
  ["named-async-factory", 'createModule().scoped("cache", [], () => Promise.resolve(1));', "never"],
] as const;
try {
  for (const [name, source, expected] of cases) {
    const file = join(directory, `${name}.mts`);
    writeFileSync(file, imports + source);
    const result = spawnSync(
      resolve(root, "node_modules/.bin/tsc"),
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ESNext",
        "--module",
        "NodeNext",
        "--noErrorTruncation",
        file,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.ok(result.status === 1 || result.status === 2, result.stderr || result.stdout);
    assert.ok(result.stdout.includes(expected), `${name}: ${result.stdout}`);
    process.stdout.write(`${name}: verified compiler diagnostic\n`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
