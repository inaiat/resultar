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
import { createFastifyPlugin, type InferAppServices, type InferRequestServices } from "resultar-fastify";
import { createModule } from "resultar-di";
const plugin = createFastifyPlugin({ services: createModule().value("answer", 42), appBindings: ["answer"], bindings: ["answer"] });
type RequestServices = InferRequestServices<typeof plugin>;
type AppServices = InferAppServices<typeof plugin>;
declare module "fastify" {
 interface FastifyRequest { services: RequestServices }
 interface FastifyInstance { services: AppServices }
}
const app = Fastify();
await app.register(plugin);
app.get<{Params: {id: string}}>("/:id", async (request, reply) => {
 const value: number = request.services.answer;
 const id: string = request.params.id;
 return reply.send({value, id});
});
try {
 if (app.services.answer !== 42) throw new Error("Missing application singleton");
 const response = await app.inject("/one");
 if (response.statusCode !== 200 || response.json().value !== 42) throw new Error("Unexpected packed response");
} finally { await app.close(); }
if (false) {
 // @ts-expect-error Unknown binding must fail in published declarations too.
 createFastifyPlugin({ services: createModule().value("answer", 42), bindings: ["missing"] });
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
