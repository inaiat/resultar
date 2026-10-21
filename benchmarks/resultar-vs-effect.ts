import type { Results, Tests } from "cronometro";
import type { FiberHandle } from "resultar";

import { cronometro } from "cronometro";
import { Data, Effect, Fiber as EffectFiber, Semaphore as EffectSemaphore } from "effect";
import { deepStrictEqual, strictEqual } from "node:assert";
import {
  createTaggedError,
  Fiber as ResultarFiber,
  ok,
  Result,
  ResultTask,
  Semaphore as ResultarSemaphore,
} from "resultar";

class ResultarNotFoundError extends createTaggedError({
  name: "NotFoundError",
  message: "Not found: $id",
}) {}

class EffectNotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly id: string;
}> {}

let sink: unknown;

const consume = (value: unknown): void => {
  sink = value;
};

const CHAIN_STEPS = 50;
const FANOUT_COUNT = 100;
const FOREACH_ITEMS = Array.from({ length: 60 }, (_, index) => index + 1);
const SEMAPHORE_ITEMS = Array.from({ length: 40 }, (_, index) => index + 1);
const RESOURCE_IDS = [1, 2, 3, 4, 5] as const;
const INTERRUPT_CHILDREN = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const incrementResult = (value: number): Result<number, never> => ok(value + 1);
const incrementResultar = (value: number): ResultTask<number, never> => ResultTask.ok(value + 1);
const incrementEffect = (value: number): Effect.Effect<number> => Effect.succeed(value + 1);

const runResultSyncChain = (): number => {
  let current: Result<number, never> = ok(0);
  for (let step = 0; step < CHAIN_STEPS; step += 1) {
    current = current.andThen(incrementResult);
  }
  return current._unsafeUnwrap();
};

const runResultSyncGen = (seed: number): number =>
  Result.gen(function* () {
    const a = yield* ok(seed + 1);
    const b = yield* ok(a * 2);
    const c = yield* ok(b + 3);
    const d = yield* ok(c * 2);
    const e = yield* ok(d - 1);
    return e;
  })._unsafeUnwrap();

const buildResultarChain = (): ResultTask<number, never> => {
  let current = ResultTask.ok(0);
  for (let step = 0; step < CHAIN_STEPS; step += 1) {
    current = current.andThen(incrementResultar);
  }
  return current;
};

const buildEffectChain = (): Effect.Effect<number> => {
  let current = Effect.succeed(0);
  for (let step = 0; step < CHAIN_STEPS; step += 1) {
    current = Effect.flatMap(current, incrementEffect);
  }
  return current;
};

const resultarGenProgram = ResultTask.fn(function* (seed: number) {
  const a = yield* ResultTask.ok(seed + 1);
  const b = yield* ResultTask.ok(a * 2);
  const c = yield* ResultTask.ok(b + 3);
  const d = yield* ResultTask.ok(c * 2);
  const e = yield* ResultTask.ok(d - 1);
  return e;
});

const effectGenProgram = Effect.fnUntraced(function* (seed: number) {
  const a = yield* Effect.succeed(seed + 1);
  const b = yield* Effect.succeed(a * 2);
  const c = yield* Effect.succeed(b + 3);
  const d = yield* Effect.succeed(c * 2);
  const e = yield* Effect.succeed(d - 1);
  return e;
});

const runResultarCatchTag = (): Promise<number> => {
  const task: ResultTask<number, ResultarNotFoundError> = ResultTask.err(
    new ResultarNotFoundError({ id: "user-42" }),
  );
  const recovered = task
    .map((value) => value * 2)
    .catchTag("NotFoundError", (error) => ResultTask.ok(String(error.id).length));
  return ResultTask.runPromise(recovered);
};

const runEffectCatchTag = (): Promise<number> => {
  const effect: Effect.Effect<number, EffectNotFoundError> = Effect.fail(
    new EffectNotFoundError({ id: "user-42" }),
  );
  const recovered = effect.pipe(
    Effect.map((value) => value * 2),
    Effect.catchTag("NotFoundError", (error) => Effect.succeed(error.id.length)),
  );
  return Effect.runPromise(recovered);
};

const makeResultarAsyncDouble = (value: number): ResultTask<number, string> =>
  ResultTask.tryPromise({
    try: () => Promise.resolve(value * 2),
    catch: String,
  });

const makeEffectAsyncDouble = (value: number): Effect.Effect<number> =>
  Effect.promise(() => Promise.resolve(value * 2));

const runResultarFanout = (): Promise<readonly number[]> => {
  const program = ResultTask.gen(function* () {
    const fibers: FiberHandle<number, string>[] = [];
    for (let index = 0; index < FANOUT_COUNT; index += 1) {
      const fiber = yield* ResultTask.forkChild(makeResultarAsyncDouble(index));
      fibers.push(fiber);
    }
    const results: number[] = [];
    for (const fiber of fibers) {
      results.push(yield* ResultarFiber.join(fiber));
    }
    return results;
  });
  return ResultTask.runPromise(program);
};

const runEffectFanout = (): Promise<readonly number[]> => {
  const program = Effect.gen(function* () {
    const fibers: EffectFiber.Fiber<number>[] = [];
    for (let index = 0; index < FANOUT_COUNT; index += 1) {
      const fiber = yield* Effect.forkChild(makeEffectAsyncDouble(index));
      fibers.push(fiber);
    }
    const results: number[] = [];
    for (const fiber of fibers) {
      results.push(yield* EffectFiber.join(fiber));
    }
    return results;
  });
  return Effect.runPromise(program);
};

const runResultarForEachBounded = (): Promise<readonly number[]> =>
  ResultTask.runPromise(
    ResultTask.forEach(FOREACH_ITEMS, makeResultarAsyncDouble, {
      concurrency: 8,
    }),
  );

const runEffectForEachBounded = (): Promise<number[]> =>
  Effect.runPromise(
    Effect.forEach(FOREACH_ITEMS, makeEffectAsyncDouble, {
      concurrency: 8,
    }),
  );

const makeResultarSemaphoreWorker = (
  semaphore: ResultarSemaphore,
  value: number,
): ResultTask<number, string> => semaphore.withPermits(1, makeResultarAsyncDouble(value));

const makeEffectSemaphoreWorker = (
  semaphore: EffectSemaphore.Semaphore,
  value: number,
): Effect.Effect<number> => semaphore.withPermits(1)(makeEffectAsyncDouble(value));

const runResultarSemaphore = (): Promise<readonly number[]> => {
  const semaphore = ResultarSemaphore.make(4);
  const tasks = SEMAPHORE_ITEMS.map((item) => makeResultarSemaphoreWorker(semaphore, item));
  return ResultTask.runPromise(ResultTask.all(tasks, { concurrency: "unbounded" }));
};

const runEffectSemaphore = (): Promise<number[]> => {
  const semaphore = EffectSemaphore.makeUnsafe(4);
  const tasks = SEMAPHORE_ITEMS.map((item) => makeEffectSemaphoreWorker(semaphore, item));
  return Effect.runPromise(Effect.all(tasks, { concurrency: "unbounded" }));
};

const acquireResultarResource = (id: number, releasedOrder: number[]) =>
  ResultTask.acquireRelease({
    acquire: ResultTask.sync(() => id),
    release: (acquired) =>
      ResultTask.sync(() => {
        releasedOrder.push(acquired);
      }),
  });

const acquireEffectResource = (id: number, releasedOrder: number[]) =>
  Effect.acquireRelease(
    Effect.sync(() => id),
    (acquired) =>
      Effect.sync(() => {
        releasedOrder.push(acquired);
      }),
  );

const runResultarScopedResources = async (): Promise<readonly number[]> => {
  const releasedOrder: number[] = [];
  const program = ResultTask.scoped(
    ResultTask.gen(function* () {
      let sum = 0;
      for (const id of RESOURCE_IDS) {
        const resource = yield* acquireResultarResource(id, releasedOrder);
        sum += resource;
      }
      return sum;
    }),
  );
  const total = await ResultTask.runPromise(program);
  strictEqual(total, 15);
  return releasedOrder;
};

const runEffectScopedResources = async (): Promise<readonly number[]> => {
  const releasedOrder: number[] = [];
  const program = Effect.scoped(
    Effect.gen(function* () {
      let sum = 0;
      for (const id of RESOURCE_IDS) {
        const resource = yield* acquireEffectResource(id, releasedOrder);
        sum += resource;
      }
      return sum;
    }),
  );
  const total = await Effect.runPromise(program);
  strictEqual(total, 15);
  return releasedOrder;
};

const resultarNever: ResultTask<never, never> = ResultTask.tryPromise({
  try: () => new Promise<never>(() => undefined),
  catch: (): never => {
    throw new Error("unreachable");
  },
  interruption: "detach",
});

const makeResultarInterruptChild = (
  id: number,
  onReady: () => void,
  onRelease: (releasedId: number) => void,
): ResultTask<never, never> =>
  ResultTask.scoped(
    ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          onReady();
          return id;
        }),
        release: () =>
          ResultTask.sync(() => {
            onRelease(id);
          }),
      });
      return yield* resultarNever;
    }),
  );

const makeEffectInterruptChild = (
  id: number,
  onReady: () => void,
  onRelease: (releasedId: number) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          onReady();
          return id;
        }),
        () =>
          Effect.sync(() => {
            onRelease(id);
          }),
      );
      return yield* Effect.never;
    }),
  );

const runResultarTreeInterrupt = async (): Promise<number> => {
  let releasedCount = 0;
  let readyCount = 0;
  let notifyAllReady: (() => void) | undefined;
  const allReady = new Promise<void>((resolve) => {
    notifyAllReady = resolve;
  });

  const markReady = (): void => {
    readyCount += 1;
    if (readyCount === INTERRUPT_CHILDREN.length) {
      notifyAllReady?.();
    }
  };

  const markReleased = (): void => {
    releasedCount += 1;
  };

  const parentTask = ResultTask.scoped(
    ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => 0),
        release: () => ResultTask.sync(markReleased),
      });
      for (const id of INTERRUPT_CHILDREN) {
        yield* ResultTask.forkChild(makeResultarInterruptChild(id, markReady, markReleased));
      }
      return yield* resultarNever;
    }),
  );

  const program = ResultTask.gen(function* () {
    const parentFiber = yield* ResultTask.forkChild(parentTask);
    yield* ResultTask.tryPromise({
      try: () => allReady,
      catch: String,
    });
    yield* ResultarFiber.interrupt(parentFiber);
    return releasedCount;
  });

  return ResultTask.runPromise(program);
};

const runEffectTreeInterrupt = async (): Promise<number> => {
  let releasedCount = 0;
  let readyCount = 0;
  let notifyAllReady: (() => void) | undefined;
  const allReady = new Promise<void>((resolve) => {
    notifyAllReady = resolve;
  });

  const markReady = (): void => {
    readyCount += 1;
    if (readyCount === INTERRUPT_CHILDREN.length) {
      notifyAllReady?.();
    }
  };

  const markReleased = (): void => {
    releasedCount += 1;
  };

  const parentEffect = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => 0),
        () => Effect.sync(markReleased),
      );
      for (const id of INTERRUPT_CHILDREN) {
        yield* Effect.forkChild(makeEffectInterruptChild(id, markReady, markReleased));
      }
      return yield* Effect.never;
    }),
  );

  const program = Effect.gen(function* () {
    const parentFiber = yield* Effect.forkChild(parentEffect);
    yield* Effect.promise(() => allReady);
    yield* EffectFiber.interrupt(parentFiber);
    return releasedCount;
  });

  return Effect.runPromise(program);
};

const assertBenchmarkBehavior = async (): Promise<void> => {
  strictEqual(await ResultTask.runPromise(buildResultarChain()), CHAIN_STEPS);
  strictEqual(await Effect.runPromise(buildEffectChain()), CHAIN_STEPS);

  strictEqual(await ResultTask.runPromise(resultarGenProgram(10)), 49);
  strictEqual(await Effect.runPromise(effectGenProgram(10)), 49);

  strictEqual(await runResultarCatchTag(), 7);
  strictEqual(await runEffectCatchTag(), 7);

  const resultarFanout = await runResultarFanout();
  const effectFanout = await runEffectFanout();
  strictEqual(resultarFanout.length, FANOUT_COUNT);
  deepStrictEqual(resultarFanout, effectFanout);

  const resultarBounded = await runResultarForEachBounded();
  const effectBounded = await runEffectForEachBounded();
  deepStrictEqual(resultarBounded, effectBounded);

  const resultarSem = await runResultarSemaphore();
  const effectSem = await runEffectSemaphore();
  deepStrictEqual(resultarSem, effectSem);

  const resultarReleased = await runResultarScopedResources();
  const effectReleased = await runEffectScopedResources();
  deepStrictEqual(resultarReleased, [5, 4, 3, 2, 1]);
  deepStrictEqual(effectReleased, [5, 4, 3, 2, 1]);

  strictEqual(await runResultarTreeInterrupt(), INTERRUPT_CHILDREN.length + 1);
  strictEqual(await runEffectTreeInterrupt(), INTERRUPT_CHILDREN.length + 1);

  strictEqual(runResultSyncChain(), CHAIN_STEPS);
  strictEqual(Effect.runSync(buildEffectChain()), CHAIN_STEPS);

  strictEqual(runResultSyncGen(10), 49);
  strictEqual(Effect.runSync(effectGenProgram(10)), 49);
};

const tests: Tests = {
  async "1. flatMap chain (50 steps)/effect-v4"() {
    consume(await Effect.runPromise(buildEffectChain()));
  },
  async "1. flatMap chain (50 steps)/resultar"() {
    consume(await ResultTask.runPromise(buildResultarChain()));
  },

  async "2. generator fn (5 yields)/effect-v4"() {
    consume(await Effect.runPromise(effectGenProgram(10)));
  },
  async "2. generator fn (5 yields)/resultar"() {
    consume(await ResultTask.runPromise(resultarGenProgram(10)));
  },

  async "3. TaggedError + catchTag/effect-v4"() {
    consume(await runEffectCatchTag());
  },
  async "3. TaggedError + catchTag/resultar"() {
    consume(await runResultarCatchTag());
  },

  async "4. fiber fork + joinAll (100 fibers)/effect-v4"() {
    consume(await runEffectFanout());
  },
  async "4. fiber fork + joinAll (100 fibers)/resultar"() {
    consume(await runResultarFanout());
  },

  async "5. forEach bounded (60 items, concurrency=8)/effect-v4"() {
    consume(await runEffectForEachBounded());
  },
  async "5. forEach bounded (60 items, concurrency=8)/resultar"() {
    consume(await runResultarForEachBounded());
  },

  async "6. semaphore contention (40 tasks, 4 permits)/effect-v4"() {
    consume(await runEffectSemaphore());
  },
  async "6. semaphore contention (40 tasks, 4 permits)/resultar"() {
    consume(await runResultarSemaphore());
  },

  async "7. scoped acquireRelease LIFO (5 resources)/effect-v4"() {
    consume(await runEffectScopedResources());
  },
  async "7. scoped acquireRelease LIFO (5 resources)/resultar"() {
    consume(await runResultarScopedResources());
  },

  async "8. fiber tree interrupt + cleanup (1 parent + 8 children)/effect-v4"() {
    consume(await runEffectTreeInterrupt());
  },
  async "8. fiber tree interrupt + cleanup (1 parent + 8 children)/resultar"() {
    consume(await runResultarTreeInterrupt());
  },

  "9. sync pipeline (50 steps)/effect-v4"() {
    consume(Effect.runSync(buildEffectChain()));
  },
  "9. sync pipeline (50 steps)/resultar"() {
    consume(runResultSyncChain());
  },

  "10. sync generator (5 yields)/effect-v4"() {
    consume(Effect.runSync(effectGenProgram(10)));
  },
  "10. sync generator (5 yields)/resultar"() {
    consume(runResultSyncGen(10));
  },
};

const selectTests = (allTests: Tests): Tests => {
  const filter = process.env.BENCH_FILTER;

  if (!filter) {
    return allTests;
  }

  const selected = Object.fromEntries(
    Object.entries(allTests).filter(([name]) => name.includes(filter)),
  ) as Tests;

  if (Object.keys(selected).length === 0) {
    throw new Error(`No benchmark tests matched BENCH_FILTER=${filter}`);
  }

  return selected;
};

const parseIterations = (): number => {
  const rawIterations = process.env.BENCH_ITERATIONS;

  if (!rawIterations) {
    return 1_500;
  }

  const iterations = Number.parseInt(rawIterations, 10);

  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error(`Invalid BENCH_ITERATIONS=${rawIterations}`);
  }

  return iterations;
};

const printComparisonSummary = (results: Results): void => {
  const scenarios = new Map<string, { effectMeanNs?: number; resultarMeanNs?: number }>();

  for (const [key, stats] of Object.entries(results)) {
    const slashIndex = key.lastIndexOf("/");
    if (slashIndex === -1) {
      continue;
    }
    const scenario = key.slice(0, slashIndex);
    const target = key.slice(slashIndex + 1);
    const entry = scenarios.get(scenario) ?? {};
    if (target === "effect-v4") {
      entry.effectMeanNs = stats.mean;
    } else if (target === "resultar") {
      entry.resultarMeanNs = stats.mean;
    }
    scenarios.set(scenario, entry);
  }

  console.log("\n=== Resultar vs Effect v4 (4.0.5) Summary ===");
  for (const [scenario, entry] of scenarios.entries()) {
    if (entry.effectMeanNs === undefined || entry.resultarMeanNs === undefined) {
      continue;
    }
    const effectHz = 1e9 / entry.effectMeanNs;
    const resultarHz = 1e9 / entry.resultarMeanNs;
    const ratio = resultarHz / effectHz;
    const effectOps = Math.round(effectHz).toLocaleString("en-US");
    const resultarOps = Math.round(resultarHz).toLocaleString("en-US");
    const effectUs = (entry.effectMeanNs / 1_000).toFixed(2);
    const resultarUs = (entry.resultarMeanNs / 1_000).toFixed(2);
    console.log(
      `- ${scenario}: resultar ${resultarOps} op/s (${resultarUs} µs) vs effect-v4 ${effectOps} op/s (${effectUs} µs) [ratio: ${ratio.toFixed(2)}x]`,
    );
  }
};

await assertBenchmarkBehavior();

cronometro(
  selectTests(tests),
  {
    iterations: parseIterations(),
    print: { colors: process.env.BENCH_COLORS === "1" },
    setup: {
      single(callback) {
        callback();
      },
    },
    warmup: true,
  },
  (error, results) => {
    if (error) {
      throw error;
    }

    printComparisonSummary(results);
    void sink;
  },
);
