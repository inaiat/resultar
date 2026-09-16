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
    `import { createHonoApp, createHonoServices, type InferRequestServices } from "resultar-hono";
import { Hono } from "hono";
import { ResultTask } from "resultar";
import { createModule, Service, service, resource, type ServiceLifetime } from "resultar-hono";
let released = 0;
let started = 0;
const Base = service("base", {}, () => 40);
class Answer extends Service("answer", {
 requires: { base: Base },
 make: ({ base }) => ResultTask.sync(() => base + 2),
}) {}
const Lease = resource("lease", {
 acquire: ResultTask.succeed("open"),
 release: () => ResultTask.sync(() => { released += 1; }),
});
const lifetime: ServiceLifetime = "singleton";
const services = createModule().singleton(Base)[lifetime](Answer).scoped(Lease);
const startup = ResultTask.gen(function* smokeStartup() {
 yield* Answer;
 started += 1;
});
const createApplication = () => createHonoApp({ services, startup }, (router) => {
 routes(router);
});
const routes = (router: Hono<{ Bindings: InferRequestServices<typeof createApplication> }>) => {
 router.get("/", (c) => {
  if (c.env.base !== 40) throw new Error("Missing default Hono binding");
  return c.text(String(c.env.answer));
 });
};
const app = createApplication();
try {
 const ready = await app.ready();
 if (ready.isErr() || started !== 1) throw new Error("Packed startup task did not run once");
 const response = await app.request("/");
 if (await response.text() !== "42") throw new Error("Unexpected packed response");
} finally { const closed = await app.close(); if (closed.isErr()) throw closed.error; }
if (released !== 1) throw new Error("Packed resource was not released");
const di = createHonoServices(services);
const native = new Hono<{Bindings: {suffix: string}}>().get("/", di.middleware(["answer"]), (c) => c.text(String(c.var.services.answer) + c.env.suffix));
try {
 const response = await native.request("/", undefined, {suffix: "!"});
 if (await response.text() !== "42!") throw new Error("Native Hono bindings were replaced");
} finally { const closed = await di.close(); if (closed.isErr()) throw closed.error; }
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
