import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { createHonoApp, createHonoServices } from "resultar-hono";

type ScenarioId =
  | "raw-hono"
  | "tier0-middleware"
  | "tier1-middleware"
  | "tier2-middleware"
  | "tier0-app"
  | "tier1-app"
  | "deep-tier1-fetch";

interface WorkerResult {
  readonly scenario: ScenarioId;
  readonly label: string;
  readonly jitMode: string;
  readonly commit: string;
  readonly iterations: number;
  readonly samples: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly iqrMs: number;
  readonly rps: number;
  readonly usPerReq: number;
}

const DEFAULT_ITERATIONS = Number.parseInt(process.env.BENCH_ITERATIONS ?? "20000", 10);
const DEFAULT_WARMUP = Number.parseInt(process.env.BENCH_WARMUP ?? "4000", 10);
const DEFAULT_SAMPLES = Number.parseInt(process.env.BENCH_SAMPLES ?? "7", 10);

const getGitCommit = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const getHonoVersion = (): string => {
  try {
    const pkgPath = resolve(import.meta.dirname, "node_modules/hono/package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { readonly version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
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
  return {
    fetch: (request: Request) => app.fetch(request),
    close: async () => undefined,
    expectedBody: "resultar:42",
  };
};

const makeMiddlewareApp = (tier: 0 | 1 | 2) => {
  const di = createHonoServices(createTestModule());
  const app = new Hono();
  let expectedBody = "resultar:42";
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
    expectedBody = "resultar:42:7";
  } else {
    app.use("*", di.middleware(["repo", "tx"]));
    app.get("/users/:id", (c) =>
      c.text(`${c.var.services.repo.lookup(c.req.param("id"))}:${c.var.services.tx.id}`),
    );
    expectedBody = "resultar:42:tx-1";
  }
  return {
    fetch: (request: Request) => app.fetch(request),
    close: async () => {
      await di.close();
    },
    expectedBody,
  };
};

const makeHonoBoundApp = (tier: 0 | 1) => {
  if (tier === 0) {
    const app = createHonoApp({ services: createTestModule(), bindings: ["repo"] }, (router) => {
      router.get("/users/:id", (c) => c.text(c.env.repo.lookup(c.req.param("id"))));
    });
    return {
      fetch: (request: Request) => app.fetch(request),
      close: async () => {
        await app.close();
      },
      expectedBody: "resultar:42",
    };
  }
  const app = createHonoApp(
    { services: createTestModule(), bindings: ["serviceA", "nonce"] },
    (router) => {
      router.get("/users/:id", (c) =>
        c.text(`${c.env.serviceA.handle(c.req.param("id"))}:${c.env.nonce}`),
      );
    },
  );
  return {
    fetch: (request: Request) => app.fetch(request),
    close: async () => {
      await app.close();
    },
    expectedBody: "resultar:42:7",
  };
};

const makeDeepDirectFetch = () => {
  const root = createModule()
    .value("cfg", { env: "prod" })
    .singleton("db", ["cfg"], ({ cfg }) => ({ env: cfg.env }))
    .scoped("s1", ["db"], ({ db }) => ({ v: db.env.length }))
    .scoped("s2", ["s1"], ({ s1 }) => ({ v: s1.v + 1 }))
    .scoped("s3", ["s1", "s2"], ({ s1, s2 }) => ({ v: s1.v + s2.v }))
    .scoped("s4", ["s2", "s3"], ({ s2, s3 }) => ({ v: s2.v + s3.v }))
    .scoped("s5", ["s3", "s4"], ({ s3, s4 }) => ({ v: s3.v + s4.v }))
    .scoped("s6", ["s4", "s5"], ({ s4, s5 }) => ({ v: s4.v + s5.v }))
    .scope();

  const handle = root.fetch(["s6"], ({ s6 }) => new Response(String(s6.v)));
  return {
    fetch: (request: Request) => handle(request),
    close: async () => {
      await ResultTask.runPromise(root.close());
    },
    expectedBody: "37",
  };
};

const SCENARIO_LABELS: Readonly<Record<ScenarioId, string>> = {
  "raw-hono": "Raw Hono (no DI)",
  "tier0-middleware": "resultar-di Tier 0 (singleton) + Hono middleware",
  "tier1-middleware": "resultar-di Tier 1 (scoped+transient+locals) + Hono middleware",
  "tier2-middleware": "resultar-di Tier 2 (scoped resource) + Hono middleware",
  "tier0-app": "resultar-di Tier 0 (singleton) + createHonoApp",
  "tier1-app": "resultar-di Tier 1 (scoped+transient) + createHonoApp",
  "deep-tier1-fetch": "resultar-di direct root.fetch 8-service Tier 1",
};

const buildScenario = (scenario: ScenarioId) => {
  switch (scenario) {
    case "raw-hono":
      return makeRawHono();
    case "tier0-middleware":
      return makeMiddlewareApp(0);
    case "tier1-middleware":
      return makeMiddlewareApp(1);
    case "tier2-middleware":
      return makeMiddlewareApp(2);
    case "tier0-app":
      return makeHonoBoundApp(0);
    case "tier1-app":
      return makeHonoBoundApp(1);
    case "deep-tier1-fetch":
      return makeDeepDirectFetch();
  }
};

const runWorker = async (scenario: ScenarioId): Promise<void> => {
  const target = buildScenario(scenario);
  const url = scenario === "deep-tier1-fetch" ? "http://localhost/deep" : "http://localhost/users/42";
  const jitMode = process.env.RESULTAR_JIT ?? "default(1)";

  // Correctness check + full body consumption warmup
  const firstRes = await target.fetch(new Request(url));
  strictEqual(firstRes.status, 200);
  strictEqual(await firstRes.text(), target.expectedBody);

  for (let i = 0; i < DEFAULT_WARMUP; i += 1) {
    const res = await target.fetch(new Request(url));
    strictEqual(res.status, 200);
    await res.text();
  }

  const times: number[] = [];
  for (let s = 0; s < DEFAULT_SAMPLES; s += 1) {
    const start = performance.now();
    for (let i = 0; i < DEFAULT_ITERATIONS; i += 1) {
      const res = await target.fetch(new Request(url));
      strictEqual(res.status, 200);
      await res.text();
    }
    times.push(performance.now() - start);
  }

  await target.close();

  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)]!;
  const minMs = times[0]!;
  const maxMs = times[times.length - 1]!;
  const q1 = times[Math.floor(times.length * 0.25)]!;
  const q3 = times[Math.floor(times.length * 0.75)]!;
  const iqrMs = Math.max(0, q3 - q1);
  const rps = Math.round((DEFAULT_ITERATIONS / medianMs) * 1000);
  const usPerReq = (medianMs / DEFAULT_ITERATIONS) * 1000;

  const result: WorkerResult = {
    scenario,
    label: SCENARIO_LABELS[scenario],
    jitMode,
    commit: getGitCommit(),
    iterations: DEFAULT_ITERATIONS,
    samples: DEFAULT_SAMPLES,
    medianMs,
    minMs,
    maxMs,
    iqrMs,
    rps,
    usPerReq,
  };
  console.log(`__RESULT__${JSON.stringify(result)}`);
};

const spawnWorker = (scenario: ScenarioId, jitFlag: "0" | "1"): WorkerResult => {
  const selfPath = fileURLToPath(import.meta.url);
  const stdout = execFileSync(
    process.execPath,
    ["--import", "vite-plus/register", selfPath, "--worker", scenario],
    {
      encoding: "utf8",
      env: { ...process.env, RESULTAR_JIT: jitFlag },
    },
  );
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("__RESULT__"));
  if (line === undefined) {
    throw new Error(`Missing worker result for ${scenario} (JIT=${jitFlag}):\n${stdout}`);
  }
  return JSON.parse(line.slice("__RESULT__".length)) as WorkerResult;
};

const formatRow = (r: WorkerResult, rawUs?: number): string => {
  const overhead =
    rawUs === undefined ? "" : ` | delta vs raw: ${(r.usPerReq - rawUs >= 0 ? "+" : "") + (r.usPerReq - rawUs).toFixed(2)} µs`;
  return `- ${r.label} [commit=${r.commit}, RESULTAR_JIT=${r.jitMode}]: ${r.rps.toLocaleString("en-US")} req/s (median ${r.usPerReq.toFixed(2)} µs/req, ${r.medianMs.toFixed(2)} ms [${r.minMs.toFixed(2)}..${r.maxMs.toFixed(2)} ms, IQR ${r.iqrMs.toFixed(2)} ms] / ${r.iterations.toLocaleString("en-US")} reqs${overhead})`;
};

const workerIdx = process.argv.indexOf("--worker");
if (workerIdx !== -1) {
  const scenarioArg = process.argv[workerIdx + 1] as ScenarioId | undefined;
  if (scenarioArg === undefined || !(scenarioArg in SCENARIO_LABELS)) {
    throw new Error(`Unknown --worker scenario: ${String(scenarioArg)}`);
  }
  await runWorker(scenarioArg);
} else {
  const jsonOutput = process.argv.includes("--json");
  const commit = getGitCommit();
  const honoVersion = getHonoVersion();

  const plan: readonly (readonly [ScenarioId, "0" | "1"])[] = [
    ["raw-hono", "1"],
    ["tier0-middleware", "1"],
    ["tier0-middleware", "0"],
    ["tier1-middleware", "1"],
    ["tier1-middleware", "0"],
    ["tier2-middleware", "1"],
    ["tier0-app", "1"],
    ["tier1-app", "1"],
    ["deep-tier1-fetch", "1"],
    ["deep-tier1-fetch", "0"],
  ];

  const results: WorkerResult[] = [];
  for (const [scenario, jitFlag] of plan) {
    results.push(spawnWorker(scenario, jitFlag));
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ commit, node: process.version, platform: `${process.platform}/${process.arch}`, honoVersion, results }, null, 2));
  } else {
    const raw = results.find((r) => r.scenario === "raw-hono")!;
    const t0Jit = results.find((r) => r.scenario === "tier0-middleware" && r.jitMode === "1")!;
    const t0Fb = results.find((r) => r.scenario === "tier0-middleware" && r.jitMode === "0")!;
    const t1Jit = results.find((r) => r.scenario === "tier1-middleware" && r.jitMode === "1")!;
    const t1Fb = results.find((r) => r.scenario === "tier1-middleware" && r.jitMode === "0")!;
    const t2 = results.find((r) => r.scenario === "tier2-middleware")!;
    const t0App = results.find((r) => r.scenario === "tier0-app")!;
    const t1App = results.find((r) => r.scenario === "tier1-app")!;
    const deepJit = results.find((r) => r.scenario === "deep-tier1-fetch" && r.jitMode === "1")!;
    const deepFb = results.find((r) => r.scenario === "deep-tier1-fetch" && r.jitMode === "0")!;

    console.log(
      `=== Resultar DI + Hono HTTP Benchmark (isolated processes, full body consumption) ===\n` +
        `Commit: ${commit} | Node: ${process.version} (${process.platform}/${process.arch}) | Hono: ${honoVersion}\n` +
        `Config: ${DEFAULT_ITERATIONS.toLocaleString("en-US")} reqs × ${DEFAULT_SAMPLES} samples (+ ${DEFAULT_WARMUP.toLocaleString("en-US")} warmup)\n`,
    );

    console.log(formatRow(raw));
    console.log(formatRow(t0Jit, raw.usPerReq));
    console.log(formatRow(t0Fb, raw.usPerReq));
    console.log(
      `  -> Tier 0 middleware JIT=1 vs Raw Hono: ${((t0Jit.rps / raw.rps) * 100).toFixed(1)}% (+${(t0Jit.usPerReq - raw.usPerReq).toFixed(2)} µs) | JIT=1 vs JIT=0: ${(t0Jit.rps / t0Fb.rps).toFixed(2)}x\n`,
    );

    console.log(formatRow(t1Jit, raw.usPerReq));
    console.log(formatRow(t1Fb, raw.usPerReq));
    console.log(
      `  -> Tier 1 middleware JIT=1 vs Raw Hono: ${((t1Jit.rps / raw.rps) * 100).toFixed(1)}% (+${(t1Jit.usPerReq - raw.usPerReq).toFixed(2)} µs) | JIT=1 vs JIT=0: ${(t1Jit.rps / t1Fb.rps).toFixed(2)}x\n`,
    );

    console.log(formatRow(t2, raw.usPerReq));
    console.log(
      `  -> Tier 0 JIT vs Tier 2 (full TaskScope): ${(t0Jit.rps / t2.rps).toFixed(2)}x | Tier 1 JIT vs Tier 2: ${(t1Jit.rps / t2.rps).toFixed(2)}x\n`,
    );

    console.log(formatRow(t0App, raw.usPerReq));
    console.log(formatRow(t1App, raw.usPerReq));
    console.log("");

    console.log(formatRow(deepJit));
    console.log(formatRow(deepFb));
    console.log(`  -> Deep 8-service Tier 1 JIT=1 vs JIT=0: ${(deepJit.rps / deepFb.rps).toFixed(2)}x`);
  }
}
