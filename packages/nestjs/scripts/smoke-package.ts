import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempPrefix = join(tmpdir(), "resultar-nestjs-package-");
const directory = realpathSync(mkdtempSync(tempPrefix));
try {
  for (const [folder, name] of [
    ["resultar", "resultar"],
    ["di", "resultar-di"],
    ["nestjs", "resultar-nestjs"],
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
  mkdirSync(join(directory, "node_modules", "@nestjs"), { recursive: true });
  for (const name of [
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/platform-fastify",
    "reflect-metadata",
    "rxjs",
  ]) {
    symlinkSync(
      realpathSync(join(root, "node_modules", name)),
      join(directory, "node_modules", name),
    );
  }
  const diManifest: unknown = JSON.parse(
    readFileSync(join(root, "..", "di", "package.json"), "utf8"),
  );
  assert.ok(
    diManifest !== null &&
      typeof diManifest === "object" &&
      "version" in diManifest &&
      typeof diManifest.version === "string",
  );
  const manifest: unknown = JSON.parse(
    readFileSync(join(directory, "node_modules", "resultar-nestjs", "package.json"), "utf8"),
  );
  assert.ok(manifest !== null && typeof manifest === "object" && "dependencies" in manifest);
  const dependencies = manifest.dependencies;
  assert.ok(
    dependencies !== null && typeof dependencies === "object" && "resultar-di" in dependencies,
  );
  assert.equal(dependencies["resultar-di"], `^${diManifest.version}`);
  const file = join(directory, "consumer.mts");
  writeFileSync(
    file,
    `import "reflect-metadata";
import { Controller, Get, Module, Param, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  APP_SERVICES,
  createNestApp,
  createNestModule,
  FastifyAdapter,
  getAppServices,
  getRequestServices,
  Services,
  type InferAppServices,
  type InferRequestServices,
  type NestRequest,
} from "resultar-nestjs";
import { ResultTask } from "resultar";
import { createModule, Service, service, resource, type ServiceLifetime } from "resultar-nestjs";

let released = 0;
let started = 0;
const Base = service("base", {}, () => 40);
class Answer extends Service("answer", {
  requires: { base: Base },
  make: ({ base }) => ResultTask.sync(() => base + 2),
}) {}
const Lease = resource("lease", {
  acquire: ResultTask.succeed("open"),
  release: () =>
    ResultTask.sync(() => {
      released += 1;
    }),
});
const lifetime: ServiceLifetime = "singleton";
const services = createModule().singleton(Base)[lifetime](Answer).scoped(Lease);
const startup = ResultTask.gen(function* smokeStartup() {
  yield* Answer;
  started += 1;
});
const moduleDef = createNestModule({ services, startup, appBindings: ["answer"] });

type RequestServices = InferRequestServices<typeof moduleDef>;
type AppServices = InferAppServices<typeof moduleDef>;

@Controller()
class SmokeController {
  @Get()
  root(@Services() reqServices: RequestServices, @Req() req: NestRequest) {
    return { id: req.id, answer: reqServices.answer };
  }

  @Get(":id")
  byId(@Param("id") id: string, @Services() reqServices: RequestServices) {
    const value: number = reqServices.answer;
    if (reqServices.base !== 40) throw new Error("Missing default request binding");
    return { value, id };
  }
}

const createApplication = () =>
  createNestApp({
    services,
    startup,
    appBindings: ["answer"],
    controllers: [SmokeController],
  });

if (started !== 0) throw new Error("Packed startup task ran before readiness");

const standalone = createApplication();
try {
  await standalone.ready();
  if (standalone.services.answer !== 42) throw new Error("Missing application singleton");
  if (getAppServices<AppServices>(standalone)?.answer !== 42)
    throw new Error("Missing getAppServices singleton");
  const response = await standalone.inject("/one");
  if (Number(started) !== 1) throw new Error("Packed startup task did not run once");
  if (response.statusCode !== 200 || response.json<{ value: number }>().value !== 42)
    throw new Error("Unexpected packed response");
} finally {
  await standalone.close();
}
if (released !== 1) throw new Error("Packed resource was not released");

@Module({
  imports: [moduleDef],
  controllers: [SmokeController],
})
class NativeAppModule {}

const nativeApp = await NestFactory.create(NativeAppModule, new FastifyAdapter(), { logger: false });
try {
  await nativeApp.init();
  const appServices = nativeApp.get<AppServices>(APP_SERVICES);
  if (appServices.answer !== 42) throw new Error("Missing native APP_SERVICES singleton");
} finally {
  await nativeApp.close();
}

if (false) {
  const selected = standalone.getDecorator<RequestServices>("services");
  const answer: number = selected.answer;
  const base: number = selected.base;
  const restricted = createNestModule({ services, bindings: ["answer"] });
  const restrictedView = standalone.getDecorator<InferRequestServices<typeof restricted>>("services");
  // @ts-expect-error Explicit selections still hide unselected providers.
  restrictedView.base;
  // @ts-expect-error Selected service values retain their concrete types.
  const invalid: string = selected.answer;
  // @ts-expect-error Request bindings are readonly.
  selected.answer = 0;
  // @ts-expect-error Unknown binding must fail in published declarations too.
  createNestModule({ services: createModule().value("answer", 42), bindings: ["missing"] });
  // @ts-expect-error The application factory validates published binding types too.
  createNestApp({ services: createModule().value("answer", 42), bindings: ["missing"] });
  void answer;
  void base;
  void invalid;
  void getRequestServices;
}

const optionsApp = createNestApp({
  services,
  startup,
  appBindings: ["answer"],
  requestIdHeader: "x-smoke-id",
  controllers: [SmokeController],
});
try {
  const response = await optionsApp.inject({
    method: "GET",
    url: "/",
    headers: { "x-smoke-id": "smoke-1" },
  });
  const body = response.json<{ id: string; answer: number }>();
  if (response.statusCode !== 200 || body.answer !== 42 || body.id !== "smoke-1")
    throw new Error("Packed NestJS options were not forwarded");
} finally {
  await optionsApp.close();
}
`,
  );
  const tsconfigFile = join(directory, "tsconfig.json");
  writeFileSync(
    tsconfigFile,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ["consumer.mts"],
    }),
  );
  execFileSync(
    join(root, "node_modules/.bin/tsc"),
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--experimentalDecorators",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ESNext",
      file,
    ],
    { stdio: "pipe" },
  );
  execFileSync(process.execPath, ["--import", "tsx", file], {
    stdio: "pipe",
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigFile },
  });
  process.stdout.write("Packed NestJS, DI and Resultar consumer passed types and execution.\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
