# Resultar Benchmarks

This workspace package contains reproducible microbenchmarks for `resultar` and `resultar-check`, comparing core primitives against `neverthrow`, `effect` (v4), and previous stable releases.

## Running Benchmarks

All commands automatically build `resultar` (and `resultar-check` when needed) before running:

```sh
# ResultTask / Result vs Effect v4 (10 scenarios)
pnpm --filter resultar-benchmarks run bench:effect

# Result / ResultAsync vs neverthrow
pnpm --filter resultar-benchmarks run bench:neverthrow

# ResultTask chain construction & execution scaling (10 to 10,000 steps)
pnpm --filter resultar-benchmarks run bench:task

# Functional ergonomics (pipe, flow, Match, Result.fn)
pnpm --filter resultar-benchmarks run bench:function

# Regression comparison against the published npm version of resultar
pnpm --filter resultar-benchmarks run bench:stable

# Native TypeScript-Go resultar-check CLI throughput
pnpm --filter resultar-benchmarks run bench:check-native
```

---

## `resultar-vs-effect.ts` (`bench:effect`)

Compares `Resultar` (`Result`, `ResultTask`, `Fiber`, `Semaphore`, `createTaggedError`) against `Effect` v4 (`effect@^4.0.5`) across 10 equivalent workflows using [`cronometro`](https://github.com/ShogunPanda/cronometro) (1,500 samples per scenario).

### Scenarios & Order-of-Magnitude Profile

| # | Scenario | What it exercises | Typical Ratio (`resultar` vs `effect-v4`) |
| :- | :--- | :--- | :--- |
| 1 | `flatMap chain (50 steps)` | 50 chained `.andThen` / `Effect.flatMap` transformations | **~1.6x – 1.9x faster** |
| 2 | `generator fn (5 yields)` | `ResultTask.fn` vs `Effect.fn` yielding 5 steps | **~4.0x – 5.8x faster** |
| 3 | `TaggedError + catchTag` | Constructing a tagged error, failing, and recovering via `catchTag` | **~0.9x – 1.0x (parity)** |
| 4 | `fiber fork + joinAll (100 fibers)` | Spawning 100 scoped child fibers and joining all results | **~1.3x – 2.5x faster** |
| 5 | `forEach bounded (60 items, concurrency=8)` | Bounded concurrent mapping over 60 async items | **~1.1x – 1.3x faster** |
| 6 | `semaphore contention (40 tasks, 4 permits)` | 40 concurrent tasks competing for 4 semaphore permits | **~2.5x – 2.8x faster** |
| 7 | `scoped acquireRelease LIFO (5 resources)` | Acquiring 5 resources and running LIFO release finalizers on scope exit | **~2.7x – 3.1x faster** |
| 8 | `fiber tree interrupt + cleanup (1 parent + 8 children)` | Interrupting a parent fiber and awaiting 8 child finalizers | **~2.3x – 2.7x faster** |
| 9 | `sync pipeline (50 steps)` | 50-step synchronous `Result` pipeline vs synchronous `Effect` pipeline | **~2.5x – 8.0x faster** |
| 10 | `sync generator (5 yields)` | `Result.gen` (sync generator) vs `Effect.gen` (`runSync`) | **~4.2x – 5.8x faster** |

### Why These Differences Exist (Architectural Context)

1. **Sync-first instruction loop & single-element pooling**:
   - `ResultTask.runTaskLoop` and `ResultTask.gen` / `Result.gen` execute synchronous steps in a tight `while` loop without scheduling microtasks until a real `Promise` or cooperative `yieldEvery` checkpoint is encountered.
   - Unscoped runs (`scope.isClean()`) and generator steps reuse internal singletons (`sharedSuccessExit`, `idleTaskIterator`, `idleRunContext`), avoiding per-step heap allocations on the happy path.
2. **Opt-in cooperative scheduling vs full fiber runtime**:
   - `Effect` runs a full fiber runtime by default (fiber supervision trees, fiber refs, execution metrics, and default cooperative yielding).
   - `Resultar` keeps cooperative yielding (`yieldEvery` / `TaskScheduler`), `TaskScope` finalizer stacks, and `AbortSignal` wiring lazy/opt-in so requirement-free and synchronous paths pay near-zero runtime overhead.
3. **Methodology & caveats**:
   - Microbenchmarks amplify sub-microsecond allocation and JIT inlining differences. In real-world services, network and disk I/O dominate total latency.
   - Always run `pnpm --filter resultar-benchmarks run bench:effect` on your target Node.js version and hardware rather than relying on static `op/sec` snapshots.
