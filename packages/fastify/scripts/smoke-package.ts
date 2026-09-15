import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "resultar-fastify-package-"));
try {
  for (const [folder, name] of [
    ["resultar", "resultar"],
    ["di", "resultar-di"],
    ["fastify", "resultar-fastify"],
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
  for (const name of ["fastify", "fastify-plugin"]) {
    symlinkSync(
      realpathSync(join(root, "node_modules", name)),
      join(directory, "node_modules", name),
    );
  }
  const file = join(directory, "consumer.mts");
  writeFileSync(
    file,
    `import Fastify from "fastify";
import { createFastifyApp, createFastifyPlugin, type InferAppServices, type InferRequestServices } from "resultar-fastify";
import { ResultTask } from "resultar";
import { createModule, Service, service, resource, type ServiceLifetime } from "resultar-fastify";
let released = 0;
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
const plugin = createFastifyPlugin({ services, appBindings: ["answer"] });
const createApplication = () => createFastifyApp({ services, appBindings: ["answer"] }, (router) => {
 router.get("/", (request) => request.services.answer);
});
type RequestServices = InferRequestServices<typeof createApplication>;
type AppServices = InferAppServices<typeof createApplication>;
declare module "fastify" {
 interface FastifyRequest { services: RequestServices }
 interface FastifyInstance { services: AppServices }
}
const app = Fastify();
await app.register(plugin);
app.get<{Params: {id: string}}>("/:id", async (request, reply) => {
 const value: number = request.services.answer;
 if (request.services.base !== 40) throw new Error("Missing default request binding");
 const id: string = request.params.id;
 return reply.send({value, id});
});
try {
 if (app.services.answer !== 42) throw new Error("Missing application singleton");
 const response = await app.inject("/one");
 if (response.statusCode !== 200 || response.json().value !== 42) throw new Error("Unexpected packed response");
} finally { await app.close(); }
if (released !== 1) throw new Error("Packed resource was not released");
const standalone = createApplication();
try {
 const response = await standalone.inject("/");
 if (response.statusCode !== 200 || response.body !== "42") throw new Error("Unexpected application factory response");
} finally { await standalone.close(); }
if (false) {
 const selected = standalone.getDecorator<RequestServices>("services");
 const answer: number = selected.answer;
 const base: number = selected.base;
 const restricted = createFastifyPlugin({ services, bindings: ["answer"] });
 const restrictedView = standalone.getDecorator<InferRequestServices<typeof restricted>>("services");
 // @ts-expect-error Explicit selections still hide unselected providers.
 restrictedView.base;
 // @ts-expect-error Selected service values retain their concrete types.
 const invalid: string = selected.answer;
 // @ts-expect-error Request bindings are readonly.
 selected.answer = 0;
 // @ts-expect-error Unknown binding must fail in published declarations too.
 createFastifyPlugin({ services: createModule().value("answer", 42), bindings: ["missing"] });
 // @ts-expect-error The application factory validates published binding types too.
 createFastifyApp({ services: createModule().value("answer", 42), bindings: ["missing"] }, () => {});
}
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
  process.stdout.write("Packed Fastify, DI and Resultar consumer passed types and execution.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
