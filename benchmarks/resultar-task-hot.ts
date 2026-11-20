import { strictEqual } from "node:assert";
import { performance } from "node:perf_hooks";
import { Data, Effect } from "effect";
import { createTaggedError, ResultTask } from "resultar";

class ResultarBoom extends createTaggedError({ name: "Boom", message: "boom $code" }) {}
class EffectBoom extends Data.TaggedError("Boom")<{ readonly code: number }> {}

const withJit = <T>(enabled: boolean, run: () => T): T => {
  const prev = process.env.RESULTAR_JIT;
  process.env.RESULTAR_JIT = enabled ? "1" : "0";
  try {
    return run();
  } finally {
    if (prev === undefined) delete process.env.RESULTAR_JIT;
    else process.env.RESULTAR_JIT = prev;
  }
};

const buildResultarChain = (steps: number) => {
  let current = ResultTask.ok(0);
  for (let i = 0; i < steps; i += 1) {
    current = i % 2 === 0 ? current.map((n) => n + 1) : current.andThen((n) => ResultTask.ok(n + 1));
  }
  return current;
};

const buildEffectChain = (steps: number) => {
  let current: Effect.Effect<number> = Effect.succeed(0);
  for (let i = 0; i < steps; i += 1) {
    current =
      i % 2 === 0
        ? Effect.map(current, (n) => n + 1)
        : Effect.flatMap(current, (n) => Effect.succeed(n + 1));
  }
  return current;
};

const buildResultarRecovery = () =>
  ResultTask.err(new ResultarBoom({ code: 42 }))
    .map((n: number) => n * 2)
    .mapErr((e) => e)
    .catchTag("Boom", (e) => ResultTask.ok(Number(e.code) + 1))
    .map((n) => n * 2);

const buildEffectRecovery = () =>
  Effect.fail(new EffectBoom({ code: 42 })).pipe(
    Effect.map((n: number) => n * 2),
    Effect.mapError((e) => e),
    Effect.catchTag("Boom", (e) => Effect.succeed(e.code + 1)),
    Effect.map((n) => n * 2),
  );

const iterations = 100_000;
const samples = 5;

const benchSync = (name: string, fn: () => void): number => {
  fn();
  const times: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(samples / 2)]!;
  const ops = Math.round((iterations / medianMs) * 1000);
  console.log(
    `- ${name}: ${ops.toLocaleString("en-US")} op/s (median ${medianMs.toFixed(2)} ms / ${iterations.toLocaleString("en-US")} runs)`,
  );
  return ops;
};

console.log(
  `=== ResultTask Tiered JIT Hot-Chain Benchmark (Node ${process.version}, ${process.platform}/${process.arch}) ===\n`,
);

for (const steps of [10, 50]) {
  const jitTask = buildResultarChain(steps);
  const fallbackTask = buildResultarChain(steps);
  const effectTask = buildEffectChain(steps);

  // Trigger JIT compile on jitTask, keep fallbackTask uncompiled
  withJit(true, () => {
    strictEqual(ResultTask.runSync(jitTask)._unsafeUnwrap(), steps);
    strictEqual(ResultTask.runSync(jitTask)._unsafeUnwrap(), steps);
  });
  withJit(false, () => {
    strictEqual(ResultTask.runSync(fallbackTask)._unsafeUnwrap(), steps);
    strictEqual(ResultTask.runSync(fallbackTask)._unsafeUnwrap(), steps);
  });
  strictEqual(Effect.runSync(effectTask), steps);

  const jitOps = benchSync(`Reused ${steps}-step map+andThen / Resultar (JIT=1)`, () => {
    for (let i = 0; i < iterations; i += 1) {
      strictEqual(ResultTask.runSync(jitTask)._unsafeUnwrap(), steps);
    }
  });
  const fbOps = benchSync(`Reused ${steps}-step map+andThen / Resultar (JIT=0)`, () => {
    for (let i = 0; i < iterations; i += 1) {
      strictEqual(ResultTask.runSync(fallbackTask)._unsafeUnwrap(), steps);
    }
  });
  const effOps = benchSync(`Reused ${steps}-step map+andThen / Effect v4`, () => {
    for (let i = 0; i < iterations; i += 1) {
      strictEqual(Effect.runSync(effectTask), steps);
    }
  });
  console.log(
    `  -> JIT=1 vs JIT=0: ${(jitOps / fbOps).toFixed(2)}x | Resultar JIT vs Effect v4: ${(jitOps / effOps).toFixed(2)}x\n`,
  );
}

const jitRec = buildResultarRecovery();
const fbRec = buildResultarRecovery();
const effRec = buildEffectRecovery();
withJit(true, () => {
  strictEqual(ResultTask.runSync(jitRec)._unsafeUnwrap(), 86);
  strictEqual(ResultTask.runSync(jitRec)._unsafeUnwrap(), 86);
});
withJit(false, () => {
  strictEqual(ResultTask.runSync(fbRec)._unsafeUnwrap(), 86);
  strictEqual(ResultTask.runSync(fbRec)._unsafeUnwrap(), 86);
});
strictEqual(Effect.runSync(effRec), 86);

const recJitOps = benchSync("Reused catchTag+mapErr chain / Resultar (JIT=1)", () => {
  for (let i = 0; i < iterations; i += 1) {
    strictEqual(ResultTask.runSync(jitRec)._unsafeUnwrap(), 86);
  }
});
const recFbOps = benchSync("Reused catchTag+mapErr chain / Resultar (JIT=0)", () => {
  for (let i = 0; i < iterations; i += 1) {
    strictEqual(ResultTask.runSync(fbRec)._unsafeUnwrap(), 86);
  }
});
const recEffOps = benchSync("Reused catchTag+mapErr chain / Effect v4", () => {
  for (let i = 0; i < iterations; i += 1) {
    strictEqual(Effect.runSync(effRec), 86);
  }
});
console.log(
  `  -> JIT=1 vs JIT=0: ${(recJitOps / recFbOps).toFixed(2)}x | Resultar JIT vs Effect v4: ${(recJitOps / recEffOps).toFixed(2)}x`,
);
