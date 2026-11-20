import { strictEqual } from "node:assert";
import http from "node:http";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { createFastifyApp, type InferRequestServices } from "resultar-fastify";

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

const benchServer = async (
  name: string,
  app: FastifyInstance,
  path: string,
  expectedBody: string,
): Promise<number> => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected TCP address");
  }
  const port = address.port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  try {
    const check = await requestOnce(agent, port, path);
    strictEqual(check.status, 200);
    strictEqual(check.body, expectedBody);

    // Warmup
    await runBurst(agent, port, path);

    const times: number[] = [];
    for (let s = 0; s < samples; s += 1) {
      const start = performance.now();
      await runBurst(agent, port, path);
      times.push(performance.now() - start);
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
    await app.close();
  }
};

const makeRawFastify = () => {
  const app = Fastify();
  const repo = { lookup: (id: string) => `resultar:${id}` };
  app.get<{ Params: { id: string } }>("/users/:id", (request) => repo.lookup(request.params.id));
  return app;
};

const makeTier0App = () => {
  const app = createFastifyApp(
    {
      services: createBaseModule(),
      bindings: ["repo"],
    },
    (instance) => {
      instance.get<{ Params: { id: string } }>("/users/:id", (request) => {
        const { repo } = request.getDecorator<InferRequestServices<typeof app>>("services");
        return repo.lookup(request.params.id);
      });
    },
  );
  return app;
};

const makeTier1LocalsApp = () => {
  const app = createFastifyApp(
    {
      services: createBaseModule(),
      bindings: ["serviceA", "nonce"],
      locals: (request) => ({ reqId: request.id }),
    },
    (instance) => {
      instance.get<{ Params: { id: string } }>("/users/:id", (request) => {
        const { serviceA, nonce } =
          request.getDecorator<InferRequestServices<typeof app>>("services");
        return `${serviceA.handle(request.params.id)}:${String(nonce)}`;
      });
    },
  );
  return app;
};

const makeDeepTier1App = () => {
  const app = createFastifyApp(
    {
      services: createDeepModule(),
      bindings: ["s6"],
    },
    (instance) => {
      instance.get("/deep", (request) => {
        const { s6 } = request.getDecorator<InferRequestServices<typeof app>>("services");
        return String(s6.v);
      });
    },
  );
  return app;
};

const makeTier2App = () => {
  const app = createFastifyApp(
    {
      services: createBaseModule(),
      bindings: ["repo", "tx"],
    },
    (instance) => {
      instance.get<{ Params: { id: string } }>("/users/:id", (request) => {
        const { repo, tx } = request.getDecorator<InferRequestServices<typeof app>>("services");
        return `${repo.lookup(request.params.id)}:${tx.id}`;
      });
    },
  );
  return app;
};

console.log(
  `=== Resultar Fastify HTTP Benchmark (Node ${process.version}, ${process.platform}/${process.arch}, keep-alive c=${concurrency}) ===\n`,
);

const rawRps = await benchServer(
  "Raw Fastify (no DI)",
  makeRawFastify(),
  "/users/42",
  "resultar:42",
);

const t0JitRps = await withJit(true, () =>
  benchServer(
    "resultar-fastify Tier 0 (singleton) (JIT=1)",
    makeTier0App(),
    "/users/42",
    "resultar:42",
  ),
);
const t0FbRps = await withJit(false, () =>
  benchServer(
    "resultar-fastify Tier 0 (singleton) (JIT=0)",
    makeTier0App(),
    "/users/42",
    "resultar:42",
  ),
);
console.log(
  `  -> Tier 0 vs Raw Fastify: ${((t0JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t0JitRps / t0FbRps).toFixed(2)}x\n`,
);

const t1JitRps = await withJit(true, () =>
  benchServer(
    "resultar-fastify Tier 1 (scoped+transient+locals) (JIT=1)",
    makeTier1LocalsApp(),
    "/users/42",
    "resultar:42:7",
  ),
);
const t1FbRps = await withJit(false, () =>
  benchServer(
    "resultar-fastify Tier 1 (scoped+transient+locals) (JIT=0)",
    makeTier1LocalsApp(),
    "/users/42",
    "resultar:42:7",
  ),
);
console.log(
  `  -> Tier 1 vs Raw Fastify: ${((t1JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t1JitRps / t1FbRps).toFixed(2)}x\n`,
);

const deepJitRps = await withJit(true, () =>
  benchServer(
    "resultar-fastify Tier 1 deep (8-service scoped DAG) (JIT=1)",
    makeDeepTier1App(),
    "/deep",
    "37",
  ),
);
const deepFbRps = await withJit(false, () =>
  benchServer(
    "resultar-fastify Tier 1 deep (8-service scoped DAG) (JIT=0)",
    makeDeepTier1App(),
    "/deep",
    "37",
  ),
);
console.log(
  `  -> Deep Tier 1 vs Raw Fastify: ${((deepJitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(deepJitRps / deepFbRps).toFixed(2)}x\n`,
);

const t2Rps = await benchServer(
  "resultar-fastify Tier 2 (scoped resource acquire/release)",
  makeTier2App(),
  "/users/42",
  "resultar:42:tx-1",
);
console.log(`  -> Tier 0 vs Tier 2: ${(t0JitRps / t2Rps).toFixed(2)}x`);
