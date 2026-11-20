import { strictEqual } from "node:assert";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { createHonoServices } from "resultar-hono";

const withJit = <T>(enabled: boolean, build: () => T): T => {
  const prev = process.env.RESULTAR_JIT;
  process.env.RESULTAR_JIT = enabled ? "1" : "0";
  try {
    return build();
  } finally {
    if (prev === undefined) delete process.env.RESULTAR_JIT;
    else process.env.RESULTAR_JIT = prev;
  }
};

const createTestModule = () =>
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

const makeRawHono = () => {
  const app = new Hono();
  const repo = { lookup: (id: string) => `resultar:${id}` };
  app.get("/users/:id", (c) => c.text(repo.lookup(c.req.param("id"))));
  return app;
};

const makeDiHono = (tier: 0 | 1 | 2, jitEnabled: boolean) => {
  const di = createHonoServices(createTestModule());
  const app = new Hono();
  if (tier === 0) {
    app.use("*", di.middleware(["repo"]));
    app.get("/users/:id", (c) => c.text(c.var.services.repo.lookup(c.req.param("id"))));
  } else if (tier === 1) {
    app.use(
      "*",
      di.middleware(["serviceA", "nonce"], {
        locals: (c) => ({ reqId: c.req.param("id") ?? "0" }),
      }),
    );
    app.get("/users/:id", (c) =>
      c.text(`${c.var.services.serviceA.handle(c.req.param("id"))}:${c.var.services.nonce}`),
    );
  } else {
    app.use("*", di.middleware(["repo", "tx"]));
    app.get("/users/:id", (c) =>
      c.text(`${c.var.services.repo.lookup(c.req.param("id"))}:${c.var.services.tx.id}`),
    );
  }

  // Trigger initial plan compile under the requested JIT mode
  return {
    close: () => di.close(),
    warmup: () => withJit(jitEnabled, () => app.fetch(new Request("http://localhost/users/42"))),
    fetch: (request: Request) => app.fetch(request),
  };
};

const iterations = 25_000;
const samples = 5;

const benchAsync = async (name: string, fn: () => Promise<void>): Promise<number> => {
  await fn();
  const times: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(samples / 2)]!;
  const rps = Math.round((iterations / medianMs) * 1000);
  console.log(
    `- ${name}: ${rps.toLocaleString("en-US")} req/s (median ${medianMs.toFixed(2)} ms / ${iterations.toLocaleString("en-US")} reqs)`,
  );
  return rps;
};

console.log(
  `=== Resultar DI + Hono HTTP Benchmark (Node ${process.version}, ${process.platform}/${process.arch}) ===\n`,
);

const rawApp = makeRawHono();
const rawSample = await rawApp.fetch(new Request("http://localhost/users/42"));
strictEqual(await rawSample.text(), "resultar:42");

const rawRps = await benchAsync("Raw Hono (no DI)", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await rawApp.fetch(new Request("http://localhost/users/42"));
    strictEqual(res.status, 200);
  }
});

const t0Jit = makeDiHono(0, true);
const t0Fallback = makeDiHono(0, false);
strictEqual(await (await t0Jit.warmup()).text(), "resultar:42");
strictEqual(await (await t0Fallback.warmup()).text(), "resultar:42");

const t0JitRps = await benchAsync("resultar-di Tier 0 (singleton) + Hono (JIT=1)", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await t0Jit.fetch(new Request("http://localhost/users/42"));
    strictEqual(res.status, 200);
  }
});
const t0FallbackRps = await benchAsync("resultar-di Tier 0 (singleton) + Hono (JIT=0)", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await t0Fallback.fetch(new Request("http://localhost/users/42"));
    strictEqual(res.status, 200);
  }
});
console.log(
  `  -> Tier 0 JIT vs Raw Hono: ${((t0JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t0JitRps / t0FallbackRps).toFixed(2)}x\n`,
);

const t1Jit = makeDiHono(1, true);
const t1Fallback = makeDiHono(1, false);
strictEqual(await (await t1Jit.warmup()).text(), "resultar:42:7");
strictEqual(await (await t1Fallback.warmup()).text(), "resultar:42:7");

const t1JitRps = await benchAsync(
  "resultar-di Tier 1 (scoped+transient+locals) + Hono (JIT=1)",
  async () => {
    for (let i = 0; i < iterations; i += 1) {
      const res = await t1Jit.fetch(new Request("http://localhost/users/42"));
      strictEqual(res.status, 200);
    }
  },
);
const t1FallbackRps = await benchAsync(
  "resultar-di Tier 1 (scoped+transient+locals) + Hono (JIT=0)",
  async () => {
    for (let i = 0; i < iterations; i += 1) {
      const res = await t1Fallback.fetch(new Request("http://localhost/users/42"));
      strictEqual(res.status, 200);
    }
  },
);
console.log(
  `  -> Tier 1 JIT vs Raw Hono: ${((t1JitRps / rawRps) * 100).toFixed(1)}% | JIT=1 vs JIT=0: ${(t1JitRps / t1FallbackRps).toFixed(2)}x\n`,
);

const t2 = makeDiHono(2, true);
strictEqual(await (await t2.warmup()).text(), "resultar:42:tx-1");
const t2Rps = await benchAsync("resultar-di Tier 2 (scoped resource acquire/release) + Hono", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await t2.fetch(new Request("http://localhost/users/42"));
    strictEqual(res.status, 200);
    await res.body?.cancel();
  }
});
console.log(`  -> Tier 0 JIT vs Tier 2 (full TaskScope): ${(t0JitRps / t2Rps).toFixed(2)}x\n`);

// Direct resultar-di root.fetch() with a deeper 8-service Tier 1 scoped graph (no Hono overhead)
const makeDeepScope = () =>
  createModule()
    .value("cfg", { env: "prod" })
    .singleton("db", ["cfg"], ({ cfg }) => ({ env: cfg.env }))
    .scoped("s1", ["db"], ({ db }) => ({ v: db.env.length }))
    .scoped("s2", ["s1"], ({ s1 }) => ({ v: s1.v + 1 }))
    .scoped("s3", ["s1", "s2"], ({ s1, s2 }) => ({ v: s1.v + s2.v }))
    .scoped("s4", ["s2", "s3"], ({ s2, s3 }) => ({ v: s2.v + s3.v }))
    .scoped("s5", ["s3", "s4"], ({ s3, s4 }) => ({ v: s3.v + s4.v }))
    .scoped("s6", ["s4", "s5"], ({ s4, s5 }) => ({ v: s4.v + s5.v }))
    .scope();

const deepJitRoot = makeDeepScope();
const deepFbRoot = makeDeepScope();
const sharedReq = new Request("http://localhost/deep");
const deepJitFetch = withJit(true, () =>
  deepJitRoot.fetch(["s6"], ({ s6 }) => new Response(String(s6.v))),
);
const deepFbFetch = withJit(false, () =>
  deepFbRoot.fetch(["s6"], ({ s6 }) => new Response(String(s6.v))),
);
strictEqual(await (await deepJitFetch(sharedReq)).text(), "37");
strictEqual(await (await deepFbFetch(sharedReq)).text(), "37");

const deepJitRps = await benchAsync("resultar-di direct root.fetch 8-service Tier 1 (JIT=1)", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await deepJitFetch(sharedReq);
    strictEqual(res.status, 200);
  }
});
const deepFbRps = await benchAsync("resultar-di direct root.fetch 8-service Tier 1 (JIT=0)", async () => {
  for (let i = 0; i < iterations; i += 1) {
    const res = await deepFbFetch(sharedReq);
    strictEqual(res.status, 200);
  }
});
console.log(`  -> Deep Tier 1 JIT=1 vs JIT=0: ${(deepJitRps / deepFbRps).toFixed(2)}x\n`);

await ResultTask.runPromise(deepJitRoot.close());
await ResultTask.runPromise(deepFbRoot.close());
await t0Jit.close();
await t0Fallback.close();
await t1Jit.close();
await t1Fallback.close();
await t2.close();
