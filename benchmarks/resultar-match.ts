import { strictEqual } from "node:assert";
import { performance } from "node:perf_hooks";
import { createTaggedError, Match } from "resultar";

type Event =
  | { readonly _tag: "Created"; readonly id: number }
  | { readonly _tag: "Updated"; readonly id: number; readonly version: number }
  | { readonly _tag: "Deleted"; readonly id: number }
  | { readonly _tag: "Archived"; readonly id: number }
  | { readonly _tag: "Restored"; readonly id: number }
  | { readonly _tag: "Published"; readonly id: number; readonly views: number }
  | { readonly _tag: "Unpublished"; readonly id: number }
  | { readonly _tag: "Flagged"; readonly id: number; readonly severity: number };

const events: readonly Event[] = [
  { _tag: "Created", id: 1 },
  { _tag: "Updated", id: 2, version: 3 },
  { _tag: "Deleted", id: 3 },
  { _tag: "Archived", id: 4 },
  { _tag: "Restored", id: 5 },
  { _tag: "Published", id: 6, views: 10 },
  { _tag: "Unpublished", id: 7 },
  { _tag: "Flagged", id: 8, severity: 2 },
];

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

const buildTagsMatcher = () =>
  Match.type<Event>().pipe(
    Match.tagsExhaustive({
      Created: (e) => e.id + 1,
      Updated: (e) => e.id + e.version,
      Deleted: (e) => e.id + 2,
      Archived: (e) => e.id + 3,
      Restored: (e) => e.id + 4,
      Published: (e) => e.id + e.views,
      Unpublished: (e) => e.id + 5,
      Flagged: (e) => e.id + e.severity,
    }),
  );

const manualSwitch = (e: Event): number => {
  switch (e._tag) {
    case "Created":
      return e.id + 1;
    case "Updated":
      return e.id + e.version;
    case "Deleted":
      return e.id + 2;
    case "Archived":
      return e.id + 3;
    case "Restored":
      return e.id + 4;
    case "Published":
      return e.id + e.views;
    case "Unpublished":
      return e.id + 5;
    case "Flagged":
      return e.id + e.severity;
  }
};

const buildNestedMatcher = () =>
  Match.type<unknown>().pipe(
    Match.when(
      { kind: "user", role: "admin", scores: [Match.number, Match.number] },
      (v) => v.scores[0] + v.scores[1],
    ),
    Match.when({ kind: "user", name: Match.nonEmptyString }, (v) => v.name.length),
    Match.when(Match.number, (n) => n * 2),
    Match.orElse(() => 0),
  );

const nestedInputs: readonly unknown[] = [
  { kind: "user", role: "admin", scores: [10, 20] },
  { kind: "user", name: "Ada" },
  42,
  { kind: "other" },
];

const jitTags = withJit(true, buildTagsMatcher);
const fallbackTags = withJit(false, buildTagsMatcher);
const jitNested = withJit(true, buildNestedMatcher);
const fallbackNested = withJit(false, buildNestedMatcher);

const JitNotFound = withJit(true, () =>
  createTaggedError({
    name: "NotFoundError",
    message: "Entity $entity with id $id not found in tenant $tenant",
  }),
);
const FallbackNotFound = withJit(false, () =>
  createTaggedError({
    name: "NotFoundError",
    message: "Entity $entity with id $id not found in tenant $tenant",
  }),
);

const iterations = 1_000_000;
const errorIterations = 100_000;
const samples = 5;

const bench = (name: string, count: number, fn: () => number): number => {
  fn();
  const times: number[] = [];
  let last = 0;
  for (let s = 0; s < samples; s += 1) {
    const start = performance.now();
    last = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(samples / 2)]!;
  const ops = Math.round((count / medianMs) * 1000);
  console.log(
    `- ${name}: ${ops.toLocaleString("en-US")} op/s (median ${medianMs.toFixed(2)} ms / ${count.toLocaleString("en-US")} ops)`,
  );
  void last;
  return ops;
};

console.log(`=== Resultar Match & TaggedError JIT Benchmark (Node ${process.version}, ${process.platform}/${process.arch}) ===\n`);

const manualOps = bench("Match 8-tag / manual switch", iterations, () => {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += manualSwitch(events[i & 7]!);
  return acc;
});
const jitTagsOps = bench("Match 8-tag / tagsExhaustive (JIT=1)", iterations, () => {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += jitTags(events[i & 7]!);
  return acc;
});
const fallbackTagsOps = bench("Match 8-tag / tagsExhaustive (JIT=0)", iterations, () => {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += fallbackTags(events[i & 7]!);
  return acc;
});
strictEqual(jitTags(events[5]!), fallbackTags(events[5]!));
console.log(
  `  -> JIT vs Fallback: ${(jitTagsOps / fallbackTagsOps).toFixed(2)}x | JIT vs manual switch: ${(jitTagsOps / manualOps).toFixed(2)}x\n`,
);

const jitNestedOps = bench("Match nested + guards (JIT=1)", iterations, () => {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += jitNested(nestedInputs[i & 3]!);
  return acc;
});
const fallbackNestedOps = bench("Match nested + guards (JIT=0)", iterations, () => {
  let acc = 0;
  for (let i = 0; i < iterations; i += 1) acc += fallbackNested(nestedInputs[i & 3]!);
  return acc;
});
strictEqual(jitNested(nestedInputs[0]!), fallbackNested(nestedInputs[0]!));
console.log(`  -> JIT vs Fallback: ${(jitNestedOps / fallbackNestedOps).toFixed(2)}x\n`);

const jitErrOps = bench("createTaggedError 3-var template (JIT=1)", errorIterations, () => {
  let acc = 0;
  for (let i = 0; i < errorIterations; i += 1) {
    const error = new JitNotFound({ entity: "User", id: i, tenant: "acme" });
    acc += error.message.length;
  }
  return acc;
});
const fallbackErrOps = bench("createTaggedError 3-var template (JIT=0)", errorIterations, () => {
  let acc = 0;
  for (let i = 0; i < errorIterations; i += 1) {
    const error = new FallbackNotFound({ entity: "User", id: i, tenant: "acme" });
    acc += error.message.length;
  }
  return acc;
});
strictEqual(
  new JitNotFound({ entity: "User", id: 1, tenant: "acme" }).message,
  new FallbackNotFound({ entity: "User", id: 1, tenant: "acme" }).message,
);
console.log(`  -> JIT vs Fallback: ${(jitErrOps / fallbackErrOps).toFixed(2)}x`);
