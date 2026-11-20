import "reflect-metadata";
import { strictEqual } from "node:assert";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { Controller, Get, Module, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { createNestApp, Services, type NestRequest } from "resultar-nestjs";

const withJit = async <T>(enabled: boolean, run: () => Promise<T>): Promise<T> => {
  const prev = process.env.RESULTAR_JIT;
  process.env.RESULTAR_JIT = enabled ? "1" : "0";
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.RESULTAR_JIT;
    else process.env.RESULTAR_JIT = prev;
  }
};

const createBaseModule = () =>
  createModule()
    .value("config", { app: "resultar", version: 4 })
    .singleton("repo", ["config"], ({ config }) => ({
      lookup: (id: string) => `${config.app}:${id}`,
    }))
    .scoped("reqCtx", ["repo"], ({ repo }) => ({
      repo,
      ts: 1,
    }))
    .scoped("serviceA", ["reqCtx"], ({ reqCtx }) => ({
      handle: (id: string) => reqCtx.repo.lookup(id),
    }))
    .transient("nonce", [], () => 7)
    .resource("tx", [], {
      acquire: () => ResultTask.sync(() => ({ id: "tx-1" })),
      release: () => ResultTask.sync(() => undefined),
    });

const createDeepModule = () =>
  createModule()
    .value("cfg", { env: "prod" })
    .singleton("db", ["cfg"], ({ cfg }) => ({ env: cfg.env }))
    .scoped("s1", ["db"], ({ db }) => ({ v: db.env.length }))
    .scoped("s2", ["s1"], ({ s1 }) => ({ v: s1.v + 1 }))
    .scoped("s3", ["s1", "s2"], ({ s1, s2 }) => ({ v: s1.v + s2.v }))
    .scoped("s4", ["s2", "s3"], ({ s2, s3 }) => ({ v: s2.v + s3.v }))
    .scoped("s5", ["s3", "s4"], ({ s3, s4 }) => ({ v: s3.v + s4.v }))
    .scoped("s6", ["s4", "s5"], ({ s4, s5 }) => ({ v: s4.v + s5.v }));

const requestOnce = (
  agent: http.Agent,
  port: number,
  path: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

const requestFast = (agent: http.Agent, port: number, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });

const totalRequests = 10_000;
const concurrency = 16;
const samples = 5;

const runBurst = async (agent: http.Agent, port: number, path: string): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next;
      next += 1;
      if (idx >= totalRequests) return;
      const status = await requestFast(agent, port, path);
      if (status !== 200) throw new Error(`Unexpected status: ${String(status)}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
};

interface BenchTarget {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const benchTarget = async (
  name: string,
  start: () => Promise<BenchTarget>,
  path: string,
  expectedBody: string,
): Promise<number> => {
  const target = await start();
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  try {
    const check = await requestOnce(agent, target.port, path);
    strictEqual(check.status, 200);
    strictEqual(check.body, expectedBody);

    // Warmup
    await runBurst(agent, target.port, path);

    const times: number[] = [];
    for (let s = 0; s < samples; s += 1) {
      const t0 = performance.now();
      await runBurst(agent, target.port, path);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(samples / 2)]!;
    const rps = Math.round((totalRequests / medianMs) * 1000);
    const usPerReq = (medianMs * 1000) / totalRequests;
    console.log(
      `- ${name}: ${rps.toLocaleString("en-US")} req/s (${usPerReq.toFixed(2)} µs/req, median ${medianMs.toFixed(2)} ms / ${totalRequests.toLocaleString("en-US")} reqs)`,
    );
    return rps;
  } finally {
    agent.destroy();
    await target.close();
  }
};

// Raw NestJS controller
const rawRepo = { lookup: (id: string) => `resultar:${id}` };

@Controller()
class RawController {
  @Get("/users/:id")
  getUser(@Param("id") id: string) {
    return rawRepo.lookup(id);
  }
}

@Module({ controllers: [RawController] })
class RawAppModule {}

const startRawNest = async (): Promise<BenchTarget> => {
  const app = await NestFactory.create<NestFastifyApplication>(RawAppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address");
  return { port: address.port, close: () => app.close() };
};

@Controller()
class Tier0Controller {
  @Get("/users/:id")
  getUser(
    @Param("id") id: string,
    @Services() services: { readonly repo: { readonly lookup: (id: string) => string } },
  ) {
    return services.repo.lookup(id);
  }
}

@Controller()
class Tier1Controller {
  @Get("/users/:id")
  getUser(
    @Param("id") id: string,
    @Services()
    services: {
      readonly serviceA: { readonly handle: (id: string) => string };
      readonly nonce: number;
    },
  ) {
    return `${services.serviceA.handle(id)}:${String(services.nonce)}`;
  }
}

@Controller()
class DeepTier1Controller {
  @Get("/deep")
  getDeep(@Services() services: { readonly s6: { readonly v: number } }) {
    return String(services.s6.v);
  }
}

@Controller()
class Tier2Controller {
  @Get("/users/:id")
  getUser(
    @Param("id") id: string,
    @Services()
    services: {
      readonly repo: { readonly lookup: (id: string) => string };
      readonly tx: { readonly id: string };
    },
  ) {
    return `${services.repo.lookup(id)}:${services.tx.id}`;
  }
}

const startNestApp = async (app: ReturnType<typeof createNestApp>): Promise<BenchTarget> => {
  const server = await app.listen(0, "127.0.0.1");
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Expected TCP address");
  return { port: address.port, close: () => app.close() };
};

console.log(
  `=== Resultar NestJS (FastifyAdapter) HTTP Benchmark (Node ${process.version}, ${process.platform}/${process.arch}, keep-alive c=${concurrency}) ===\n`,
);

const rawRps = await benchTarget(
  "Raw NestJS + FastifyAdapter (no DI)",
  startRawNest,
  "/users/42",
  "resultar:42",
);

const t0JitRps = await withJit(true, () =>
  benchTarget(
    "resultar-nestjs Tier 0 (singleton) (JIT=1)",
    () =>
      startNestApp(
        createNestApp({
          services: createBaseModule(),
          bindings: ["repo"],
          controllers: [Tier0Controller],
          logger: false,
        }),
      ),
    "/users/42",
    "resultar:42",
  ),
);
const t0FbRps = await withJit(false, () =>
  benchTarget(
    "resultar-nestjs Tier 0 (singleton) (JIT=0)",
    () =>
      startNestApp(
        createNestApp({
          services: createBaseModule(),
          bindings: ["repo"],
          controllers: [Tier0Controller],
          logger: false,
        }),
      ),
    "/users/42",
    "resultar:42",
  ),
);
console.log(
  `  -> Tier 0 vs Raw NestJS: ${((t0JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t0JitRps / t0FbRps).toFixed(2)}x\n`,
);

const t1JitRps = await withJit(true, () =>
  benchTarget(
    "resultar-nestjs Tier 1 (scoped+transient+locals) (JIT=1)",
    () =>
      startNestApp(
        createNestApp({
          services: createBaseModule(),
          bindings: ["serviceA", "nonce"],
          locals: (request: NestRequest) => ({ reqId: request.id }),
          controllers: [Tier1Controller],
          logger: false,
        }),
      ),
    "/users/42",
    "resultar:42:7",
  ),
);
const t1FbRps = await withJit(false, () =>
  benchTarget(
    "resultar-nestjs Tier 1 (scoped+transient+locals) (JIT=0)",
    () =>
      startNestApp(
        createNestApp({
          services: createBaseModule(),
          bindings: ["serviceA", "nonce"],
          locals: (request: NestRequest) => ({ reqId: request.id }),
          controllers: [Tier1Controller],
          logger: false,
        }),
      ),
    "/users/42",
    "resultar:42:7",
  ),
);
console.log(
  `  -> Tier 1 vs Raw NestJS: ${((t1JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t1JitRps / t1FbRps).toFixed(2)}x\n`,
);

const deepJitRps = await withJit(true, () =>
  benchTarget(
    "resultar-nestjs Tier 1 deep (8-service scoped DAG) (JIT=1)",
    () =>
      startNestApp(
        createNestApp({
          services: createDeepModule(),
          bindings: ["s6"],
          controllers: [DeepTier1Controller],
          logger: false,
        }),
      ),
    "/deep",
    "37",
  ),
);
const deepFbRps = await withJit(false, () =>
  benchTarget(
    "resultar-nestjs Tier 1 deep (8-service scoped DAG) (JIT=0)",
    () =>
      startNestApp(
        createNestApp({
          services: createDeepModule(),
          bindings: ["s6"],
          controllers: [DeepTier1Controller],
          logger: false,
        }),
      ),
    "/deep",
    "37",
  ),
);
console.log(
  `  -> Deep Tier 1 vs Raw NestJS: ${((deepJitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(deepJitRps / deepFbRps).toFixed(2)}x\n`,
);

const t0GuardRps = await withJit(true, () =>
  benchTarget(
    'resultar-nestjs Tier 0 (requestHook: "guard") (JIT=1)',
    () =>
      startNestApp(
        createNestApp({
          services: createBaseModule(),
          bindings: ["repo"],
          requestHook: "guard",
          controllers: [Tier0Controller],
          logger: false,
        }),
      ),
    "/users/42",
    "resultar:42",
  ),
);
console.log(`  -> Tier 0 (guard) vs Raw NestJS: ${((t0GuardRps / rawRps) * 100).toFixed(1)}%\n`);

const t2Rps = await benchTarget(
  "resultar-nestjs Tier 2 (scoped resource acquire/release)",
  () =>
    startNestApp(
      createNestApp({
        services: createBaseModule(),
        bindings: ["repo", "tx"],
        controllers: [Tier2Controller],
        logger: false,
      }),
    ),
  "/users/42",
  "resultar:42:tx-1",
);
console.log(`  -> Tier 0 vs Tier 2: ${(t0JitRps / t2Rps).toFixed(2)}x`);
