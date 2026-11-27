# Resultar URL shortener ABBA & runtime benchmark update · 2026-11-27

Measured sequentially on Apple M4 (`arm64`), Node.js `v26.13.1`, commit `9dd623e` (`feat/runtime-perf-di-service-and-benchmarks`), against the equalized workspace comparison apps in [`benchmarks/comparison/`](../comparison/README.md) (`url-shortener-resultar` vs `url-shortener-effect`, both using MongoDB 7, Papr, Redis 8, ioredis 6.1.0, BullMQ 6.7.9, identical validation rules, insert-time unique collision handling, 4 concurrent BullMQ worker jobs, and `error` log level).

## Equalized URL shortener ABBA benchmark

- **Protocol**: 12/12 HTTP contract preflight checks passed on both apps before timing; ABBA ordering (`resultar R1 -> effect R1 -> effect R2 -> resultar R2`); 50 concurrent keep-alive connections; 2 s warmup (`c=30`) + 8 s measurement window per endpoint; **0 errors** and **0 unexpected status codes** across all rounds.
- **Built `dist/` JS size**: `33.7 KB` (`url-shortener-resultar`) vs `33.5 KB` (`url-shortener-effect`).

### ABBA averages (2 rounds per stack)

| Endpoint / Footprint | Fastify 5 + Resultar | Effect v4 | Delta |
| :--- | ---: | ---: | ---: |
| `GET /health` | `119,129 req/s` (`p50 0.36ms · p99 1.05ms`) | `69,550 req/s` (`p50 0.67ms · p99 1.45ms`) | **1.71× (+71%)** |
| `GET /api/v1/stats?type=recent&limit=10` | `12,425 req/s` (`p50 3.91ms · p99 7.57ms`) | `9,513 req/s` (`p50 5.10ms · p99 10.99ms`) | **1.31× (+31%)** |
| `GET /api/v1/:code` (302 hit · Redis + BullMQ) | `22,407 req/s` (`p50 2.08ms · p99 4.06ms`) | `17,964 req/s` (`p50 2.64ms · p99 4.74ms`) | **1.25× (+25%)** |
| `GET /api/v1/stats?type=popular&limit=10` | `11,936 req/s` (`p50 4.04ms · p99 8.66ms`) | `9,576 req/s` (`p50 5.09ms · p99 11.56ms`) | **1.25× (+25%)** |
| `POST /api/v1` (201 create · MongoDB + Redis) | `14,351 req/s` (`p50 3.22ms · p99 8.65ms`) | `12,008 req/s` (`p50 4.03ms · p99 7.35ms`) | **1.20× (+20%)** |
| `GET /api/v1/:missing` (404 miss · Redis + MongoDB) | `13,818 req/s` (`p50 3.30ms · p99 8.95ms`) | `11,695 req/s` (`p50 3.97ms · p99 9.84ms`) | **1.18× (+18%)** |
| Startup (Phase A) / Idle RSS / Post-write RSS | `416 ms` / `137.9 MB` / `230.5 MB` | `545 ms` / `187.6 MB` / `350.1 MB` | **-24% · -26% · -34%** |

### Per-round raw measurements

| Scenario | Resultar R1 | Resultar R2 | Effect R1 | Effect R2 |
| :--- | ---: | ---: | ---: | ---: |
| `GET /health` | `120,200.5 req/s` (`p99 1.22ms`) | `118,058.0 req/s` (`p99 0.88ms`) | `69,789.8 req/s` (`p99 1.44ms`) | `69,309.5 req/s` (`p99 1.46ms`) |
| `GET /api/v1/stats` (recent) | `12,767.9 req/s` (`p99 7.63ms`) | `12,082.7 req/s` (`p99 7.50ms`) | `9,722.8 req/s` (`p99 11.01ms`) | `9,303.5 req/s` (`p99 10.96ms`) |
| `GET /api/v1/stats` (popular) | `12,063.7 req/s` (`p99 9.90ms`) | `11,809.1 req/s` (`p99 7.42ms`) | `9,486.2 req/s` (`p99 14.19ms`) | `9,666.7 req/s` (`p99 8.92ms`) |
| `GET /api/v1/:missing` (404) | `12,738.8 req/s` (`p99 11.52ms`) | `14,896.8 req/s` (`p99 6.37ms`) | `11,332.1 req/s` (`p99 12.39ms`) | `12,057.9 req/s` (`p99 7.28ms`) |
| `GET /api/v1/:code` (302 hit) | `21,825.8 req/s` (`p99 4.50ms`) | `22,988.0 req/s` (`p99 3.62ms`) | `18,005.5 req/s` (`p99 4.80ms`) | `17,922.9 req/s` (`p99 4.68ms`) |
| `POST /api/v1` (201 create) | `14,984.4 req/s` (`p99 8.98ms`) | `13,717.6 req/s` (`p99 8.32ms`) | `12,001.7 req/s` (`p99 7.29ms`) | `12,014.5 req/s` (`p99 7.40ms`) |
| Startup (Phase A) / Idle RSS | `416 ms` / `133.3 MB` | `416 ms` / `142.4 MB` | `622 ms` / `187.5 MB` | `467 ms` / `187.6 MB` |
| Post-write RSS (Phase B) | `203.4 MB` | `257.5 MB` | `331.7 MB` | `368.4 MB` |

## Core & HTTP adapter microbenchmark snapshot (`9dd623e`)

- **`bench:effect` (10/10 wins vs Effect 4.1.4)**:
  - `1. flatMap chain (50 steps)`: `357,939 op/s` vs `163,763 op/s` (**2.19×**)
  - `2. generator fn (5 yields)`: `746,678 op/s` vs `587,508 op/s` (**1.27×**)
  - `3. TaggedError + catchTag`: `432,713 op/s` vs `406,329 op/s` (**1.06×**)
  - `4. fiber fork + joinAll (100 fibers)`: `27,856 op/s` vs `15,126 op/s` (**1.84×**)
  - `5. forEach bounded (60 items, concurrency=8)`: `127,234 op/s` vs `63,218 op/s` (**2.01×**)
  - `6. semaphore contention (40 tasks, 4 permits)`: `63,730 op/s` vs `15,484 op/s` (**4.12×**)
  - `7. scoped acquireRelease LIFO (5 resources)`: `417,135 op/s` vs `143,627 op/s` (**2.90×**)
  - `8. fiber tree interrupt + cleanup (1 parent + 8 children)`: `43,161 op/s` vs `17,831 op/s` (**2.42×**)
  - `9. sync pipeline (50 steps)`: `4,522,718 op/s` vs `295,567 op/s` (**15.30×**)
  - `10. sync generator (5 yields)`: `1,262,581 op/s` vs `1,072,980 op/s` (**1.18×**)
- **`bench:task-hot`**:
  - Reused 10-step `map+andThen`: `13,238,167 op/s` (`JIT=1`) vs `1,798,908 op/s` (`JIT=0`, **7.36×**) vs `2,481,713 op/s` (Effect v4, **5.33×**)
  - Reused 50-step `map+andThen`: `3,810,782 op/s` (`JIT=1`) vs `1,338,404 op/s` (`JIT=0`, **2.85×**) vs `904,831 op/s` (Effect v4, **4.21×**)
  - Reused `catchTag+mapErr`: `16,333,531 op/s` (`JIT=1`) vs `6,662,725 op/s` (`JIT=0`, **2.45×**) vs `3,260,285 op/s` (Effect v4, **5.01×**)
- **`bench:match`**: `Match 8-tag` `249,511,332 op/s` (**2.09×** vs fallback), `Match nested + guards` `265,989,847 op/s` (**14.43×** vs fallback), `createTaggedError` `778,696 op/s`
- **`bench:fastify-http`**: Raw Fastify `46,778 req/s`, Tier 0 `40,889 req/s` (`JIT=0`: `43,729 req/s`), Tier 1 `40,223 req/s`, Deep 8-service Tier 1 `39,267 req/s` (**1.13×** vs `JIT=0`)
- **`bench:di-http`**: `createHonoApp` Tier 0 `256,689 req/s`, Tier 1 `198,741 req/s`, direct `root.fetch` 8-service Tier 1 `198,804 req/s`

For the full 12-suite baseline (including `resultar@4.1.1` and `neverthrow`), see [2026-11-22.md](2026-11-22.md).
