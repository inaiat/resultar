import { strictEqual } from "node:assert";
import { performance } from "node:perf_hooks";
import { requestJsonTypeBox, t } from "resultar-request-typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

const payloadSchema = t.Object({
  id: t.String(),
  name: t.String(),
  email: t.String(),
  active: t.Boolean(),
  score: t.Number({ minimum: 0, maximum: 1000 }),
  roles: t.Array(t.Union([t.Literal("admin"), t.Literal("editor"), t.Literal("viewer")])),
  address: t.Object({
    street: t.String(),
    city: t.String(),
    country: t.String(),
    zip: t.String(),
  }),
});

const samplePayload = {
  id: "usr_123456789",
  name: "Ada Lovelace",
  email: "ada@example.com",
  active: true,
  score: 985,
  roles: ["admin", "editor"],
  address: {
    street: "12 St James's Square",
    city: "London",
    country: "GB",
    zip: "SW1Y 4LB",
  },
};

const payloadJson = JSON.stringify(samplePayload);
const compiledDirect = Compile(payloadSchema);

const validateIterations = 500_000;
const requestIterations = 25_000;
const samples = 5;

const benchSync = (name: string, count: number, fn: () => number): number => {
  fn();
  const times: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(samples / 2)]!;
  const ops = Math.round((count / medianMs) * 1000);
  console.log(
    `- ${name}: ${ops.toLocaleString("en-US")} op/s (median ${medianMs.toFixed(2)} ms / ${count.toLocaleString("en-US")} ops)`,
  );
  return ops;
};

const benchAsync = async (name: string, count: number, fn: () => Promise<void>): Promise<number> => {
  await fn();
  const times: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(samples / 2)]!;
  const ops = Math.round((count / medianMs) * 1000);
  console.log(
    `- ${name}: ${ops.toLocaleString("en-US")} op/s (median ${medianMs.toFixed(2)} ms / ${count.toLocaleString("en-US")} ops)`,
  );
  return ops;
};

console.log(
  `=== Resultar TypeBox Compiled Validation Benchmark (Node ${process.version}, ${process.platform}/${process.arch}) ===\n`,
);

const directCompiledOps = benchSync("TypeBox Compile(schema).Check (JIT)", validateIterations, () => {
  let okCount = 0;
  for (let i = 0; i < validateIterations; i += 1) {
    if (compiledDirect.Check(samplePayload)) okCount += 1;
  }
  strictEqual(okCount, validateIterations);
  return okCount;
});

const directValueOps = benchSync("TypeBox Value.Check (uncompiled baseline)", validateIterations, () => {
  let okCount = 0;
  for (let i = 0; i < validateIterations; i += 1) {
    if (Value.Check(payloadSchema, samplePayload)) okCount += 1;
  }
  strictEqual(okCount, validateIterations);
  return okCount;
});
console.log(`  -> Direct Compile vs Value.Check: ${(directCompiledOps / directValueOps).toFixed(2)}x\n`);

const makeRequestTask = () =>
  requestJsonTypeBox({
    request: async () => new Response(payloadJson, { status: 200 }),
    schema: payloadSchema,
  });

process.env.RESULTAR_JIT = "1";
const jitTask = makeRequestTask();
const reqJitOps = await benchAsync("requestJsonTypeBox end-to-end (JIT=1)", requestIterations, async () => {
  for (let i = 0; i < requestIterations; i += 1) {
    const res = await jitTask.runPromise();
    strictEqual(res.id, "usr_123456789");
  }
});

process.env.RESULTAR_JIT = "0";
const fallbackTask = makeRequestTask();
const reqFallbackOps = await benchAsync(
  "requestJsonTypeBox end-to-end (JIT=0)",
  requestIterations,
  async () => {
    for (let i = 0; i < requestIterations; i += 1) {
      const res = await fallbackTask.runPromise();
      strictEqual(res.id, "usr_123456789");
    }
  },
);
delete process.env.RESULTAR_JIT;

console.log(`  -> requestJsonTypeBox JIT=1 vs JIT=0: ${(reqJitOps / reqFallbackOps).toFixed(2)}x`);
