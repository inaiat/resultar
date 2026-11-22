# Resultar Benchmarks

This workspace package contains reproducible microbenchmarks for `resultar` and `resultar-check`, comparing core primitives against `neverthrow`, `effect` (v4), and previous stable releases.

The [2026-11-22 full benchmark report](results/2026-11-22.md) covers all 12 suites, including the published v4.1.1 baseline and the JIT comparisons.

Local asynchronous scenarios use `ResultTask` with explicit `runResult` (returning native `Promise<Result>`) or `runPromise` execution. Synchronous `Result` scenarios remain separate. Promise-returning steps use `tryPromise` and `andThen`; `map` stays synchronous.

The [v5 versus published v4](#v5-versus-published-v4) suite compares the same runners in both versions, checks the eager compatibility entry, and measures representative migrations from `ResultAsync` to `ResultTask`.

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

# Reused ResultTask tiered JIT chains vs JIT=0 fallback vs Effect v4
pnpm --filter resultar-benchmarks run bench:task-hot

# Match & createTaggedError JIT compilation vs fallback vs manual switch
pnpm --filter resultar-benchmarks run bench:match

# resultar-di + resultar-hono HTTP tiers (Tier 0/1/2) vs raw Hono
pnpm --filter resultar-benchmarks run bench:di-http

# resultar-fastify HTTP tiers (Tier 0/1/2) vs raw Fastify (loopback keep-alive c=16)
pnpm --filter resultar-benchmarks run bench:fastify-http

# resultar-nestjs (FastifyAdapter) HTTP tiers (Tier 0/1/2 + guard) vs raw NestJS (keep-alive c=16)
pnpm --filter resultar-benchmarks run bench:nestjs-http

# TypeBox Compile(schema) JIT vs Value.Check and requestJsonTypeBox end-to-end
pnpm --filter resultar-benchmarks run bench:typebox

# Functional ergonomics (pipe, flow, ResultTask.fn)
pnpm --filter resultar-benchmarks run bench:function
# (also available via: pnpm --filter resultar run bench:function)

# Local workspace vs the latest published 4.x (override with RESULTAR_STABLE_SPEC)
pnpm --filter resultar-benchmarks run bench:stable

# Native TypeScript-Go resultar-check CLI throughput
pnpm --filter resultar-benchmarks run bench:check-native
```

---

## `resultar-vs-effect.ts` (`bench:effect`)

Compares `Resultar` (`Result`, `ResultTask`, `Fiber`, `Semaphore`, `createTaggedError`) against `Effect` v4 across 10 equivalent workflows using [`cronometro`](https://github.com/ShogunPanda/cronometro) (1,500 samples per scenario).

### Scenarios & Reference Measurements (Node.js v24, Apple Silicon)

| #   | Scenario                                                 | What it exercises                                                       |   `resultar` (`op/s` / mean) |   `effect` (`op/s` / mean) | Ratio (`resultar / effect`) |
| :-- | :------------------------------------------------------- | :---------------------------------------------------------------------- | ---------------------------: | -------------------------: | --------------------------: |
| 1   | `flatMap chain (50 steps)`                               | 50 chained `.andThen` / `Effect.flatMap` transformations                |   `884,525 op/s` (`1.13 µs`) | `330,942 op/s` (`3.02 µs`) |            **2.67x faster** |
| 2   | `generator fn (5 yields)`                                | `ResultTask.fn` vs `Effect.fnUntraced` yielding 5 steps                 | `1,933,456 op/s` (`0.52 µs`) | `451,825 op/s` (`2.21 µs`) |            **4.28x faster** |
| 3   | `TaggedError + catchTag`                                 | Constructing a tagged error, failing, and recovering via `catchTag`     |   `229,170 op/s` (`4.36 µs`) | `245,382 op/s` (`4.08 µs`) |          **0.93x (parity)** |
| 4   | `fiber fork + joinAll (100 fibers)`                      | Spawning 100 scoped child fibers and joining all results                |   `18,355 op/s` (`54.48 µs`) | `14,185 op/s` (`70.50 µs`) |            **1.29x faster** |
| 5   | `forEach bounded (60 items, concurrency=8)`              | Bounded concurrent mapping over 60 async items                          |   `60,146 op/s` (`16.63 µs`) | `18,874 op/s` (`52.98 µs`) |            **3.19x faster** |
| 6   | `semaphore contention (40 tasks, 4 permits)`             | 40 concurrent tasks competing for 4 semaphore permits                   |   `46,648 op/s` (`21.44 µs`) | `15,940 op/s` (`62.73 µs`) |            **2.93x faster** |
| 7   | `scoped acquireRelease LIFO (5 resources)`               | Acquiring 5 resources and running LIFO release finalizers on scope exit |   `431,747 op/s` (`2.32 µs`) | `154,643 op/s` (`6.47 µs`) |            **2.79x faster** |
| 8   | `fiber tree interrupt + cleanup (1 parent + 8 children)` | Interrupting a parent fiber and awaiting 8 child finalizers             |   `42,512 op/s` (`23.52 µs`) | `20,297 op/s` (`49.27 µs`) |            **2.09x faster** |
| 9   | `sync pipeline (50 steps)`                               | 50-step synchronous `Result` pipeline vs synchronous `Effect` pipeline  |   `664,804 op/s` (`1.50 µs`) | `357,950 op/s` (`2.79 µs`) |            **1.86x faster** |
| 10  | `sync generator (5 yields)`                              | `Result.gen` vs `Effect.gen` with synchronous execution                 | `2,092,409 op/s` (`0.48 µs`) | `318,654 op/s` (`3.14 µs`) |            **6.57x faster** |

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

| Scenario                          | `resultar` (`op/s`) | `neverthrow` (`op/s`) | Ratio (`resultar / neverthrow`) |
| :-------------------------------- | ------------------: | --------------------: | ------------------------------: |
| `result-task / map on Ok`         |    `3,613,128 op/s` |      `1,123,772 op/s` |                **3.21x faster** |
| `result-task / map on Err`        |    `3,589,779 op/s` |      `1,222,193 op/s` |                **2.94x faster** |
| `result-task / orElse on Err`     |    `3,486,331 op/s` |      `1,150,491 op/s` |                **3.03x faster** |
| `result-task / promise try on Ok` |    `2,102,458 op/s` |      `1,131,806 op/s` |                **1.86x faster** |
| `result-task / andThen on Ok`     |    `3,925,530 op/s` |      `3,465,157 op/s` |                **1.13x faster** |
| `sync / combine all Ok`           |   `20,247,534 op/s` |     `15,896,294 op/s` |                **1.27x faster** |
| `sync / safeTry + gen on Ok`      |   `15,274,807 op/s` |     `15,074,072 op/s` |              **1.01x (parity)** |

---

## v5 versus published v4

On 2026-11-22, `bench:stable` compared a local build of the RFC 0012 implementation (working tree based on `8cd6a0c`, package manifest still at `4.1.1`) with the npm tarball for [`resultar@4.1.1`](https://www.npmjs.com/package/resultar/v/4.1.1), the latest published 4.x on that date. The default baseline is `resultar@4`. Run the following command from the workspace root to repeat the measurement.

```sh
for jit in 1 0 0 1 1 0; do
  RESULTAR_STABLE_SPEC=resultar@4.1.1 RESULTAR_JIT="$jit" BENCH_ROUNDS=9 \
    BENCH_SYNC_ITERATIONS=400000 BENCH_ASYNC_ITERATIONS=30000 pnpm run bench:stable
done
```

The suite ran on an Apple M4 (arm64) with macOS 27.2.1 and Node.js 26.13.1 (V8 14.6.202.34). Six sequential processes ran the complete suite, three per JIT setting in the order shown above. Each process used the same Resultar JIT setting for both builds and alternated their measurement order across nine rounds per scenario. V8 used its default settings throughout. Each timed batch followed 1,000 synchronous or 100 asynchronous warmup operations. Async cases checked the expected result before timing and awaited each operation to completion. Throughput is in operations per second. Each column is the median of the three process medians for that setting. Each change compares v5 with v4.1.1 under the same JIT setting and is calculated as `(v5 / v4.1.1 − 1) × 100`, with positive values indicating higher throughput.

### Task execution and eager compatibility

The `task/` rows call the same public methods in both versions. Calling `runResult()` returns an eager `ResultAsync` in v4 and a native Promise in v5. Reused Tasks are built before timing and executed anew for every operation. The Promise factory returns a fresh `Promise.resolve(10)` per execution. The `runPromise()` control unwraps the success value in both builds. The `eager/` row imports `okAsync` from the v4 root and the v5 `resultar/async` entry.

| Scenario                                  |  v4 JIT on |  v5 JIT on | Change on | v4 JIT off | v5 JIT off | Change off |
| :---------------------------------------- | ---------: | ---------: | --------: | ---------: | ---------: | ---------: |
| `task/build Ok + runResult`               |  9,228,046 | 20,622,695 |   +123.5% |  9,292,961 | 20,667,676 |    +122.4% |
| `task/reused Ok runResult`                |  9,303,529 | 21,830,740 |   +134.7% |  9,332,830 | 21,441,329 |    +129.7% |
| `task/reused Err runResult`               |  9,210,814 | 21,390,374 |   +132.2% |  8,919,501 | 20,508,740 |    +129.9% |
| `task/reused Promise factory runResult`   |  4,817,987 |  6,737,157 |    +39.8% |  4,840,857 |  6,680,275 |     +38.0% |
| `task/reused Ok runPromise`               | 25,207,436 | 33,717,336 |    +33.8% | 25,383,395 | 35,233,682 |     +38.8% |
| `task/build all array all Ok + runResult` |    987,435 |  1,247,682 |    +26.4% |    988,686 |  1,255,403 |     +27.0% |
| `eager/map on Ok`                         |  4,939,695 |  4,898,559 |     -0.8% |  4,895,128 |  5,101,499 |      +4.2% |

Across individual processes, the eager `map` change ranged from -0.8% to +1.4% with JIT enabled and +1.3% to +4.3% with it disabled. These in-memory measurements cover runner overhead. Application I/O and end-to-end request latency require separate measurements.

#### Immediate success in `runPromise()`

With default run options, `ResultTask.ok(value).runPromise()` can resolve the value directly. This avoids setting up the execution context and constructing a success `Exit`. Each call still applies native Promise resolution to the value. Passing run options takes the normal runner path, including cancellation and scheduler checks.

For a focused before-and-after comparison, use the command above with `BENCH_FILTER='task/reused Ok runPromise'` and `BENCH_ASYNC_ITERATIONS=400000`. With three processes per mode and nine rounds each, the v5 throughput changes relative to published v4.1.1 were:

| Resultar JIT | Before | After |
| :----------- | -----: | ----: |
| Enabled      | -15.5% | +35.2% |
| Disabled     | -12.8% | +32.3% |

### Migrating eager workflows to Task

Each operation constructs and executes a v5 Task and awaits the equivalent eager v4 workflow. The collection cases process five immediate successes. The v5 `all` case uses unbounded concurrency, and `forEach(...).asVoid()` collects intermediate values before discarding the result. Each retry case includes construction of the v5 generator and policy, one typed failure, and one successful retry.

| Scenario                             | v4 JIT on |  v5 JIT on | Change on | v4 JIT off | v5 JIT off | Change off |
| :----------------------------------- | --------: | ---------: | --------: | ---------: | ---------: | ---------: |
| `task-vs-async/ok runResult`         | 9,165,553 | 22,445,295 |   +144.9% |  9,011,039 | 22,552,864 |    +150.3% |
| `task-vs-async/map on Ok`            | 4,966,716 | 13,444,125 |   +170.7% |  4,973,612 | 13,213,676 |    +165.7% |
| `task-vs-async/andThen on Ok`        | 5,728,881 | 19,033,009 |   +232.2% |  5,778,445 | 18,618,125 |    +222.2% |
| `task-vs-async/all array all Ok`     | 1,196,458 |  1,258,139 |     +5.2% |  1,176,309 |  1,258,754 |      +7.0% |
| `task-vs-async/forEach discard`      |   841,227 |  1,967,702 |   +133.9% |    833,694 |  1,976,985 |    +137.1% |
| `task-vs-async/retry once no hook`   | 2,293,688 |  2,764,319 |    +20.5% |  2,238,367 |  2,753,167 |     +23.0% |
| `task-vs-async/retry once with hook` | 2,001,830 |  2,675,824 |    +33.7% |  1,987,172 |  2,689,608 |     +35.3% |
| `task-vs-async/race immediate Ok`    |   751,534 |  1,249,364 |    +66.2% |    760,364 |  1,247,157 |     +64.0% |

For five immediate successes, migrating eager `ResultAsync.combine` to `ResultTask.all` measured +5.2% / +7.0% (JIT on / off). Comparing `ResultTask.all` in both versions measured +26.4% / +27.0%.

#### Does the five-item collection use the JIT?

The original 36-scenario run had `RESULTAR_JIT=1` and measured −14.6% for this migration. Each iteration creates five fresh `ResultTask.ok` leaves and one fresh `all` Task with unbounded concurrency. This executes the collection worker loop directly. The Resultar chain compiler targets reused combinator chains. The environment flag controls Resultar code generation independently of V8's own JIT.

We replaced `Array.from({ length: workerCount }, () => worker())` with a loop that pushes each worker Promise into an array. Both paths start the same number of workers and await them with `Promise.all`. The earlier focused comparison below used three fresh processes per mode before and after that change, nine rounds per process and 60,000 async operations per round. Each percentage uses the v4 eager baseline measured in the same set of runs.

| Resultar JIT | Before vs v4 eager | After vs v4 eager | v5 after (op/s) | v4 eager after (op/s) |
| :----------- | -----------------: | ----------------: | --------------: | --------------------: |
| Enabled      |             −18.3% |             +5.5% |       1,249,211 |             1,183,908 |
| Disabled     |             −11.7% |             +5.6% |       1,258,456 |             1,191,754 |

To repeat the focused comparison on the current checkout:

```sh
for jit in 1 0 0 1 1 0; do
  RESULTAR_JIT="$jit" RESULTAR_STABLE_SPEC=resultar@4.1.1 BENCH_FILTER='all array all Ok' \
    BENCH_ROUNDS=9 BENCH_ASYNC_ITERATIONS=60000 pnpm run bench:stable
done
```

### Synchronous Result operations

Across the 21 synchronous cases the changes ranged from -2.6% to +3.0% with JIT enabled and -1.8% to +1.9% with it disabled.

| Scenario                                          |   v4 JIT on |   v5 JIT on | Change on |  v4 JIT off |  v5 JIT off | Change off |
| :------------------------------------------------ | ----------: | ----------: | --------: | ----------: | ----------: | ---------: |
| `sync/ok construction`                            | 166,617,514 | 164,806,822 |     -1.1% | 167,873,256 | 167,401,910 |      -0.3% |
| `sync/err construction`                           | 166,825,985 | 167,014,614 |     +0.1% | 168,424,031 | 168,634,064 |      +0.1% |
| `sync/isOk on Ok`                                 | 270,141,041 | 270,315,932 |     +0.1% | 271,631,548 | 271,631,548 |       0.0% |
| `sync/isErr on Err`                               | 270,696,984 | 271,163,461 |     +0.2% | 271,324,402 | 271,769,963 |      +0.2% |
| `sync/map on Ok`                                  | 163,198,694 | 164,113,808 |     +0.6% | 164,659,874 | 162,728,435 |      -1.2% |
| `sync/andThen on Ok`                              | 161,249,685 | 161,637,909 |     +0.2% | 164,234,558 | 164,237,323 |       0.0% |
| `sync/match positional on Ok`                     | 260,912,162 | 260,487,385 |     -0.2% | 261,338,327 | 261,224,490 |       0.0% |
| `sync/all vs combine array all Ok`                |  68,995,257 |  68,777,754 |     -0.3% |  69,019,567 |  68,836,449 |      -0.3% |
| `sync/all vs combine iterable all Ok`             |  46,784,540 |  46,578,652 |     -0.4% |  47,010,430 |  46,921,509 |      -0.2% |
| `sync/all vs combine array with Err`              |  73,050,461 |  72,408,570 |     -0.9% |  73,393,943 |  73,167,943 |      -0.3% |
| `sync/all vs combine record all Ok`               |   9,290,442 |   9,342,738 |     +0.6% |   9,411,940 |   9,450,726 |      +0.4% |
| `sync/validateAll vs combineWithAllErrors record` |  10,503,570 |  10,531,131 |     +0.3% |  10,390,622 |  10,452,199 |      +0.6% |
| `sync/validateAll no mapper`                      |  68,014,684 |  67,940,552 |     -0.1% |  67,490,615 |  67,404,362 |      -0.1% |
| `sync/validateAll mapper`                         |   5,261,557 |   5,273,702 |     +0.2% |   5,227,198 |   5,273,850 |      +0.9% |
| `sync/firstSuccessOf after failures`              |  42,343,165 |  41,243,491 |     -2.6% |  42,167,405 |  41,412,515 |      -1.8% |
| `sync/loop collect`                               |  48,529,454 |  49,881,276 |     +2.8% |  49,452,420 |  49,622,663 |      +0.3% |
| `sync/loop discard`                               |  90,083,334 |  88,558,448 |     -1.7% |  89,705,387 |  90,877,263 |      +1.3% |
| `sync/forEach collect`                            |  62,157,242 |  64,040,986 |     +3.0% |  62,268,119 |  63,469,819 |      +1.9% |
| `sync/forEach discard`                            | 116,122,945 | 119,591,905 |     +3.0% | 119,441,599 | 118,384,034 |      -0.9% |
| `sync/when lazy true`                             | 150,305,308 | 150,096,118 |     -0.1% | 149,903,968 | 149,798,708 |      -0.1% |
| `sync/unless lazy false`                          | 149,581,639 | 149,544,338 |      0.0% | 148,237,365 | 147,270,850 |      -0.7% |

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
previous pipe (slice): median 14.38 ms (500,000 iterations)
root pipe:             median 8.57 ms (500,000 iterations)
reused flow:           median 2.29 ms (500,000 iterations)
fn construction:       median 2.44 ms (500,000 iterations)
manual gen construction: median 5.18 ms (500,000 iterations)
fn repeated execution: 1.85 ms (10,000 runs)
```

---

## JIT & Specialization Suites (RFC 0011)

Measured on Node.js v26.13.1, Apple Silicon (`darwin/arm64`), median of 5 samples after warmup. Toggle `RESULTAR_JIT=0` to benchmark the CSP/Edge fallback path directly.

### `resultar-match.ts` (`bench:match`)

| Scenario                                                         | Pre-RFC (`5629d83`) | `RESULTAR_JIT=0` (`op/s`) | `RESULTAR_JIT=1` (`op/s`) | Speedup                                                                         |
| :--------------------------------------------------------------- | ------------------: | ------------------------: | ------------------------: | :------------------------------------------------------------------------------ |
| `Match` 8-tag `tagsExhaustive`                                   |   `61,638,186 op/s` |        `113,801,777 op/s` |    **`252,847,186 op/s`** | **4.10x** vs `5629d83` / **2.22x** vs `JIT=0` (`1.72x` time of inline `switch`) |
| `Match` nested object + array + built-in guards                  |   `17,488,632 op/s` |         `18,553,306 op/s` |    **`263,412,087 op/s`** | **15.06x** vs `5629d83` / **14.20x** vs `JIT=0`                                 |
| `createTaggedError` 3-var template (incl. `Error` stack capture) |      `559,915 op/s` |            `852,480 op/s` |        **`861,320 op/s`** | **1.54x** vs `5629d83` / **1.01x** vs `JIT=0`                                   |

### `resultar-task-hot.ts` (`bench:task-hot`)

| Reused Chain Scenario (100,000 runs) | `Resultar` (`JIT=1`) | `Resultar` (`JIT=0`) |      `Effect` v4 | vs `JIT=0` / vs `Effect` |
| :----------------------------------- | -------------------: | -------------------: | ---------------: | -----------------------: |
| 10-step `map + andThen`              |    `19,712,361 op/s` |     `7,967,281 op/s` | `3,181,615 op/s` |    **2.47x** / **6.20x** |
| 50-step `map + andThen`              |     `4,697,418 op/s` |     `2,154,832 op/s` |   `897,522 op/s` |    **2.18x** / **5.23x** |
| `catchTag + mapErr` recovery         |    `22,638,945 op/s` |     `8,440,124 op/s` | `3,418,458 op/s` |    **2.68x** / **6.62x** |

### `resultar-di-http.ts` (`bench:di-http`)

Each scenario and `RESULTAR_JIT` mode executes in an isolated Node process from app creation through sampling (`20,000 reqs × 7 samples` after `4,000` warmup, full `await res.text()` body consumption, `hono@4.13.19`):

| HTTP Request Scenario (body consumed)                            |              Base `5629d83` |                     `JIT=0` |                         `JIT=1` | Speedup / Overhead vs Raw Hono                                                                                     |
| :--------------------------------------------------------------- | --------------------------: | --------------------------: | ------------------------------: | :----------------------------------------------------------------------------------------------------------------- |
| Raw `Hono` (no DI)                                               |                           — |                           — |     `427,479 req/s` (`2.34 µs`) | Baseline                                                                                                           |
| `resultar-di` Tier 0 (singleton) + Hono middleware               | `65,497 req/s` (`15.27 µs`) | `190,778 req/s` (`5.24 µs`) | **`194,082 req/s`** (`5.15 µs`) | **2.96x** end-to-end (**+2.81 µs** over raw Hono incl. stream abort lifecycle; DI+stream overhead **4.59x** lower) |
| `resultar-di` Tier 1 (scoped+transient+locals) + Hono middleware | `41,018 req/s` (`24.38 µs`) | `175,080 req/s` (`5.71 µs`) | **`178,164 req/s`** (`5.61 µs`) | **4.34x** end-to-end (**+3.27 µs** over raw Hono incl. stream abort lifecycle; DI+stream overhead **6.74x** lower) |
| `resultar-di` Tier 2 (scoped resource) + Hono middleware         |                           — |                           — |     `59,763 req/s` (`16.73 µs`) | Full `TaskScope` + streaming cleanup                                                                               |
| `resultar-di` Tier 0 (singleton) + `createHonoApp`               | `86,084 req/s` (`11.62 µs`) |                           — | **`259,013 req/s`** (`3.86 µs`) | **3.01x** end-to-end (**+1.52 µs** over raw Hono incl. stream abort lifecycle)                                     |
| `resultar-di` Tier 1 (scoped+transient) + `createHonoApp`        | `46,461 req/s` (`21.52 µs`) |                           — | **`257,345 req/s`** (`3.89 µs`) | **5.54x** end-to-end (**+1.55 µs** over raw Hono incl. stream abort lifecycle)                                     |
| `resultar-di` direct 8-service Tier 1 `root.fetch`               | `28,951 req/s` (`34.54 µs`) | `261,468 req/s` (`3.82 µs`) | **`277,612 req/s`** (`3.60 µs`) | **9.59x** vs `5629d83` / **1.06x** vs `JIT=0` (with post-delivery stream abort propagation)                        |

### `resultar-fastify-http.ts` (`bench:fastify-http`)

Real TCP loopback HTTP keep-alive (`concurrency = 16`, 10,000 reqs × 5 samples, median after warmup):

| Fastify HTTP Scenario                                           |     Before (`startSession`) | After (Tier 0 / Tier 1 Fast Hooks) | Speedup / DI Overhead                                                                           |
| :-------------------------------------------------------------- | --------------------------: | ---------------------------------: | :---------------------------------------------------------------------------------------------- |
| Raw `Fastify` (no DI)                                           | `45,306 req/s` (`22.07 µs`) |        `46,625 req/s` (`21.45 µs`) | Baseline                                                                                        |
| `resultar-fastify` Tier 0 (singleton)                           | `25,571 req/s` (`39.11 µs`) |    **`44,419 req/s`** (`22.51 µs`) | **1.74x** (**95.3%** of raw Fastify; DI overhead `+17.04 µs` → **`+1.06 µs`**, **16.1x** lower) |
| `resultar-fastify` Tier 1 (scoped + transient + locals)         | `20,846 req/s` (`47.97 µs`) |    **`44,472 req/s`** (`22.49 µs`) | **2.13x** (**95.4%** of raw Fastify; DI overhead `+25.90 µs` → **`+1.04 µs`**, **24.9x** lower) |
| `resultar-fastify` Tier 1 deep (8-service scoped DAG)           | `16,641 req/s` (`60.09 µs`) |    **`43,929 req/s`** (`22.76 µs`) | **2.64x** (**94.2%** of raw Fastify; DI overhead `+38.02 µs` → **`+1.31 µs`**, **29.0x** lower) |
| `resultar-fastify` Tier 2 (scoped resource `acquire`/`release`) | `22,766 req/s` (`43.93 µs`) |        `23,482 req/s` (`42.59 µs`) | Full `TaskScope` resource ownership & rollback                                                  |

### `resultar-nestjs-http.ts` (`bench:nestjs-http`)

Real TCP loopback HTTP keep-alive on `@nestjs/platform-fastify` (`concurrency = 16`, 10,000 reqs × 5 samples, median after warmup):

| NestJS HTTP Scenario                                                  |     Before (`startSession`) | After (Tier 0 / Tier 1 Fast Dispatcher) | Speedup / DI Overhead                                                                         |
| :-------------------------------------------------------------------- | --------------------------: | --------------------------------------: | :-------------------------------------------------------------------------------------------- |
| Raw `NestJS` + `FastifyAdapter` (no DI)                               | `42,858 req/s` (`23.33 µs`) |             `44,694 req/s` (`22.37 µs`) | Baseline                                                                                      |
| `resultar-nestjs` Tier 0 (singleton, `interceptor`)                   | `24,141 req/s` (`41.42 µs`) |         **`37,505 req/s`** (`26.66 µs`) | **1.55x** (**84.3%** of raw NestJS; ~95% of NestJS's no-op interceptor ceiling)               |
| `resultar-nestjs` Tier 1 (scoped + transient + locals, `interceptor`) | `18,309 req/s` (`54.62 µs`) |         **`36,636 req/s`** (`27.30 µs`) | **2.00x** (**82.0%** of raw NestJS; DI overhead `+31.29 µs` → **`+4.93 µs`**, **6.3x** lower) |
| `resultar-nestjs` Tier 1 deep (8-service scoped DAG, `interceptor`)   | `14,872 req/s` (`67.24 µs`) |         **`37,290 req/s`** (`26.82 µs`) | **2.51x** (**83.4%** of raw NestJS; DI overhead `+43.91 µs` → **`+4.45 µs`**, **9.9x** lower) |
| `resultar-nestjs` Tier 0 (`requestHook: "guard"`, skips RxJS)         |                           — |         **`41,167 req/s`** (`24.29 µs`) | **92.1%** of raw NestJS (**+1.92 µs** total overhead)                                         |
| `resultar-nestjs` Tier 2 (scoped resource `acquire`/`release`)        | `20,160 req/s` (`49.60 µs`) |             `21,720 req/s` (`46.04 µs`) | Full `TaskScope` resource ownership & rollback                                                |

### `resultar-typebox.ts` (`bench:typebox`)

| Validation Scenario                                                | `JIT=1` (`Compile`) | `JIT=0` (`Value.Check`) |     Speedup |
| :----------------------------------------------------------------- | ------------------: | ----------------------: | ----------: |
| Direct schema check (nested object + union array)                  |  `108,144,141 op/s` |          `160,721 op/s` | **672.87x** |
| `requestJsonTypeBoxTask` end-to-end (`Response` + JSON + validate) |      `375,337 op/s` |          `107,641 op/s` |   **3.49x** |

---

## `resultar-check-native.ts` (`bench:check-native`)

Measures the native TypeScript-Go checker using deliberately invalid source fixtures. Legacy generator cases remain in those fixtures to exercise the same diagnostic rules; they are not executable performance workloads. Its launcher and direct native executable must report matching diagnostic histograms for all 21 rules. Run `pnpm --filter resultar-check run native:build:current` first to refresh the host binary used by the launcher as well as the direct executable built by the benchmark script.
