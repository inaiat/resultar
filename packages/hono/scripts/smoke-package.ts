import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "resultar-hono-package-"));
try {
  for (const [folder, name] of [
    ["resultar", "resultar"],
    ["di", "resultar-di"],
    ["hono", "resultar-hono"],
  ] as const) {
    const archive = join(directory, `${name}.tgz`);
    execFileSync("pnpm", ["pack", "--out", archive], {
      cwd: join(root, "..", folder),
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      stdio: "pipe",
    });
    const target = join(directory, "node_modules", name);
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
  }
  symlinkSync(realpathSync(join(root, "node_modules/hono")), join(directory, "node_modules/hono"));
  const file = join(directory, "consumer.mts");
  writeFileSync(
    file,
    `import { createHonoApp } from "resultar-hono";
import { createModule } from "resultar-di";
const app = createHonoApp({ services: createModule().value("answer", 42), bindings: ["answer"] }, (router) => {
 router.get("/", (c) => c.text(String(c.env.answer)));
});
try {
 const response = await app.request("/");
 if (await response.text() !== "42") throw new Error("Unexpected packed response");
} finally { const closed = await app.close(); if (closed.isErr()) throw closed.error; }
`,
  );
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ESNext",
      file,
    ],
    { stdio: "pipe" },
  );
  execFileSync(process.execPath, [file], { stdio: "pipe" });
  process.stdout.write("Packed Hono, DI and Resultar consumer passed types and execution.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
