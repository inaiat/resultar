# Resultar Benchmarks

This workspace package contains reproducible microbenchmarks for `resultar` and `resultar-check`, comparing core primitives against `neverthrow`, `effect` (v4), and previous stable releases.

Local asynchronous scenarios use `ResultTask` with explicit `runResult` (which returns an in-flight `ResultAsync` / `PromiseLike<Result>`) or `runPromise` execution. Synchronous `Result` scenarios remain separate. Promise-returning steps use `tryPromise` and `andThen`; `map` stays synchronous.

The published-version baseline retains its original eager `ResultAsync` API because v3 does not provide `ResultTask`. Those rows compare equivalent outputs across different execution contracts, including Task construction and execution. See the [migration guide](../docs/migrations/v4.md) for those contracts.

## Running Benchmarks

Each command builds the packages it measures before running:

```sh
# ResultTask / Result vs Effect v4 (10 scenarios)
pnpm --filter resultar-benchmarks run bench:effect
# (also available via: pnpm --filter resultar run bench:effect)

# Result / ResultTask vs neverthrow
pnpm --filter resultar-benchmarks run bench:neverthrow
# (also available via: pnpm --filter resultar run bench:neverthrow)

# ResultTask chain construction & execution scaling (10 to 10,000 steps)
pnpm --filter resultar-benchmarks run bench:task
# (also available via: pnpm --filter resultar run bench:task)

# Functional ergonomics (pipe, flow, ResultTask.fn)
pnpm --filter resultar-benchmarks run bench:function
# (also available via: pnpm --filter resultar run bench:function)

# Sync regression and Task-vs-Async comparison against the published npm version
pnpm --filter resultar-benchmarks run bench:stable

# Native TypeScript-Go resultar-check CLI throughput
pnpm --filter resultar-benchmarks run bench:check-native
```

---

## `resultar-vs-effect.ts` (`bench:effect`)

Compares `Resultar` (`Result`, `ResultTask`, `Fiber`, `Semaphore`, `createTaggedError`) against `Effect` v4 (`effect@^4.0.5`) across 10 equivalent workflows using [`cronometro`](https://github.com/ShogunPanda/cronometro) (1,500 samples per scenario).

### Scenarios & Reference Measurements (Node.js v24, Apple Silicon)

| #   | Scenario                                                 | What it exercises                                                       | `resultar` (`op/s` / mean)      | `effect` (`op/s` / mean)       | Ratio (`resultar / effect`) |
| :-- | :------------------------------------------------------- | :---------------------------------------------------------------------- | ------------------------------: | -----------------------------: | --------------------------: |
| 1   | `flatMap chain (50 steps)`                               | 50 chained `.andThen` / `Effect.flatMap` transformations                | `884,525 op/s` (`1.13 µs`)      | `330,942 op/s` (`3.02 µs`)     | **2.67x faster**            |
| 2   | `generator fn (5 yields)`                                | `ResultTask.fn` vs `Effect.fnUntraced` yielding 5 steps                 | `1,933,456 op/s` (`0.52 µs`)    | `451,825 op/s` (`2.21 µs`)     | **4.28x faster**            |
| 3   | `TaggedError + catchTag`                                 | Constructing a tagged error, failing, and recovering via `catchTag`     | `229,170 op/s` (`4.36 µs`)      | `245,382 op/s` (`4.08 µs`)     | **0.93x (parity)**          |
| 4   | `fiber fork + joinAll (100 fibers)`                      | Spawning 100 scoped child fibers and joining all results                | `18,355 op/s` (`54.48 µs`)      | `14,185 op/s` (`70.50 µs`)     | **1.29x faster**            |
| 5   | `forEach bounded (60 items, concurrency=8)`              | Bounded concurrent mapping over 60 async items                          | `60,146 op/s` (`16.63 µs`)      | `18,874 op/s` (`52.98 µs`)     | **3.19x faster**            |
| 6   | `semaphore contention (40 tasks, 4 permits)`             | 40 concurrent tasks competing for 4 semaphore permits                   | `46,648 op/s` (`21.44 µs`)      | `15,940 op/s` (`62.73 µs`)     | **2.93x faster**            |
| 7   | `scoped acquireRelease LIFO (5 resources)`               | Acquiring 5 resources and running LIFO release finalizers on scope exit | `431,747 op/s` (`2.32 µs`)      | `154,643 op/s` (`6.47 µs`)     | **2.79x faster**            |
| 8   | `fiber tree interrupt + cleanup (1 parent + 8 children)` | Interrupting a parent fiber and awaiting 8 child finalizers             | `42,512 op/s` (`23.52 µs`)      | `20,297 op/s` (`49.27 µs`)     | **2.09x faster**            |
| 9   | `sync pipeline (50 steps)`                               | 50-step synchronous `Result` pipeline vs synchronous `Effect` pipeline  | `664,804 op/s` (`1.50 µs`)      | `357,950 op/s` (`2.79 µs`)     | **1.86x faster**            |
| 10  | `sync generator (5 yields)`                              | `Result.gen` vs `Effect.gen` with synchronous execution                 | `2,092,409 op/s` (`0.48 µs`)    | `318,654 op/s` (`3.14 µs`)     | **6.57x faster**            |

The Task cases use `ResultTask.runPromise`; the last two cases measure synchronous `Result` primitives. Assertions check the computed values and resource cleanup before measurement. Run the suite on the target Node.js version and hardware; allocation, JIT, and garbage collection affect these microbenchmarks.

### Why These Differences Exist (Architectural Context)

1. **Sync-first instruction loop & single-element pooling**:
   - `ResultTask.runTaskLoop` and `ResultTask.gen` / `Result.gen` execute synchronous steps in a tight `while` loop without scheduling microtasks until a real `Promise` or cooperative `yieldEvery` checkpoint is encountered.
   - Unscoped runs (`scope.isClean()`) and generator steps reuse internal singletons (`sharedSuccessExit`, `idleTaskIterator`, `idleRunContext`), avoiding per-step heap allocations on the happy path.
2. **Opt-in cooperative scheduling & bounded worker pools**:
   - `ResultTask.forEach` with bounded concurrency uses a fixed worker-loop pool rather than spawning one fiber per item.
   - Cooperative yielding (`yieldEvery` / `TaskScheduler`), `TaskScope` finalizer stacks, and `AbortSignal` wiring remain lazy/opt-in so requirement-free and synchronous paths pay near-zero runtime overhead.

---

## `resultar-vs-neverthrow.ts` (`bench:neverthrow`)

Compares synchronous `Result` primitives and explicitly executed `ResultTask` (`ResultTask.runResult`) workloads against `neverthrow` (`^8.2.0`). Result-to-Task bridges are named separately. Preflight checks cover values, failures, laziness, repeated runs, and skipped callbacks.

### Highlight Measurements (Node.js v24, Apple Silicon)

| Scenario                           | `resultar` (`op/s`) | `neverthrow` (`op/s`) | Ratio (`resultar / neverthrow`) |
| :--------------------------------- | ------------------: | --------------------: | ------------------------------: |
| `result-task / map on Ok`          | `3,613,128 op/s`    | `1,123,772 op/s`      | **3.21x faster**                |
| `result-task / map on Err`         | `3,589,779 op/s`    | `1,222,193 op/s`      | **2.94x faster**                |
| `result-task / orElse on Err`      | `3,486,331 op/s`    | `1,150,491 op/s`      | **3.03x faster**                |
| `result-task / promise try on Ok`  | `2,102,458 op/s`    | `1,131,806 op/s`      | **1.86x faster**                |
| `result-task / andThen on Ok`      | `3,925,530 op/s`    | `3,465,157 op/s`      | **1.13x faster**                |
| `sync / combine all Ok`            | `20,247,534 op/s`   | `15,896,294 op/s`     | **1.27x faster**                |
| `sync / safeTry + gen on Ok`       | `15,274,807 op/s`   | `15,074,072 op/s`     | **1.01x (parity)**              |

---

## `resultar-vs-stable.ts` (`bench:stable`)

Keeps synchronous regression rows and labels migrated rows `task-vs-async`. The local side uses `ResultTask.runResult` (returning `ResultAsync`); the published side uses its original eager `ResultAsync` API. Task retries skip the timer for zero delay on the default live clock; custom and virtual clocks retain their `sleep(0)` behavior. Retry rows include constructing the Task generator and frozen policy on each operation, alongside retry execution. `forEach(...).asVoid()` discards the final Task value while collecting intermediate results internally.

### Highlight Measurements vs Published `resultar@3.10.0` (Node.js v24, Apple Silicon)

| Scenario                              | Type    | Local (`op/s`)    | Stable (`op/s`)   | Local Delta |
| :------------------------------------ | :------ | ----------------: | ----------------: | ----------: |
| `sync/combine array with Err`         | `sync`  | `76,159,026 op/s` | `55,728,406 op/s` | **+36.7%**  |
| `sync/forEach collect`                | `sync`  | `58,900,030 op/s` | `21,165,141 op/s` | **+178.3%** |
| `sync/forEach discard`                | `sync`  | `117,583,702 op/s`| `24,531,853 op/s` | **+379.3%** |
| `task-vs-async/ok runResult`          | `async` | `7,156,055 op/s`  | `6,975,125 op/s`  | **+2.6%**   |
| `task-vs-async/map on Ok`             | `async` | `5,101,827 op/s`  | `3,422,702 op/s`  | **+49.1%**  |
| `task-vs-async/andThen on Ok`         | `async` | `6,482,629 op/s`  | `4,418,425 op/s`  | **+46.7%**  |
| `task-vs-async/forEach discard`       | `async` | `1,358,050 op/s`  | `784,058 op/s`    | **+73.2%**  |
| `task-vs-async/retry once no hook`    | `async` | `2,038,563 op/s`  | `1,869,014 op/s`  | **+9.1%**   |
| `task-vs-async/retry once with hook`  | `async` | `1,987,710 op/s`  | `1,518,853 op/s`  | **+30.9%**  |
| `task-vs-async/race immediate Ok`     | `async` | `752,941 op/s`    | `435,242 op/s`    | **+73.0%**  |

---

## `resultar-task-chains.ts` (`bench:task`)

Measures `ResultTask` construction and execution at 10, 100, 1,000, and 10,000 steps, then compares 1,000 synchronous steps with 1,000 Promise-producing steps in Task. Each row has one warmup and one timed run.

```text
1. Lazy Task Construction (without running):
- Build 10 andThen steps:     0.00ms
- Build 100 andThen steps:    0.01ms
- Build 1000 andThen steps:   0.06ms
- Build 10000 andThen steps:  0.35ms

2. Sequential Execution (ResultTask andThen chains):
- Run 10 andThen steps:       0.04ms
- Run 100 andThen steps:      0.02ms
- Run 1000 andThen steps:     0.34ms
- Run 10000 andThen steps:    3.27ms

3. Sequential Execution (ResultTask map chains):
- Run 10 maps:                0.02ms
- Run 100 maps:               0.07ms
- Run 1000 maps:              0.44ms
- Run 10000 maps:             1.11ms

4. ResultTask synchronous vs Promise-producing steps (1,000 chained andThen):
- ResultTask 1,000 synchronous andThen steps:        0.30ms
- ResultTask 1,000 Promise-producing andThen steps:  1.70ms
```

---

## `resultar-functional-ergonomics.ts` (`bench:function`)

Measures root `pipe`, reused `flow`, Task `fn`/`gen` construction, and repeated execution through `ResultTask.runPromise` (500,000 iterations for construction/pipe, 10,000 runs for repeated execution; median of 5 samples after warmup):

```text
previous pipe (slice): median 12.20 ms (500,000 iterations)
root pipe:             median 8.13 ms (500,000 iterations)
reused flow:           median 8.43 ms (500,000 iterations)
fn construction:       median 2.52 ms (500,000 iterations)
manual gen construction: median 4.03 ms (500,000 iterations)
fn repeated execution: 1.78 ms (10,000 runs)
```

---

## `resultar-check-native.ts` (`bench:check-native`)

Measures the native TypeScript-Go checker using deliberately invalid source fixtures. Legacy generator cases remain in those fixtures to exercise the same diagnostic rules; they are not executable performance workloads. Its launcher and direct native executable must report matching diagnostic histograms for all 21 rules. Run `pnpm --filter resultar-check run native:build:current` first to refresh the host binary used by the launcher as well as the direct executable built by the benchmark script.
