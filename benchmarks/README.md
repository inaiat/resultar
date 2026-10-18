# Resultar Benchmarks

This workspace package contains reproducible microbenchmarks for `resultar` and `resultar-check`, comparing core primitives against `neverthrow`, `effect` (v4), and previous stable releases.

Local asynchronous scenarios use `ResultTask` with explicit `runResult` or
`runPromise` execution. Synchronous `Result` scenarios remain separate. Promise-returning
steps use `tryPromise` and `andThen`; `map` stays synchronous.

The published-version baseline retains its original eager `ResultAsync` API because v3
does not provide `ResultTask`. Those rows compare equivalent outputs across different
execution contracts, including Task construction and execution. See the
[migration guide](../docs/migrations/v4.md) for those contracts.

## Running Benchmarks

Each command builds the packages it measures before running:

```sh
# ResultTask / Result vs Effect v4 (10 scenarios)
pnpm --filter resultar-benchmarks run bench:effect

# Result / ResultTask vs neverthrow
pnpm --filter resultar-benchmarks run bench:neverthrow

# ResultTask chain construction & execution scaling (10 to 10,000 steps)
pnpm --filter resultar-benchmarks run bench:task

# Functional ergonomics (pipe, flow, ResultTask.fn)
pnpm --filter resultar-benchmarks run bench:function

# Sync regression and Task-vs-Async comparison against the published npm version
pnpm --filter resultar-benchmarks run bench:stable

# Native TypeScript-Go resultar-check CLI throughput
pnpm --filter resultar-benchmarks run bench:check-native
```

---

## `resultar-vs-effect.ts` (`bench:effect`)

Compares `Resultar` (`Result`, `ResultTask`, `Fiber`, `Semaphore`, `createTaggedError`) against `Effect` v4 (`effect@^4.0.5`) across 10 equivalent workflows using [`cronometro`](https://github.com/ShogunPanda/cronometro) (1,500 samples per scenario).

### Scenarios

| #   | Scenario                                                 | What it exercises                                                       |
| :-- | :------------------------------------------------------- | :---------------------------------------------------------------------- |
| 1   | `flatMap chain (50 steps)`                               | 50 chained `.andThen` / `Effect.flatMap` transformations                |
| 2   | `generator fn (5 yields)`                                | `ResultTask.fn` vs `Effect.fnUntraced` yielding 5 steps                 |
| 3   | `TaggedError + catchTag`                                 | Constructing a tagged error, failing, and recovering via `catchTag`     |
| 4   | `fiber fork + joinAll (100 fibers)`                      | Spawning 100 scoped child fibers and joining all results                |
| 5   | `forEach bounded (60 items, concurrency=8)`              | Bounded concurrent mapping over 60 async items                          |
| 6   | `semaphore contention (40 tasks, 4 permits)`             | 40 concurrent tasks competing for 4 semaphore permits                   |
| 7   | `scoped acquireRelease LIFO (5 resources)`               | Acquiring 5 resources and running LIFO release finalizers on scope exit |
| 8   | `fiber tree interrupt + cleanup (1 parent + 8 children)` | Interrupting a parent fiber and awaiting 8 child finalizers             |
| 9   | `sync pipeline (50 steps)`                               | 50-step synchronous `Result` pipeline vs synchronous `Effect` pipeline  |
| 10  | `sync generator (5 yields)`                              | `Result.gen` vs `Effect.gen` with synchronous execution                 |

The Task cases use `ResultTask.runPromise`; the last two cases measure synchronous
`Result` primitives. Assertions check the computed values and resource cleanup before
measurement. Run the suite on the target Node.js version and hardware; allocation, JIT,
and garbage collection affect these microbenchmarks.

## Other suites

- `bench:neverthrow` compares synchronous `Result` primitives and explicitly executed
  `ResultTask` workloads against neverthrow's corresponding APIs. Result-to-Task bridges
  are named separately. Preflight checks cover values, failures, laziness, repeated runs,
  and skipped callbacks.
- `bench:stable` keeps synchronous regression rows and labels migrated rows
  `task-vs-async`. The local side uses `ResultTask.runResult`; the published side uses its
  original eager API. Task retries skip the timer for zero delay on the default live clock;
  custom and virtual clocks retain their `sleep(0)` behavior. Retry rows include constructing
  the Task generator and frozen policy on each operation, alongside retry execution.
  `forEach(...).asVoid()` discards the final
  Task value but still collects intermediate results internally.
- `bench:task` measures Task construction and execution at 10, 100, 1,000, and 10,000
  steps, then compares 1,000 synchronous steps with 1,000 Promise-producing steps in
  Task. Each row has one warmup and one timed run.
- `bench:function` measures root `pipe`, reused `flow`, Task `fn`/`gen` construction,
  and repeated execution through `ResultTask.runPromise`.
- `bench:check-native` measures the checker, using deliberately invalid source fixtures.
  Legacy generator cases remain in those fixtures to exercise the same diagnostic rules;
  they are not executable performance workloads. Its launcher and direct native executable
  must report matching diagnostic histograms for all 21 rules. Run
  `pnpm --filter resultar-check run native:build:current` first to refresh the host binary
  used by the launcher as well as the direct executable built by the benchmark script.
