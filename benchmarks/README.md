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

# TypeBox Compile(schema) JIT vs Value.Check and requestJsonTypeBoxTask end-to-end
pnpm --filter resultar-benchmarks run bench:typebox

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

Compares `Resultar` (`Result`, `ResultTask`, `Fiber`, `Semaphore`, `createTaggedError`) against `Effect` v4 across 10 equivalent workflows using [`cronometro`](https://github.com/ShogunPanda/cronometro) (1,500 samples per scenario).

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

| Scenario | Pre-RFC (`5629d83`) | `RESULTAR_JIT=0` (`op/s`) | `RESULTAR_JIT=1` (`op/s`) | Speedup |
| :--- | ---: | ---: | ---: | :--- |
| `Match` 8-tag `tagsExhaustive` | `61,638,186 op/s` | `113,801,777 op/s` | **`252,847,186 op/s`** | **4.10x** vs `5629d83` / **2.22x** vs `JIT=0` (`1.72x` time of inline `switch`) |
| `Match` nested object + array + built-in guards | `17,488,632 op/s` | `18,553,306 op/s` | **`263,412,087 op/s`** | **15.06x** vs `5629d83` / **14.20x** vs `JIT=0` |
| `createTaggedError` 3-var template (incl. `Error` stack capture) | `559,915 op/s` | `852,480 op/s` | **`861,320 op/s`** | **1.54x** vs `5629d83` / **1.01x** vs `JIT=0` |

### `resultar-task-hot.ts` (`bench:task-hot`)

| Reused Chain Scenario (100,000 runs) | `Resultar` (`JIT=1`) | `Resultar` (`JIT=0`) | `Effect` v4 | vs `JIT=0` / vs `Effect` |
| :--- | ---: | ---: | ---: | ---: |
| 10-step `map + andThen` | `19,712,361 op/s` | `7,967,281 op/s` | `3,181,615 op/s` | **2.47x** / **6.20x** |
| 50-step `map + andThen` | `4,697,418 op/s` | `2,154,832 op/s` | `897,522 op/s` | **2.18x** / **5.23x** |
| `catchTag + mapErr` recovery | `22,638,945 op/s` | `8,440,124 op/s` | `3,418,458 op/s` | **2.68x** / **6.62x** |

### `resultar-di-http.ts` (`bench:di-http`)

Each scenario and `RESULTAR_JIT` mode executes in an isolated Node process from app creation through sampling (`20,000 reqs × 7 samples` after `4,000` warmup, full `await res.text()` body consumption, `hono@4.13.19`):

| HTTP Request Scenario (body consumed) | Base `5629d83` | `JIT=0` | `JIT=1` | Speedup / Overhead vs Raw Hono |
| :--- | ---: | ---: | ---: | :--- |
| Raw `Hono` (no DI) | — | — | `422,459 req/s` (`2.37 µs`) | Baseline |
| `resultar-di` Tier 0 (singleton) + Hono middleware | `65,497 req/s` (`15.27 µs`) | `264,272 req/s` (`3.78 µs`) | **`272,457 req/s`** (`3.67 µs`) | **4.16x** end-to-end (**+1.30 µs** over raw Hono; DI overhead **9.92x** lower) |
| `resultar-di` Tier 1 (scoped+transient+locals) + Hono middleware | `41,018 req/s` (`24.38 µs`) | `228,209 req/s` (`4.38 µs`) | **`235,191 req/s`** (`4.25 µs`) | **5.73x** end-to-end (**+1.88 µs** over raw Hono; DI overhead **11.71x** lower) |
| `resultar-di` Tier 2 (scoped resource) + Hono middleware | — | — | `58,388 req/s` (`17.13 µs`) | Full `TaskScope` + streaming cleanup |
| `resultar-di` Tier 0 (singleton) + `createHonoApp` | `86,084 req/s` (`11.62 µs`) | — | **`411,014 req/s`** (`2.43 µs`) | **4.77x** end-to-end (**+0.07 µs** over raw Hono) |
| `resultar-di` Tier 1 (scoped+transient) + `createHonoApp` | `46,461 req/s` (`21.52 µs`) | — | **`426,647 req/s`** (`2.34 µs`) | **9.18x** end-to-end (**~0 µs** over raw Hono) |
| `resultar-di` direct 8-service Tier 1 `root.fetch` | `28,951 req/s` (`34.54 µs`) | `379,000 req/s` (`2.64 µs`) | **`444,781 req/s`** (`2.25 µs`) | **15.36x** vs `5629d83` / **1.17x** vs `JIT=0` |

### `resultar-fastify-http.ts` (`bench:fastify-http`)

Real TCP loopback HTTP keep-alive (`concurrency = 16`, 10,000 reqs × 5 samples, median after warmup):

| Fastify HTTP Scenario | Before (`startSession`) | After (Tier 0 / Tier 1 Fast Hooks) | Speedup / DI Overhead |
| :--- | ---: | ---: | :--- |
| Raw `Fastify` (no DI) | `45,306 req/s` (`22.07 µs`) | `46,625 req/s` (`21.45 µs`) | Baseline |
| `resultar-fastify` Tier 0 (singleton) | `25,571 req/s` (`39.11 µs`) | **`44,419 req/s`** (`22.51 µs`) | **1.74x** (**95.3%** of raw Fastify; DI overhead `+17.04 µs` → **`+1.06 µs`**, **16.1x** lower) |
| `resultar-fastify` Tier 1 (scoped + transient + locals) | `20,846 req/s` (`47.97 µs`) | **`44,472 req/s`** (`22.49 µs`) | **2.13x** (**95.4%** of raw Fastify; DI overhead `+25.90 µs` → **`+1.04 µs`**, **24.9x** lower) |
| `resultar-fastify` Tier 1 deep (8-service scoped DAG) | `16,641 req/s` (`60.09 µs`) | **`43,929 req/s`** (`22.76 µs`) | **2.64x** (**94.2%** of raw Fastify; DI overhead `+38.02 µs` → **`+1.31 µs`**, **29.0x** lower) |
| `resultar-fastify` Tier 2 (scoped resource `acquire`/`release`) | `22,766 req/s` (`43.93 µs`) | `23,482 req/s` (`42.59 µs`) | Full `TaskScope` resource ownership & rollback |

### `resultar-nestjs-http.ts` (`bench:nestjs-http`)

Real TCP loopback HTTP keep-alive on `@nestjs/platform-fastify` (`concurrency = 16`, 10,000 reqs × 5 samples, median after warmup):

| NestJS HTTP Scenario | Before (`startSession`) | After (Tier 0 / Tier 1 Fast Dispatcher) | Speedup / DI Overhead |
| :--- | ---: | ---: | :--- |
| Raw `NestJS` + `FastifyAdapter` (no DI) | `42,858 req/s` (`23.33 µs`) | `44,694 req/s` (`22.37 µs`) | Baseline |
| `resultar-nestjs` Tier 0 (singleton, `interceptor`) | `24,141 req/s` (`41.42 µs`) | **`37,505 req/s`** (`26.66 µs`) | **1.55x** (**84.3%** of raw NestJS; ~95% of NestJS's no-op interceptor ceiling) |
| `resultar-nestjs` Tier 1 (scoped + transient + locals, `interceptor`) | `18,309 req/s` (`54.62 µs`) | **`36,636 req/s`** (`27.30 µs`) | **2.00x** (**82.0%** of raw NestJS; DI overhead `+31.29 µs` → **`+4.93 µs`**, **6.3x** lower) |
| `resultar-nestjs` Tier 1 deep (8-service scoped DAG, `interceptor`) | `14,872 req/s` (`67.24 µs`) | **`37,290 req/s`** (`26.82 µs`) | **2.51x** (**83.4%** of raw NestJS; DI overhead `+43.91 µs` → **`+4.45 µs`**, **9.9x** lower) |
| `resultar-nestjs` Tier 0 (`requestHook: "guard"`, skips RxJS) | — | **`41,167 req/s`** (`24.29 µs`) | **92.1%** of raw NestJS (**+1.92 µs** total overhead) |
| `resultar-nestjs` Tier 2 (scoped resource `acquire`/`release`) | `20,160 req/s` (`49.60 µs`) | `21,720 req/s` (`46.04 µs`) | Full `TaskScope` resource ownership & rollback |

### `resultar-typebox.ts` (`bench:typebox`)

| Validation Scenario | `JIT=1` (`Compile`) | `JIT=0` (`Value.Check`) | Speedup |
| :--- | ---: | ---: | ---: |
| Direct schema check (nested object + union array) | `108,144,141 op/s` | `160,721 op/s` | **672.87x** |
| `requestJsonTypeBoxTask` end-to-end (`Response` + JSON + validate) | `375,337 op/s` | `107,641 op/s` | **3.49x** |

---

## `resultar-check-native.ts` (`bench:check-native`)

Measures the native TypeScript-Go checker using deliberately invalid source fixtures. Legacy generator cases remain in those fixtures to exercise the same diagnostic rules; they are not executable performance workloads. Its launcher and direct native executable must report matching diagnostic histograms for all 21 rules. Run `pnpm --filter resultar-check run native:build:current` first to refresh the host binary used by the launcher as well as the direct executable built by the benchmark script.
