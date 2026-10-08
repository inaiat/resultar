import { strictEqual } from "node:assert";
import { performance } from "node:perf_hooks";
import { flow, pipe, ResultTask } from "resultar";

const iterations = 500_000;
const samples = 5;
let sink = 0;
const increment = (value: number) => value + 1;
const double = (value: number) => value * 2;
const half = (value: number) => value / 2;
const transforms = [increment, double, half] as const;
const composed = flow(...transforms);

// Previous runPipe implementation, including the slice allocation.
const previousPipe = (value: number, ...functions: readonly ((value: number) => number)[]) => {
  const first = functions[0];
  if (!first) return value;
  let output = first(value);
  for (const fn of functions.slice(1)) output = fn(output);
  return output;
};

const measure = (name: string, work: () => void) => {
  work();
  const times = Array.from({ length: samples }, () => {
    const start = performance.now();
    work();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(
    `${name}: median ${times[2]!.toFixed(2)} ms (${iterations.toLocaleString()} iterations)`,
  );
};

console.log(
  `Node ${process.version}; ${process.platform}/${process.arch}; ${samples} measured samples after warmup`,
);
for (const [name, run] of [
  ["previous pipe (slice)", (value: number) => previousPipe(value, ...transforms)],
  ["root pipe", (value: number) => pipe(value, ...transforms)],
  ["reused flow", composed],
] as const) {
  measure(name, () => {
    for (let i = 0; i < iterations; i++) sink = run(i);
  });
  strictEqual(sink, iterations);
}

const generated = ResultTask.fn(function* (value: number) {
  return yield* ResultTask.succeed(value);
});
let task = generated(0);
measure("fn construction", () => {
  for (let i = 0; i < iterations; i++) task = generated(i);
});
measure("manual gen construction", () => {
  for (let i = 0; i < iterations; i++)
    task = ResultTask.gen(function* () {
      return yield* ResultTask.succeed(i);
    });
});
strictEqual(await ResultTask.runPromise(task), iterations - 1);

const repeated = generated(7);
const executions = 10_000;
for (let i = 0; i < executions; i++) strictEqual(await ResultTask.runPromise(repeated), 7);
const start = performance.now();
for (let i = 0; i < executions; i++) strictEqual(await ResultTask.runPromise(repeated), 7);
console.log(
  `fn repeated execution: ${(performance.now() - start).toFixed(2)} ms (${executions.toLocaleString()} runs)`,
);
