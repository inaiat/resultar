# resultar-request-zod

## 2.0.0

### Major Changes

- Implement RFC 0005 contract safety, HTTP cancellation/error-stage fixes, and Task-native HTTP entrypoints:

  Breaking change: `RequestJsonSource` factories now receive a required `AbortSignal`
  argument. Existing zero-argument factories remain accepted, but consumers invoking
  a narrowed `RequestJsonSource` must pass a signal. Factories with an optional first
  parameter of another type must be wrapped in a callback that ignores the signal.
  The schema adapters expose the same changed input contract. Existing HTTP APIs
  remain eager; the new Task entrypoints are lazy.

  - `resultar-check`: add `no-promise-resultar` (`noPromiseResultar`, default `"error"`) to reject native `Promise<Result<T, E>>`, `Promise<StrictResult<T, E>>`, and `Promise<ResultTask<T, E, R>>` contracts and unannotated `async` wrappers, recommending direct `ResultAsync`, `StrictResultAsync`, or `ResultTask` returns without duplicating `prefer-result-async` findings.
  - `resultar-request`, `resultar-request-zod`, `resultar-request-typebox`: propagate `AbortSignal` cancellation through `requestJson` and retries (`signal` and `(signal) => Promise<Response>` request factories), stop retry scheduling immediately on cancellation while keeping cancellations inside the declared eager error channel, classify HTTP failures at their originating stage (only JSON parse `SyntaxError` reaches `invalidJson`), safely format unserializable HTTP metadata (circular/`bigint`/throwing headers) inside `HttpResponseErrorCauseError`, and add lazy repeatable `requestJsonTask`, `requestJsonZodTask`, and `requestJsonTypeBoxTask` entrypoints backed by `ResultTask` and `TaskClock`.
  - `resultar`: refresh bundled coding-agent manuals, generated API inventory, compiled recipes, and evaluation regression cases.

### Patch Changes

- Align human and coding-agent documentation with the public v4 contracts while preserving
  existing eager and deprecated behavior. Bundle the canonical manuals, generated API inventory,
  and compiled contract recipes with the core package. Route agents to relevant references
  instead of loading every manual by default.

  Correct runner failure channels, numeric retry options, callbacks, race semantics, service
  provision, resource ownership and checker defaults. Document request error helpers and lazy
  bridging. Add CI checks for public-surface drift, recipe behavior, checker severities and
  bundled links; extend generation graders with HTTP, DI, matching, retry and Cause scenarios.

  Clarify Promise input/output roles throughout the guides: new application methods expose
  Tasks, raw driver Promises adapt directly via tryPromise, existing typed Async operations
  use fromResultAsync, and native execution boundaries retain Promises. Label negative
  checker fixtures and exercise typed repository contracts, rejection mapping and cancellation.

- Updated dependencies
- Updated dependencies
  - resultar@4.0.2
  - resultar-request@2.0.0

## 1.0.0

### Major Changes

- 37e8a0f: Prepare the next core major with plain-value Result generators and unified `ResultTask` / `ResultAsync`
  execution boundaries in `resultar`. Preserve legacy synchronous and asynchronous safeTry
  Result-returning generators, tap observation behavior and checker configuration.
  Add best-effort task observation with inspect/inspectError. Retain unrelated
  deprecated synchronous method names with equivalent replacements. Result/ResultAsync tap remains
  best-effort observation; inspect provides the same behavior under the new name.
  
  Add scope-owned child fibers, structured races and timeouts, bounded task
  collections, per-attempt scoped retries, live/virtual clocks, and parallel causes.
  Preserve eager ResultAsync and lazy, repeatable ResultTask execution.
  
  Keep new static asynchronous matching compositional while preserving legacy instance terminals,
  retain errors for optional tagged recovery handlers and preserve union-table outputs,
  add typed Match contexts, and improve finite object-pattern exhaustiveness.
  Preserve native Hono response unions and Fastify response contracts.
  
  Recognize yielded Results and task collection/fiber consumers in the checker,
  and expose Match coverage in hover. Update companion cause inspection for
  parallel failures. Preserve existing `resultar` exports and Async-producing methods; exhaustive Cause consumers
  must handle the new Parallel branch, and corrected tagged recovery types retain
  errors that optional handlers do not guarantee to recover.

### Patch Changes

- f8458ae: Make `ResultTask` the preferred asynchronous workflow API and unify `ResultAsync` as the in-flight `Result` returned by `task.runResult()` in `resultar`.
  
  - Keep tasks lazy and repeatable, with explicit `runResult`, `runExit`, `runPromise`, and `runFork` boundaries. Tasks are not thenable; `map` remains synchronous.
  - Export `ResultAsync`, `StrictResultAsync`, and eager helpers from `resultar`. Preserve shared single execution, awaited callbacks, native Promise terminals and best-effort observation.
  - Preserve Async-producing compatibility methods on Result and tagged errors, plus explicit Task bridges.
  - `Result.gen` and `Result.fn` support synchronous and eager asynchronous generators with plain returns. The retained legacy `safeTry` preserves final-Result returns in both execution modes.
  - Keep `ResultTask.fromResultAsync` as a structural bridge accepting a Result-producing thenable or signal-aware factory.
  - HTTP request and lifecycle adapters preserve their eager public behavior using `resultar`.
- Updated dependencies [37e8a0f]
- Updated dependencies [b15966d]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [40b76f2]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [bfe38b4]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [37e8a0f]
- Updated dependencies [f8458ae]
- Updated dependencies [c6aed8b]
- Updated dependencies [37e8a0f]
  - resultar@4.0.0
  - resultar-request@1.0.0

## 0.1.2

### Patch Changes

- 93b11c1: Document the JSR entrypoints and exported symbols used by Resultar and its request packages.
- b913a80: - **resultar**: Corrected `ResultAsyncRetryContext.attempt` JSDoc starting value to 0, streamlined concurrent traversal scheduling to avoid duplicate finish invocations, and added timer cleanup validation on retry aborts.
  - **resultar-request**: Guarded response `text()` and `json()` against synchronous throws and promise rejections outside `ResultAsync`, implemented safe serialization for circular references and BigInt values in `RequestError.exception`, mapped `BodyTimeoutError` and `TimeoutError` to status 408, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-typebox**: Preserved `code` and `path` in TypeBox validation error items, widened `typebox` peer dependency to `^1.3.4`, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-zod**: Widened `zod` peer dependency to `^4.4.3` and updated internal dependencies to caret workspace ranges.
- Updated dependencies [93b11c1]
- Updated dependencies [b913a80]
  - resultar@3.5.2
  - resultar-request@0.1.2

## 0.1.1

### Patch Changes

- 8ab30ff: Clarify the recommended validation workflow, request examples, runtime requirements, and published
  documentation links across the checker and request packages.
- Updated dependencies [8ab30ff]
- Updated dependencies [8ab30ff]
  - resultar@3.5.1
  - resultar-request@0.1.1

## 0.1.0

### Minor Changes

- f7f8fbd: Add fetch-first JSON request helpers with validator-neutral core support plus TypeBox and Zod adapters.

### Patch Changes

- Updated dependencies
- Updated dependencies [f7f8fbd]
- Updated dependencies [dfbfcb3]
  - resultar@3.5.0
  - resultar-request@0.1.0
