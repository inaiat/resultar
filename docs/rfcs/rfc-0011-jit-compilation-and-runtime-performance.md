# RFC 0011: Transparent JIT compilation, static graph specialization, and V8 runtime performance

- Status: Implemented (Validated; Awaiting Release)
- Date: 2026-11-20
- Target packages: `resultar`, `resultar-di`, `resultar-hono`, `resultar-fastify`, `resultar-nestjs`, `resultar-request-typebox`, `resultar-config`, `resultar-benchmarks`
- References: [RFC 0001](./rfc-0001-result-task-core.md), [RFC 0002](./rfc-0002-di-lifetimes-scopes.md), [RFC 0004](./rfc-0004-effect-v4-ergonomics-and-tooling.md), [RFC 0008](./rfc-0008-declarative-configuration.md), [RFC 0010](./rfc-0010-dx-observability-concurrency-and-tooling.md)

## Summary

Establish Resultar as the fastest typed workflow, pattern-matching, dependency-injection, and
contract-validation toolkit in the TypeScript ecosystem by combining **V8-friendly monomorphic
core optimizations** with **transparent, lazy, CSP-safe JIT compilation** inspired by
ElysiaJS's static dependency inference (*Sucrose*), straight-line function synthesis
(`compose`), and compiled TypeBox validation.

All optimizations preserve Resultar's v4 runtime semantics, `"sideEffects": false` tree-shaking,
zero-ceremony DX, and full portability across Node.js, Bun, Deno, browsers, and strict-CSP edge
runtimes (such as Cloudflare Workers) via automatic fallback to semantically identical interpreted
paths.

This RFC covers six coordinated workstreams delivered across three incremental phases:

1. **Workstream A — V8-friendly core runtime optimizations (Zero-JIT fast paths)**: unify
   `ResultTaskRuntimeContext` hidden classes, replace object/string instruction tags with V8 Smi
   numeric opcodes, add dedicated `CATCH_TAG` / `CATCH_TAGS` opcodes, specialize `pipe`/`flow`/`dual`
   by arity, pool `OkResultIterator` and task continuation stacks, and eliminate allocation wrappers
   in `tagged-match`.
2. **Workstream B — Compiled `createTaggedError` interpolators and constructors**: compile
   `$variable` message templates once at class-creation time into straight-line string concatenation
   with a `string | number` fast path, share frozen `fingerprint` tuples, avoid empty `{}` error
   options, and eliminate `Object.entries` tuple allocations during error instantiation.
3. **Workstream C — `Match` decision-tree JIT compiler**: compile reusable `Match.type()`,
   `Match.fn()`, and `Match.context()` matchers into flat JavaScript functions (`switch (v._tag)`,
   inlined nested object/array guards, direct arity without `...args`/`slice(1)`, and inlined
   `ok`/`err`/option wrapping).
4. **Workstream D — Static DI graph analysis and HTTP request JIT (`resultar-di` and HTTP adapters)**:
   pre-analyze immutable `ServiceModule` subgraphs at registration time (Resultar's *Sucrose*) and
   synthesize specialized per-endpoint resolvers (Resultar's `compose`) that bypass `Map` cloning,
   `RuntimeScope`/`TaskScope` allocation, and `ReadableStream` response re-wrapping whenever a route's
   reachable dependency graph holds no scoped resources.
5. **Workstream E — Tiered JIT compiler for reusable `ResultTask` pipelines**: keep one-shot tasks
   on the zero-compile-cost interpreter, and lazily compile hot immutable chains (on 2nd+ execution,
   with an optional explicit precompile path evaluated in Phase 3) into unboxed straight-line code
   with batched `schedulerCheckpoint` checks.
6. **Workstream F — Schema and config validation JIT (`resultar-request-typebox`, `resultar-config`)**:
   switch `resultar-request-typebox` from interpreted `Value.Check` to `WeakMap`-cached
   `Compile(schema)` from `typebox/compile` (with CSP fallback), and cache compiled dual-pass AJV
   validators inside `defineAppConfig`.

---

## 1. Baseline, benchmarks, and architectural motivation

### 1.1 Current benchmark standing

Resultar already leads `neverthrow` across all measured scenarios and outperforms `effect` v4 in
9 of 10 core scenarios ([benchmarks/README.md](../../benchmarks/README.md)):

| Scenario (Node.js v24, Apple Silicon) | `resultar` | `effect` v4 | Ratio |
| :--- | ---: | ---: | ---: |
| `flatMap chain (50 steps)` | `884,525 op/s` (`1.13 µs`) | `330,942 op/s` (`3.02 µs`) | **2.67x faster** |
| `generator fn (5 yields)` | `1,933,456 op/s` (`0.52 µs`) | `451,825 op/s` (`2.21 µs`) | **4.28x faster** |
| `TaggedError + catchTag` | `229,170 op/s` (`4.36 µs`) | `245,382 op/s` (`4.08 µs`) | **0.93x (gap)** |
| `fiber fork + joinAll (100 fibers)` | `18,355 op/s` (`54.48 µs`) | `14,185 op/s` (`70.50 µs`) | **1.29x faster** |
| `forEach bounded (60 items, concurrency=8)` | `60,146 op/s` (`16.63 µs`) | `18,874 op/s` (`52.98 µs`) | **3.19x faster** |
| `semaphore contention (40 tasks, 4 permits)` | `46,648 op/s` (`21.44 µs`) | `15,940 op/s` (`62.73 µs`) | **2.93x faster** |
| `scoped acquireRelease LIFO (5 resources)` | `431,747 op/s` (`2.32 µs`) | `154,643 op/s` (`6.47 µs`) | **2.79x faster** |
| `fiber tree interrupt + cleanup` | `42,512 op/s` (`23.52 µs`) | `20,297 op/s` (`49.27 µs`) | **2.09x faster** |
| `sync pipeline (50 steps)` | `664,804 op/s` (`1.50 µs`) | `357,950 op/s` (`2.79 µs`) | **1.86x faster** |
| `sync generator (5 yields)` | `2,092,409 op/s` (`0.48 µs`) | `318,654 op/s` (`3.14 µs`) | **6.57x faster** |

### 1.2 Audited hotspots across the workspace

A code-level audit identified concrete structural bottlenecks across five packages:

1. **HTTP + DI per-request overhead** ([packages/di/src/module.ts](../../packages/di/src/module.ts),
   [packages/di/src/fetch.ts](../../packages/di/src/fetch.ts),
   [packages/hono/src/middleware.ts](../../packages/hono/src/middleware.ts)):
   - `RuntimeScope.child()` clones `new Map(this.definitions)` on every request, even when `locals`
     is empty.
   - Each request allocates a completion `Promise`, registers it in `this.children`, builds a
     `ResultTask.gen` inside `resolveMany()`, wraps every service resolution in a bound generator
     (`resolveOnExecution.bind(this)`), freezes `Object.fromEntries(entries)`, and allocates a
     fresh `Object.fromEntries` map of closures for **every registered service** inside `bind()`.
   - `runScopedResponse()` allocates two `Promise.withResolvers()`, an `AbortController`, and wraps
     every non-null `Response` body in a new `ReadableStream` + `getReader()` + `new Response(...)`,
     even when zero scoped resources or finalizers exist for the request.
2. **Compiled `Match` dispatch overhead** ([packages/resultar/src/match/match.ts](../../packages/resultar/src/match/match.ts),
   [packages/resultar/src/match/match-pattern.ts](../../packages/resultar/src/match/match-pattern.ts)):
   - Reusable `Match.type()`, `Match.fn()`, and `Match.context()` matchers allocate `...args`,
     compute `args.slice(1)` or `[]`, loop over closure arrays, perform `Map.get()` for `_tag`
     tables, run `entries.every(([key, matches]) => ...)` with per-call destructuring on nested
     object patterns, and wrap the result through `(selected) => selected`.
3. **Uncompiled `createTaggedError` instantiation** ([packages/resultar/src/tagged/tagged-error.ts](../../packages/resultar/src/tagged/tagged-error.ts)):
   - `compileMessageInterpolator()` executes `template.replaceAll(regex, callback)` on every
     `new MyError(props)` invocation.
   - Every instance allocates a fresh `[options.name, messageTemplate]` tuple for `fingerprint`,
     allocates `{}` in `getErrorOptions(undefined)`, and iterates `Object.entries(props)` with
     `Set.has` + `Object.defineProperty`.
4. **Core V8 deoptimizations and allocations** ([packages/resultar/src/task/result-task.ts](../../packages/resultar/src/task/result-task.ts),
   [packages/resultar/src/task/task-service.ts](../../packages/resultar/src/task/task-service.ts),
   [packages/resultar/src/core/pipe.ts](../../packages/resultar/src/core/pipe.ts),
   [packages/resultar/src/core/function.ts](../../packages/resultar/src/core/function.ts),
   [packages/resultar/src/core/dual.ts](../../packages/resultar/src/core/dual.ts),
   [packages/resultar/src/result/result-helpers.ts](../../packages/resultar/src/result/result-helpers.ts),
   [packages/resultar/src/tagged/tagged-match.ts](../../packages/resultar/src/tagged/tagged-match.ts)):
   - `withServices` and `withNamedServices` construct `ResultTaskRuntimeContext` with `scope`
     before `namedServices`, diverging from every other context constructor and splitting the V8
     hidden class (Map) for every `context.*` access.
   - `ResultTask` instructions use singleton objects `{ _tag: '...' }` and string `switch`
     statements rather than integer Smi opcodes.
   - `runTaskLoop` allocates a fresh `continuations = []` array per loop, executes `schedulerCheckpoint`
     on both push and pop (`2N` checks for `N` steps), and boxes `{ _tag: 'Success', value }` on
     every step.
   - `catchTag` wraps a closure inside `orElse` and re-allocates `ResultTask.err(error)` on mismatch.
   - `pipe`, `flow`, and `dual` allocate rest/spread arrays (`...functions`, `[self, ...args]`).
   - `Ok[Symbol.iterator]` allocates a new `OkResultIterator` on every `yield* ok(...)`, unlike
     `ResultTask[Symbol.iterator]` which pools `idleTaskIterator`.
   - `callTaggedHandler` allocates `{ value }` on every matched tag.
5. **Interpreted schema validation & repeated AJV compilation**
   ([packages/request-typebox/src/request-json-typebox.ts](../../packages/request-typebox/src/request-json-typebox.ts),
   [packages/config/src/index.ts](../../packages/config/src/index.ts)):
   - `resultar-request-typebox` invokes interpreted `Value.Check(schema, value)` on every decoded
     response instead of caching TypeBox's JIT `Compile(schema)` validator.
   - `defineAppConfig` creates two `Ajv` instances and compiles the schema inside `ResultTask.sync`
     on every `.load()` call.

### 1.3 Why ElysiaJS's JIT model fits Resultar — and where NOT to use `new Function`

ElysiaJS achieves near-native throughput through four cooperating ideas:

1. **Static analysis of declared structure (*Sucrose*)**: determine at registration time what a
   handler/route actually needs so unused work is omitted completely.
2. **Straight-line function synthesis (`compose`)**: flatten nested middleware/hook/combinator
   chains into a single monomorphic JavaScript function via `new Function`.
3. **Lazy compilation + caching + safe fallback**: compile on first/hot execution (or opt-in
   precompilation), cache the generated function, and retain an interpreted fallback (`aot: false`)
   for restricted runtimes.
4. **Compiled schema validators**: leverage TypeBox's JIT compiler (`Compile`) instead of AST
   interpretation.

However, **`new Function` compilation is not free**: parsing, generating bytecode, and allocating
a code object in V8/JSC typically costs **10–50 µs**. Applying it blindly would cause severe
regressions on short-lived objects:

| Workload | Execution cost today | Should use `new Function` JIT? | Strategy |
| :--- | :--- | :---: | :--- |
| One-shot `ResultTask` chain (built per request, run once) | `~1.1 µs` (50 steps) | **No** (would be 10x–40x slower) | V8-friendly interpreter (Workstream A) |
| Reusable / hot `ResultTask` pipeline (run 2+ times) | `~1.1 µs × N` | **Yes (Tiered JIT)** | Compile on 2nd+ execution or explicit `.compile()` (Workstream E) |
| `Match.value(x)` (one-shot eager match) | `<0.1 µs` | **No** | Keep eager interpreted path |
| `Match.type()` / `Match.fn()` / `Match.context()` | Define once, run `10⁶` times | **Yes** | Compile decision tree once (Workstream C) |
| `createTaggedError(...)` | Define once, instantiate `10⁶` times | **Yes** | Compile interpolator once at class definition (Workstream B) |
| `resultar-di` `scope.fetch` / HTTP middleware | Register once, run `10⁶` requests | **Yes** | Static subgraph analysis + compiled resolver (Workstream D) |
| `resultar-request-typebox` schemas | Define once, decode `10⁶` payloads | **Yes** | `WeakMap`-cached TypeBox `Compile(schema)` (Workstream F) |
| Trivial `Result.ok(x).map(f)` | `<10 ns` | **No** | Monomorphic methods + iterator pool (Workstream A) |

---

## 2. Core JIT infrastructure, security model, and CSP/Edge portability

All JIT compilation across workspace packages shares a single internal helper module:
`packages/resultar/src/core/jit.ts` (internal only; never exposed on `"resultar"` public subpaths
unless a dedicated configuration API is explicitly approved).

### 2.1 Lazy capability probing and `"sideEffects": false`

To preserve `"sideEffects": false` tree-shaking (RFC 0010), `core/jit.ts` **must not** execute
`new Function(...)` at module evaluation time. Capability detection runs lazily on the first
compilation request and caches the result:

```ts
let jitAvailable: boolean | undefined = undefined
let jitForcedOverride: boolean | undefined = undefined

const isEnvJitDisabled = (): boolean => {
  try {
    const env = (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } })
      .process?.env
    return env?.['RESULTAR_JIT'] === '0' || env?.['RESULTAR_JIT'] === 'false'
  } catch {
    return false
  }
}

export const canUseJit = (): boolean => {
  if (jitForcedOverride !== undefined) return jitForcedOverride
  if (jitAvailable !== undefined) return jitAvailable
  if (isEnvJitDisabled()) {
    jitAvailable = false
    return false
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const probe = new Function('return 1') as () => number
    jitAvailable = probe() === 1
  } catch {
    jitAvailable = false
  }
  return jitAvailable
}
```

- **Strict CSP / Cloudflare Workers / Deno Deploy without `unsafe-eval`**: `new Function` throws
  `EvalError`, `jitAvailable` latches to `false`, and every caller transparently falls back to its
  optimized non-JIT implementation with zero runtime errors.
- **Opt-out & deterministic testing**:
  - `RESULTAR_JIT=0` disables JIT process-wide (useful for auditing, debugging, or strict runtime
    policies).
  - An internal test-only helper (or env var) allows CI to run the full test suite under both
    `RESULTAR_JIT=1` and `RESULTAR_JIT=0`, guaranteeing semantic equivalence and keeping Stryker
    mutation scores intact.

### 2.2 Strict codegen security invariants

Dynamic code generation introduces injection risk if user data ever enters generated source text.
Every code generator in Resultar must enforce four hard invariants:

1. **Zero raw string interpolation of user input**: arbitrary identifiers, tag names, property
   names, template fragments, or error messages are **never** concatenated directly into JS syntax.
2. **Bound closure parameters for runtime values**: functions, predicates, handlers, service
   factories, and symbol keys are passed as positional parameters (`p0`, `p1`, ...) to a factory
   function generated via `new Function(...paramNames, "'use strict'; return " + body)` and bound
   immediately via `factory(...paramValues)`.
3. **JSON-serialized primitive literals only**: when emitting constant string/number/boolean
   literals (such as `case "NotFoundError":`, `v["status"]`, or template string chunks), values
   **must** pass through `JSON.stringify(value)` (and escape `\u2028`/`\u2029` when needed) so no
   literal can break out of string context. Property access uses computed bracket syntax
   `v[${JSON.stringify(key)}]` unless `key` matches `/^[A-Za-z_$][A-Za-z0-9_$]*$/` and is not a
   JS reserved keyword.
4. **Never generate code from per-request runtime input**: code generation is strictly triggered
   by static structure (schemas, `createTaggedError` templates, `Match` definitions, immutable DI
   graphs, or immutable `ResultTask` chains) — never from incoming HTTP request bodies, headers,
   query params, or dynamic user strings.

### 2.3 Memory safety and V8 bailout guards

- **No unbounded global caches**: compiled functions are stored directly on the owning immutable
  artifact (e.g., closure inside the compiled `Match` function, constructor closure of
  `createTaggedError`, private field on `ResultTask`, or `WeakMap` keyed by `TSchema` / `ServiceModule`)
  so GC reclaims compiled code automatically when definitions go out of scope.
- **Maximum compilation size budgets**: V8 TurboFan can bail out or spend excessive compile time
  on huge generated functions. Compilers enforce conservative upper bounds (e.g., `MAX_JIT_STEPS = 256`
  for `ResultTask` chains, `MAX_JIT_CASES = 128` for `Match`, `MAX_JIT_NODES = 128` for DI
  subgraphs) and fall back cleanly to the interpreter beyond those limits.

---

## 3. Workstream A — V8-friendly core runtime optimizations (Zero-JIT fast paths)

These optimizations improve **every** environment (Node, Bun, Edge, CSP-restricted, cold one-shot
tasks, and JIT fallback paths) with zero public API changes.

### A1. Monomorphic `ResultTaskRuntimeContext` hidden class

In [packages/resultar/src/task/task-service.ts](../../packages/resultar/src/task/task-service.ts),
`withServices` and `withNamedServices` currently declare `scope` before `namedServices`, whereas
`withScope`, `withChildScope`, `withCleanupScope`, `withServiceResolver`, `withLocals`,
`withSpanStack`, `normalizeRuntimeContext`, `runExitSyncOrAsync`, and `runExitWithOptions` all
declare `namedServices` first.

**Change**:
- Enforce one canonical property order across all context factories (or back
  `ResultTaskRuntimeContext` with a single monomorphic internal class `RuntimeContext` whose fields
  are always initialized in the exact same order).
- All `context.signal`, `context.scheduling`, `context.scope`, and `context.services` reads become
  strictly monomorphic inline caches in V8 Ignition/TurboFan.

### A2. Numeric V8 Smi opcodes for `ResultTask`

In [packages/resultar/src/task/result-task.ts](../../packages/resultar/src/task/result-task.ts),
`private instruction: TaskInstruction` currently stores singleton objects `{ _tag: 'FlatMap' }`
and `runTaskLoop` switches on `instruction._tag` (a property load + string dispatch).

**Change**:
- Replace `instruction` with a small integer opcode (`op: number`, V8 Smi `0..15`):
  ```ts
  const OP_SUCCESS = 0
  const OP_FAIL = 1
  const OP_SYNC = 2
  const OP_TRY_PROMISE = 3
  const OP_GEN = 4
  const OP_ASYNC = 5
  const OP_CUSTOM = 6
  const OP_FLAT_MAP = 7
  const OP_MAP = 8
  const OP_MAP_ERROR = 9
  const OP_TAP = 10
  const OP_TAP_ERROR = 11
  const OP_TAP_BOTH = 12
  const OP_CATCH_ALL = 13
  const OP_CATCH_TAG = 14
  const OP_CATCH_TAGS = 15
  ```
- Store `private customExecute` (or reuse `value` when `op === OP_CUSTOM`) so `ResultTask` retains
  a fixed, minimal 3-field (or 4-field with `#compiled`) hidden class.
- `switch (op)` compiles to a direct CPU jump table (`Tableswitch`) in TurboFan and eliminates an
  object dereference on every instruction.

### A3. Dedicated `OP_CATCH_TAG` and `OP_CATCH_TAGS` opcodes

Currently `task.catchTag(tag, handler)` calls:

```ts
return this.orElse((error) =>
  hasTag(error, tag) ? handler(error) : ResultTask.err(error),
)
```

This allocates a closure at construction time AND allocates a throwaway `ResultTask.err(error)`
object whenever the tag does not match.

**Change**:
- Represent `catchTag` directly via `OP_CATCH_TAG` (storing `{ tag, handler }` or dedicated
  continuation descriptor) and `catchTags` via `OP_CATCH_TAGS` (storing `handlers`).
- In `#applyFailureContinuation`, check `exit.cause._tag === 'Fail'` and match `error._tag === tag`
  directly in place; on mismatch, return the existing `exit` untouched (zero `ResultTask.err`
  allocation, zero wrapper closure).
- Preserve composite-cause behavior (`Sequential`/`Parallel` → `Die(ResultTaskCauseError)`)
  identically to `orElse`.

### A4. Arity-specialized `pipe`, `flow`, and `dual`

- [packages/resultar/src/core/function.ts](../../packages/resultar/src/core/function.ts) and
  [packages/resultar/src/core/pipe.ts](../../packages/resultar/src/core/pipe.ts):
  - Implement `pipe` with direct `arguments.length` switching for 1–9 arguments (zero `...functions`
    rest-array allocation; fallback to `runPipe` only for >9 arguments or `Pipeable.prototype.pipe`).
  - Implement `flow` with arity-specialized closures for 1–8 piped functions (e.g., for 3 functions:
    `return function (...args) { return f2(f1(first.apply(this, args))) }` — and fast 1-arg /
    `arguments` forwarding without intermediate loops or `transform === undefined` checks on every
    call; validate functions once at `flow(...)` creation time).
- [packages/resultar/src/core/dual.ts](../../packages/resultar/src/core/dual.ts):
  - Specialize common fixed-arity data-first/data-last cases (e.g., 1, 2, 3 arguments) to avoid
    allocating `[self, ...args]` on every curried invocation.

### A5. Allocation pooling and wrapper elimination

- **`OkResultIterator` single-element pool** ([packages/resultar/src/result/result-helpers.ts](../../packages/resultar/src/result/result-helpers.ts)):
  Mirror `idleTaskIterator` from `result-task.ts` for synchronous `Result.gen` (`yield* ok(v)`).
  Since `OkResultIterator.next()` immediately returns `{ done: true, value }` on the first call,
  a single pooled instance (reset after consumption) eliminates `N` heap allocations per `N`-yield
  `Result.gen` execution.
- **`runTaskLoop` continuation stack pool**:
  Pool a single reusable `ResultTask[]` array (cleared on return when not escaped into an async
  closure, capped at e.g. length `<= 256`) so synchronous chains do not allocate `continuations = []`
  on every run.
- **Allocation-free `tagged-match.ts`** ([packages/resultar/src/tagged/tagged-match.ts](../../packages/resultar/src/tagged/tagged-match.ts)):
  Avoid allocating `{ value: handler(value) }` inside `callTaggedHandler`; expose an internal
  two-branch helper or sentinel return value that callers inspect directly without boxing.
- **Zero-allocation `ResultTask.fn` with pipes / `spanName`**:
  Avoid allocating `() => body.call(this, ...args)` closure + rest array on the common 0/1-argument
  paths when possible.

---

## 4. Workstream B — Compiled `createTaggedError` interpolators and constructors

Target: [packages/resultar/src/tagged/tagged-error.ts](../../packages/resultar/src/tagged/tagged-error.ts).

### 4.1 One-time template compilation

At `createTaggedError({ name, message })` time (executed once per error class):

1. Parse `messageTemplate` into alternating static literal chunks and variable keys:
   `"User $id failed in $region"` → `chunks = ["User ", " failed in ", ""]`, `vars = ["id", "region"]`.
2. Handle trivial templates with zero compilation:
   - **No variables** (e.g., `"Invalid application configuration"`): return a constant thunk
     `() => messageTemplate` (zero regex, zero string concat).
   - **Default `"$message"`**: direct closure checking `props?.message` with fast `typeof === 'string'` path.
3. For templates with 1+ variables:
   - **JIT path (`canUseJit()`)**: compile a specialized function once via `new Function`:
     ```js
     // Generated once for "User $id failed in $region"
     return function interpolate(p) {
       if (p === undefined || p === null) return "User $id failed in $region";
       var v0 = p["id"];
       var v1 = p["region"];
       return "User " + (v0 === undefined ? "$id" : (typeof v0 === "string" || typeof v0 === "number" ? v0 : s(v0)))
            + " failed in " + (v1 === undefined ? "$region" : (typeof v1 === "string" || typeof v1 === "number" ? v1 : s(v1)));
     }
     ```
     Because `Redacted` is an object (`typeof v === 'object'`), checking
     `typeof v === 'string' || typeof v === 'number'` inline is **100% safe** and bypasses both
     `isRedacted` and `templateValueStringifiers[typeof v]` for >95% of real-world error props.
   - **Fallback path (CSP / no JIT)**: loop over the pre-parsed `chunks` / `vars` arrays (still
     eliminating `template.replaceAll(regex, callback)` completely!).

### 4.2 Constructor allocation elimination

Inside `GeneratedTaggedError`:

- **Shared frozen `fingerprint`**: hoist `const sharedFingerprint = Object.freeze([options.name, messageTemplate] as const)`
  outside the constructor and assign `this.fingerprint = sharedFingerprint` (avoiding per-instance
  array allocation while keeping `fingerprint` an own enumerable property so `Object.entries(err)` /
  `toJSON()` remain unchanged).
- **Avoid `{}` allocation in `super()`**:
  ```ts
  const cause = props?.cause
  if (cause === undefined) {
    super(message)
  } else {
    super(message, { cause })
  }
  ```
- **Avoid `Object.entries(props)` tuple allocation**:
  In the default (`!explicitProps`) path, iterate `for (const key in props)` with
  `Object.hasOwn(props, key)` and skip reserved keys, assigning readonly descriptors directly.
  (Verify via microbenchmark whether a JIT-compiled prop copiers for known template keys +
  fast-path extra keys yields further gains while preserving exact `readonly` descriptor semantics
  checked by `tests/tagged-error.test.ts` and `tests/tagged-error-props.test.ts`.)

---

## 5. Workstream C — `Match` decision-tree JIT compiler

Targets: [packages/resultar/src/match/match.ts](../../packages/resultar/src/match/match.ts),
[packages/resultar/src/match/match-pattern.ts](../../packages/resultar/src/match/match-pattern.ts).

### 5.1 Separating eager vs. compiled modes

- `Match.value(input)` remains eagerly interpreted (runs once; compilation would regress latency).
- `Match.type()`, `Match.fn(select)`, and `Match.context()` accumulate a compact **declarative IR**
  instead of eagerly wrapping opaque closures:

```ts
type PatternIr =
  | { readonly kind: 'predicate'; readonly fn: (value: unknown) => boolean }
  | { readonly kind: 'literal'; readonly value: unknown } // primitive: string | number | boolean | bigint | symbol | null | undefined
  | { readonly kind: 'array'; readonly elements: readonly PatternIr[] }
  | { readonly kind: 'object'; readonly entries: readonly (readonly [PropertyKey, PatternIr])[] }

type CaseIr =
  | { readonly kind: 'pattern'; readonly pattern: PatternIr; readonly handler: Handler }
  | { readonly kind: 'or'; readonly patterns: readonly PatternIr[]; readonly handler: Handler }
  | { readonly kind: 'and'; readonly patterns: readonly PatternIr[]; readonly handler: Handler }
  | { readonly kind: 'not'; readonly pattern: PatternIr; readonly handler: Handler }
  | { readonly kind: 'tagSet'; readonly tags: readonly string[]; readonly handler: Handler }
  | { readonly kind: 'tagTable'; readonly key: PropertyKey; readonly entries: readonly (readonly [PropertyKey, Handler])[] }
```

All validation that currently happens at builder call time (plain-object prototype check in
`compileMatchPattern`, `typeof handler !== 'function'` check in `tableCases`) **continues to run
eagerly** during IR construction so invalid inputs throw at the exact same call site.

### 5.2 Compiled output shape

At completion (`.exhaustive()`, `.orElse()`, `.orElseAbsurd()`, `.result()`, `.option()`,
`.tagsExhaustive()`), compile the IR once (or lazily on first invocation if preferred; lazy-on-first
avoids paying compilation for matchers constructed but never called, while eager compilation on
completion is ~15 µs once at module load — Phase 1 benchmarks will decide the default, with lazy
recommended to match Elysia):

Example — `Match.type<Event>().tagsExhaustive({ Created: h0, Deleted: h1 })`:

```js
// Bound params: h0, h1, fb
return function match(v) {
  if ((typeof v === "object" || typeof v === "function") && v !== null) {
    switch (v._tag) {
      case "Created": return h0(v);
      case "Deleted": return h1(v);
    }
  }
  return fb(v);
}
```

Example — `Match.type<Resp>().when({ status: 200, body: { ok: true } }, h0).result()`:

```js
// Bound params: h0, ok, err
return function match(v) {
  if (
    typeof v === "object" && v !== null &&
    "status" in v && v["status"] === 200 &&
    "body" in v &&
    typeof v["body"] === "object" && v["body"] !== null &&
    "ok" in v["body"] && v["body"]["ok"] === true
  ) {
    return ok(h0(v));
  }
  return err(v);
}
```

### 5.3 Exact semantic parity details

- **Mode specialization**:
  - `kind === 'type'`: generated signature is `function match(v)` — zero `...args`, zero `slice`,
    zero `identity(v)` call.
  - `kind === 'context'`: generated signature forwards extra args directly (`v, a0, a1` when
    handler arities are fixed, or `function match(v)` using `arguments` slice only when
    `arguments.length > 1`, or fast-path for 1–3 context args).
  - `kind === 'fn'`: invokes `const v = select(...args)` directly and forwards args without extra
    allocations.
- **Outcome specialization**:
  - `.orElse` / `.exhaustive` / `.orElseAbsurd`: return `h(v)` directly (no `(selected) => selected` wrapper).
  - `.result()`: return `ok(h(v))` / `err(v)` directly.
  - `.option()`: return `{ _tag: 'Some', value: h(v) }` / `{ _tag: 'None' }` directly.
- **Numeric keys in `tagTable`**: preserve the existing `typeof actual === 'number' ? String(actual) : actual`
  coercion behavior when numeric string keys exist in the table.
- **Special literals**: `NaN` (where `v === NaN` is always false, matching current `value === pattern`),
  `symbol` / `bigint` / `-0` handled via bound parameter `v === p0` (avoiding `JSON.stringify` on
  `bigint`/`symbol`).
- **CSP fallback**: falls back to an optimized non-JIT interpreter over the same `CaseIr` (already
  faster than today's closure chain because it specializes `kind === 'type'` and eliminates
  `(selected) => selected`).

---

## 6. Workstream D — Static DI graph analysis and HTTP request JIT (`resultar-di` and HTTP adapters)

Targets: [packages/di/src/module.ts](../../packages/di/src/module.ts),
[packages/di/src/fetch.ts](../../packages/di/src/fetch.ts),
[packages/hono/src/middleware.ts](../../packages/hono/src/middleware.ts),
[packages/hono/src/index.ts](../../packages/hono/src/index.ts),
[packages/fastify/src/index.ts](../../packages/fastify/src/index.ts),
[packages/nestjs/src/index.ts](../../packages/nestjs/src/index.ts).

This is Resultar's direct counterpart to ElysiaJS's **Sucrose + Compose** pipeline and delivers the
largest end-to-end latency win for production HTTP services.

### 6.1 Static metadata enrichment on `Definition`

Every registration method on `ServiceModule` already knows its execution characteristics at
registration time:

- `.value(name, v)` → `kind: 'value'`, `lifetime: 'singleton'`, `sync: true`, `hasResource: false`, `usesServiceTags: false`
- `.singleton(name, deps, create)` / `.scoped(...)` / `.transient(...)` (sync factory overload) →
  `kind: 'sync'`, `sync: true`, `hasResource: false`, `usesServiceTags: false`
- `.task(name, deps, create, opts)` → `kind: 'task'`, `sync: false`, `mayAcquireResource: true`, `mayUseServiceTags: true`
- `.resource(name, deps, opts)` → `kind: 'resource'`, `sync: false`, `hasResource: true`, `mayUseServiceTags: true`
- `.singleton(ServiceClass)` / `withProvider(...)` → classified accordingly (preserving `synchronousFactory` & `release` flags).

### 6.2 Static subgraph analyzer (Resultar's *Sucrose*)

When `scope.fetch(keys, handle)`, `scope.use(keys, cb)`, `createHonoApp(...)`, or
`createHonoServices().middleware(keys)` is constructed, the analyzer inspects only the subgraph
reachable from `keys` against the immutable `Definitions` map:

1. **Validate keys & detect static cycles and lifetime violations upfront** (maintaining exact
   runtime error types and resolution-path messages).
2. **Compute topological resolution order** `[dep_0, dep_1, ..., dep_k]` for `keys`.
3. **Assign dense integer slot indices** `0..M-1` for cached singletons on the root `RuntimeScope`
   (parallel flat array `singletonSlots: unknown[]` + bitmask/sentinel `UNSET` alongside `cache`
   Map for compatibility with dynamic `ServiceAccess.get()`).
4. **Classify the compiled execution tier** of `(keys, hasLocals)`:

| Tier | Subgraph preconditions | What gets skipped per request |
| :--- | :--- | :--- |
| **Tier 0 — Pure Singleton** | All reachable services are `value` or `singleton` with `sync: true`, `hasResource: false`, `mayUseServiceTags: false`; `locals` empty | Skips `RuntimeScope.child()`, `Map` clone, `Promise`/`children` tracking, `TaskScope`, `ResultTask`, `AbortController`, and `ReadableStream` response wrapping |
| **Tier 1 — Scoped Sync (Resource-Free)** | All reachable services are `sync: true`, `hasResource: false`, `mayUseServiceTags: false` (includes `scoped` and `transient` sync factories, plus optional `locals`) | Skips `Map` clone, `TaskScope`, `ResultTask.gen`, `Object.fromEntries`, `bind()`, and `ReadableStream` response wrapping; runs compiled straight-line factory calls |
| **Tier 2 — Full Async / Resource-Owning** | Any reachable service is `task`, `resource`, `ServiceClass`, or may acquire a scoped finalizer / `yield* ServiceTag` | Still optimizes: (a) shares parent `definitions` Map when `locals` is empty instead of cloning, (b) replaces per-request `bind()` `Object.fromEntries` with a single shared lookup closure, (c) checks `child.hasResources()` before wrapping `Response.body` in `ReadableStream`! |

### 6.3 Compiled per-endpoint resolver (Resultar's `compose`)

For **Tier 0** (e.g., `keys = ['db', 'auth']` where both are sync singletons):

```js
// Compiled once when scope.fetch(['db', 'auth'], handle) is called:
// Bound params: root, handle, f0, f1, UNSET, assertSync, checkClosed
return function dispatch(request) {
  if (root.closed) return Promise.reject(new TypeError("Cannot create a child from a closed service scope"));
  var s0 = root.slots[0];
  if (s0 === UNSET) {
    s0 = f0(EMPTY);
    assertSync(s0);
    root.slots[0] = s0;
    root.cache.set("db", s0);
  }
  var s1 = root.slots[1];
  if (s1 === UNSET) {
    s1 = f1({ db: s0 });
    assertSync(s1);
    root.slots[1] = s1;
    root.cache.set("auth", s1);
  }
  // Once all singletons in this endpoint are initialized, even the frozen
  // { db: s0, auth: s1 } services object is cached and reused across requests!
  return handle(cachedServices, request);
}
```

For **Tier 1** (e.g., `db` is singleton, `repo` is scoped sync depending on `db`, `requestId` is a local):

```js
return function dispatchWithLocals(request, locals) {
  if (root.closed) ...
  var s0 = root.slots[0]; // singleton
  if (s0 === UNSET) { ... }
  var d1 = Object.freeze({ db: s0, requestId: locals.requestId });
  var s1 = f1(d1);
  assertSync(s1);
  var services = Object.freeze({ db: s0, repo: s1 });
  return handle(services, request);
}
```

### 6.4 Preserving response-stream and cancellation semantics

- **Conditional stream wrapping in `runScopedResponse`** ([packages/di/src/fetch.ts](../../packages/di/src/fetch.ts)):
  `runScopedResponse` exists specifically to keep a request's `RuntimeScope` open while a streaming
  `Response.body` is consumed so scoped resources (like DB cursors or file streams) are not released
  prematurely.
  - When a request resolves via **Tier 0 / Tier 1**, or in **Tier 2** when `child.resources` has
    **zero registered finalizers and zero active child fibers** (`scope.isClean()`) at the moment
    `handle(services, request)` returns `Response`, the request scope can close immediately and
    return the original `Response` untouched — **zero `ReadableStream` allocation, zero chunk
    copying, zero extra microtasks**!
  - Whenever `child` holds at least one finalizer or child fiber, `runScopedResponse` wraps the
    body stream identically to today.
  - Request abort handling (`if (request.signal.aborted) await response.body?.cancel(...)`) is
    preserved across all tiers.
- **Root shutdown synchronization (`root.close()`)**:
  Wait-for-in-flight-children tracking uses a lightweight integer counter (`activeChildren++` /
  `activeChildren--`, allocating a drain `Promise` only if `close()` is called while
  `activeChildren > 0`), eliminating the per-request `new Promise` + `Set.add` + `.then(Set.delete)`
  churn in `RuntimeScope.child()`!
- **Hono middleware (`createHonoServices`)**:
  Hoist subgraph compilation to `middleware(keys, options)` call time (once at router setup), not
  inside the per-request `async (context, next) => ...` handler.

---

## 7. Workstream E — Tiered JIT compiler for reusable `ResultTask` pipelines

Target: [packages/resultar/src/task/result-task.ts](../../packages/resultar/src/task/result-task.ts).

### 7.1 Hotness-triggered lazy compilation (Tiered JIT)

Every `ResultTask` instance is immutable after construction (except for the internal `execute`
setter used by test overrides). Adding two tiny private fields (`#runs = 0` and
`#compiled: CompiledExecutor | undefined = undefined` — or a compact internal state slot) enables
automatic tiered execution:

1. **Run 1 (Cold / One-shot)**: runs directly in the Workstream A Smi-opcode `runTaskLoop`. Zero
   compilation cost, zero latency penalty for per-request dynamic chains.
2. **Run 2 (Warming → Compile)**: if `canUseJit()` is true, `op` is a chain combinator
   (`OP_MAP`, `OP_FLAT_MAP`, `OP_MAP_ERROR`, `OP_CATCH_ALL`, `OP_CATCH_TAG`, `OP_CATCH_TAGS`,
   `OP_TAP`, `OP_TAP_ERROR`, `OP_TAP_BOTH`), and walking the linked list produces `3 <= length <= 256`
   standard nodes (no `OP_CUSTOM` override):
   - Flatten the linked list `[root, step_1, step_2, ..., step_k]` once.
   - Generate a flat JavaScript executor via `new Function` and cache it on the root task node.
3. **Run 2+ (Hot)**: `task.run(context)` dispatches straight to `#compiled(context)`.

### 7.2 What the compiled `ResultTask` executor looks like

Consider a reusable 4-step pipeline:

```ts
const loadDiscount = ResultTask.sync(() => getRawPrice())
  .map((p) => p * 0.9)
  .map((p) => Math.round(p))
  .catchTag('PriceError', () => ResultTask.ok(0))
```

Compiled executor (straight-line unboxed fast path):

```js
// Bound params: f0 (sync), f1 (map), f2 (map), tag3 ("PriceError"), h3 (catchTag),
//               NEVER_ABORTED, runSlow, success, failed, died, interrupted, isResultTask, isPromiseExit
return function runCompiled(ctx) {
  var sig = ctx.signal;
  var track = sig !== NEVER_ABORTED;
  if (track && sig.aborted) return interrupted(sig);
  var sched = ctx.scheduling;
  // Batched checkpoint: 1 check instead of 8 (push+pop) checks!
  if (sched.remaining <= 4) return runSlow(ctx);
  sched.remaining -= 4;

  var v;
  var failedExit = undefined;

  // Step 0: Sync (unboxed value in `v`)
  try {
    v = f0();
  } catch (e) {
    failedExit = died(e);
  }

  // Step 1 & 2: consecutive Map steps stay completely unboxed — ZERO Exit allocations!
  if (failedExit === undefined) {
    try {
      v = f1(v);
      v = f2(v);
    } catch (e) {
      failedExit = died(e);
    }
  }

  // Step 3: fused CatchTag (only entered on failure)
  if (failedExit !== undefined) {
    var c = failedExit.cause;
    if (c._tag === "Fail") {
      var err = c.error;
      if (typeof err === "object" && err !== null && err._tag === tag3) {
        try {
          var next = h3(err);
          if (isResultTask(next)) return next.run(ctx);
          return next.isOk() ? success(next.value) : failed(next.error);
        } catch (e) {
          return died(e);
        }
      }
    } else if (c._tag === "Sequential" || c._tag === "Parallel") {
      return died(new ResultTaskCauseError(c));
    }
    return failedExit;
  }

  return success(v);
}
```

### 7.3 Async bailout and semantic invariants

- **Mid-chain async step (`FlatMap` returning an async `ResultTask`, or `TryPromise`)**:
  Each compiled step knows its continuation index `i`. If step `i` returns a `Promise<Exit>`, the
  compiled function hands off cleanly to an async continuation loop starting at `i + 1` (or resumes
  via a pre-built suffix array of remaining steps), preserving full `AbortSignal`, `yieldEvery`,
  and `Cause` semantics without duplicating async boilerplate for every step.
- **Scheduler budget (`yieldEvery`)**:
  If `ctx.scheduling.remaining <= stepCount` (e.g., `yieldEvery: 1` or nearing the 2048 budget),
  immediately fall back to `runTaskLoop` so cooperative yielding triggers at the exact instruction
  boundary expected by tests and virtual clocks.
- **`task.execute = ...` test override**:
  The `execute` setter clears `#compiled = undefined` and sets `op = OP_CUSTOM`, guaranteeing
  existing internal tests continue to work identically.
- **Explicit precompile API (`task.compile()` — deferred decision to Phase 3)**:
  By default, compilation is **100% transparent** (no new public API required). During Phase 3,
  after measuring real workloads, we will evaluate whether an optional `ResultTask.compile(task)` /
  `task.compile()` (equivalent to Elysia's `{ precompile: true }`) is warranted for latency-sensitive
  boot paths that want to eliminate even the 2nd-call compile spike.

---

## 8. Workstream F — Schema and config validation JIT

### F1. `resultar-request-typebox` (`Compile` + `WeakMap` cache)

Target: [packages/request-typebox/src/request-json-typebox.ts](../../packages/request-typebox/src/request-json-typebox.ts).

`typebox` (`>=1.3.4 <2.0.0`, already a direct dependency) exports `Compile` and `Validator` from
`typebox/compile`.

**Change**:
- Maintain a `WeakMap<TSchema, Validator<TSchema> | null>` cache (`null` marks a schema where
  `Compile(schema)` threw — e.g., under strict CSP or an uncompilable custom schema — so we do not
  retry compilation on every request):
  ```ts
  const compiledValidators = new WeakMap<TSchema, Validator<TSchema> | null>()

  const getCompiledValidator = (schema: TSchema): Validator<TSchema> | null => {
    const cached = compiledValidators.get(schema)
    if (cached !== undefined) return cached
    if (!canUseJit()) {
      compiledValidators.set(schema, null)
      return null
    }
    try {
      const validator = Compile(schema)
      compiledValidators.set(schema, validator)
      return validator
    } catch {
      compiledValidators.set(schema, null)
      return null
    }
  }
  ```
- On decode:
  - Fast path: `validator.Check(value)` (10x–50x faster than `Value.Check`).
  - Fallback path: `Value.Check(schema, value)`.
  - Error path (only executed on invalid payloads): `Value.Errors(schema, value)` (or
    `validator.Errors(value)` if error objects match `{ code: error.keyword, message: error.message, path: error.instancePath }` identically — verified by tests).
- Also avoid re-creating `decodeWithTypeBoxSchema(input.schema)` wrapper closures unnecessarily when
  the validator is cached.

### F2. `resultar-config` (cached dual-pass AJV compilation)

Target: [packages/config/src/index.ts](../../packages/config/src/index.ts).

Currently `defineAppConfig` constructs `Type.Object(...)`, two `Ajv` instances, and calls
`compile(schema)` twice inside `ResultTask.sync(...)` on every `.load()` call.

**Change**:
- Lazily build and cache `{ schema, normalize, validate, ajv }` once per `defineAppConfig`
  definition on first execution (preserving laziness so invalid schemas still fail at execution
  time as defects rather than at module import time, matching RFC 0008!).
- Preserve exact dual-pass semantics (coercion pass on a shallow copy of `options.source ?? process.env`,
  followed by strict finite-number `env-schema`/AJV validation aggregating overflow and missing
  fields together).
- Reset `ajv.errors = null` before each run (execution is synchronous inside `ResultTask.sync`, so
  no interleaved async access can clobber `ajv.errors`).

---

## 9. Benchmarking, dual-mode verification, and regression gates

Performance claims in Resultar must be **measured, reproducible, and guarded against regressions**.

### 9.1 Dual-mode parity testing

Every JIT workstream must pass the entire workspace test suite in **both** modes:

1. `RESULTAR_JIT=1 pnpm run check:full` (JIT enabled — default)
2. `RESULTAR_JIT=0 pnpm run test` (JIT disabled — CSP/Edge fallback verification)

Targeted unit tests must explicitly verify:
- Output, error types, `Cause` trees, property descriptors, and side-effect ordering are identical
  between `RESULTAR_JIT=1` and `RESULTAR_JIT=0`.
- Injection / hostile-key tests (property names like `'__proto__'`, `'constructor'`, `'a"]; throw 1;//'`,
  newlines, `\u2028`, symbols, template strings with backticks/quotes) execute safely without code
  injection or syntax errors.
- CSP simulation tests (temporarily shadowing/failing `Function` or forcing `RESULTAR_JIT=0`) fall
  back cleanly without throwing `EvalError`.

### 9.2 New benchmark suites in `benchmarks/`

Add reproducible `cronometro` suites alongside existing benchmarks:

| Script | What it measures | Comparison baseline |
| :--- | :--- | :--- |
| `bench:match` | `Match.type().tagsExhaustive`, nested object patterns, `Match.context()` | Compiled JIT vs fallback vs manual `switch` |
| `bench:di-http` | `resultar-di` `scope.fetch` + `resultar-hono` (`createHonoApp` / `middleware`) across Tier 0 (singletons), Tier 1 (scoped sync), Tier 2 (scoped resource) | Pre-RFC baseline vs compiled DI vs raw `Hono` |
| `bench:typebox` | `requestJsonTypeBox` / schema decode on valid & invalid nested objects | `Compile(schema)` vs interpreted `Value.Check` |
| `bench:task-hot` | Reused `ResultTask` pipelines (5, 20, 50 steps: `map`, `andThen`, `catchTag`, `tap`) | Tiered JIT vs interpreter vs `effect` v4 |

### 9.3 Quantitative acceptance targets (Node.js v24+, Apple Silicon)

- **`bench:effect`**: Resultar beats `effect` v4 on **10/10** scenarios (closing the `0.93x`
  `TaggedError + catchTag` gap to **>= 1.5x faster**).
- **`bench:match`**: `Match.type().tagsExhaustive` within **<= 1.3x** of a hand-written `switch`
  statement (**>= 5x faster** than pre-RFC `Match`).
- **`bench:di-http`**: Tier 0 & Tier 1 `scope.fetch` / Hono middleware **>= 10x faster** than
  pre-RFC baseline, adding **< 2 µs** over raw Hono/Fetch.
- **`bench:typebox`**: Valid-payload TypeBox decode **>= 10x faster** than `Value.Check`.
- **Cold-start / one-shot regression gate**: `bench:task` (one-shot construction + single execution
  at 10..10,000 steps) and `bench:neverthrow` show **zero regressions** (<= 3% noise tolerance) and
  net improvement from Workstream A.

---

## 10. Phased delivery plan

### Phase 0 — Baseline & JIT foundation
- Capture current baselines across `bench:effect`, `bench:neverthrow`, `bench:task`, `bench:function`,
  plus new pre-optimization baselines for `bench:match`, `bench:di-http`, and `bench:typebox`.
- Implement `packages/resultar/src/core/jit.ts` with lazy capability probing, `RESULTAR_JIT=0`
  opt-out, safe literal escaping helpers, and unit tests.

### Phase 1 — Core V8 wins + `TaggedError`, `Match`, `TypeBox`, and `Config` JIT
- Deliver **Workstreams A, B, C, and F**.
- Zero public API changes; minimal risk; immediate 2x–50x gains on core primitives and validation.
- Validate dual-mode (`RESULTAR_JIT=1` and `RESULTAR_JIT=0`), `check:full`, `smoke:package`,
  `test:examples`, `test:docs`, `test:agents`, and update `benchmarks/README.md`.

### Phase 2 — Static DI graph specialization & HTTP JIT
- Deliver **Workstream D** across `resultar-di`, `resultar-hono`, `resultar-fastify`, and
  `resultar-nestjs`.
- Verify all lifetime, cycle, `locals`, abort, streaming response, and shutdown-rollback tests
  under both JIT and fallback modes.
- Publish `bench:di-http` results.

### Phase 3 — Tiered JIT for reusable `ResultTask` pipelines
- Deliver **Workstream E** in `packages/resultar/src/task/result-task.ts`.
- Stress-test with `fiber-stress.test.ts`, `task-scheduler.test.ts`, `scope-finalizer.test.ts`,
  `observability.test.ts`, and `bench:task-hot` + `bench:task` (ensuring zero one-shot regression).
- Evaluate whether a public `task.compile()` / `ResultTask.compile(task)` precompile API should be
  proposed as a minor addition or kept strictly internal.

---

## 11. Risks, trade-offs, and non-goals

### Risks & mitigations

| Risk | Mitigation |
| :--- | :--- |
| **CSP / Cloudflare Workers block `new Function`** | Lazy `try/catch` probe in `core/jit.ts` automatically falls back to optimized interpreted code; CI tests `RESULTAR_JIT=0` on every commit. |
| **Code injection via crafted tags/keys/templates** | Strict codegen invariants (§2.2): all user callbacks/values bound as factory params; primitive literals emitted solely via `JSON.stringify`; dedicated adversarial tests. |
| **Cold-start or one-shot latency regression** | Never JIT one-shot chains or `Match.value`; compile `ResultTask` lazily only on 2nd+ execution; guard with `bench:task` one-shot benchmarks. |
| **Memory leaks from cached compiled functions** | Attach compiled functions only to owning instances or `WeakMap`s; enforce max compilation size caps (`MAX_JIT_STEPS`, `MAX_JIT_CASES`, `MAX_JIT_NODES`). |
| **Harder stack traces in generated code** | Give generated functions descriptive names (e.g., `resultarMatchCompiled`, `resultarTaskCompiled`, `resultarDiDispatch`) and support `RESULTAR_JIT=0` for clean debugging. |
| **Breaking `"sideEffects": false` tree-shaking** | Zero top-level `new Function` probing; all capability detection is lazy on first compile call. |

### Non-goals

- **No custom HTTP server or router framework**: Resultar continues composing cleanly with Hono,
  Fastify, NestJS, Elysia, and native Web `fetch` rather than building a competing HTTP router.
- **No breaking v4 API or semantic changes**: lazy-vs-eager contracts, deprecated v4 shims
  ([docs/migrations/v4.md](../migrations/v4.md)), `Cause` structures, and LIFO scope guarantees
  remain unchanged.
- **No mandatory build plugin or macro transformer**: all optimizations work at plain TypeScript /
  JavaScript runtime with zero bundler lock-in.

---

## 12. Implementation record

All six workstreams (A–F) were implemented with zero public API changes, `"sideEffects": false`
preservation, strict codegen safety invariants, and automatic `RESULTAR_JIT=0` / CSP fallback.

### Delivered modules and tests

| Workstream | Delivered files | Targeted tests |
| :--- | :--- | :--- |
| **Core JIT foundation** | [packages/resultar/src/core/jit.ts](../../packages/resultar/src/core/jit.ts) | [packages/resultar/tests/jit-performance.test.ts](../../packages/resultar/tests/jit-performance.test.ts) |
| **Workstream A (V8 core)** | [packages/resultar/src/task/task-service.ts](../../packages/resultar/src/task/task-service.ts), [packages/resultar/src/core/pipe.ts](../../packages/resultar/src/core/pipe.ts), [packages/resultar/src/core/function.ts](../../packages/resultar/src/core/function.ts), [packages/resultar/src/core/dual.ts](../../packages/resultar/src/core/dual.ts), [packages/resultar/src/result/result-helpers.ts](../../packages/resultar/src/result/result-helpers.ts), [packages/resultar/src/result/result.ts](../../packages/resultar/src/result/result.ts), [packages/resultar/src/tagged/tagged-match.ts](../../packages/resultar/src/tagged/tagged-match.ts), [packages/resultar/src/task/result-task.ts](../../packages/resultar/src/task/result-task.ts) | Full `resultar` suite (72 files, 1,195 tests) in both `RESULTAR_JIT=1` and `RESULTAR_JIT=0` |
| **Workstream B (`createTaggedError`)** | [packages/resultar/src/tagged/tagged-error.ts](../../packages/resultar/src/tagged/tagged-error.ts) | [packages/resultar/tests/jit-performance.test.ts](../../packages/resultar/tests/jit-performance.test.ts), [packages/resultar/tests/tagged-error.test.ts](../../packages/resultar/tests/tagged-error.test.ts) |
| **Workstream C (`Match` JIT)** | [packages/resultar/src/match/match-jit.ts](../../packages/resultar/src/match/match-jit.ts), [packages/resultar/src/match/match.ts](../../packages/resultar/src/match/match.ts), [packages/resultar/src/match/match-pattern.ts](../../packages/resultar/src/match/match-pattern.ts) | [packages/resultar/tests/jit-performance.test.ts](../../packages/resultar/tests/jit-performance.test.ts), [packages/resultar/tests/match.test.ts](../../packages/resultar/tests/match.test.ts) |
| **Workstream D (`resultar-di` + Hono + Fastify + NestJS)** | [packages/di/src/jit.ts](../../packages/di/src/jit.ts), [packages/di/src/service.ts](../../packages/di/src/service.ts), [packages/di/src/module.ts](../../packages/di/src/module.ts), [packages/hono/src/middleware.ts](../../packages/hono/src/middleware.ts), [packages/fastify/src/fast-hooks.ts](../../packages/fastify/src/fast-hooks.ts), [packages/fastify/src/index.ts](../../packages/fastify/src/index.ts), [packages/nestjs/src/fast-request.ts](../../packages/nestjs/src/fast-request.ts), [packages/nestjs/src/index.ts](../../packages/nestjs/src/index.ts) | [packages/di/tests/jit.test.ts](../../packages/di/tests/jit.test.ts), [packages/fastify/tests/jit.test.ts](../../packages/fastify/tests/jit.test.ts), [packages/nestjs/tests/jit.test.ts](../../packages/nestjs/tests/jit.test.ts), full `resultar-di` (94 tests), `resultar-hono` (38 tests), `resultar-fastify` (56 tests) & `resultar-nestjs` (55 tests) in both modes |
| **Workstream E (`ResultTask` Tiered JIT)** | [packages/resultar/src/task/task-jit.ts](../../packages/resultar/src/task/task-jit.ts), [packages/resultar/src/task/result-task.ts](../../packages/resultar/src/task/result-task.ts) | [packages/resultar/tests/jit-performance.test.ts](../../packages/resultar/tests/jit-performance.test.ts), [packages/resultar/tests/result-task-mutation.test.ts](../../packages/resultar/tests/result-task-mutation.test.ts) |
| **Workstream F (`TypeBox` + `Config`)** | [packages/request-typebox/src/request-json-typebox.ts](../../packages/request-typebox/src/request-json-typebox.ts), [packages/config/src/index.ts](../../packages/config/src/index.ts) | [packages/request-typebox/tests/request-json-typebox.test.ts](../../packages/request-typebox/tests/request-json-typebox.test.ts), [packages/config/tests/config.test.ts](../../packages/config/tests/config.test.ts) |
| **Benchmarks** | [benchmarks/resultar-match.ts](../../benchmarks/resultar-match.ts), [benchmarks/resultar-di-http.ts](../../benchmarks/resultar-di-http.ts), [benchmarks/resultar-fastify-http.ts](../../benchmarks/resultar-fastify-http.ts), [benchmarks/resultar-nestjs-http.ts](../../benchmarks/resultar-nestjs-http.ts), [benchmarks/resultar-typebox.ts](../../benchmarks/resultar-typebox.ts), [benchmarks/resultar-task-hot.ts](../../benchmarks/resultar-task-hot.ts), [benchmarks/README.md](../../benchmarks/README.md) | Reproducible suites (`bench:match`, `bench:di-http`, `bench:fastify-http`, `bench:nestjs-http`, `bench:typebox`, `bench:task-hot`) |

### Measured performance gains (Node.js v26.13.1, Apple Silicon `darwin/arm64`)

All comparisons below were measured after the review regression fixes (removal of consumer-exposed iterator pooling in `OkResultIterator`/`ResultTaskIterator`, single-read Match JIT getter semantics, structural JSON DI cache keys, isolated-process Hono HTTP benchmarking with full body consumption, prototype metadata optimization on `createTaggedError`, and one-shot `OP_MAP`/`OP_CATCH_ALL`/`OP_CATCH_TAG` fast paths) against base commit `5629d83` (`effect@4.1.2`, `hono@4.13.19`).

| Benchmark | Baseline (`5629d83` or `JIT=0` / peer) | After (`JIT=1`) | Gain / Delta |
| :--- | ---: | ---: | :--- |
| `Match` nested object + array + guards (`bench:match`) | `17.49M op/s` (`5629d83`) / `18.55M` (`JIT=0`) | **`263.41M op/s`** (`3.80 ms` / 1M) | **15.06x** vs `5629d83` / **14.20x** vs `JIT=0` |
| `Match` 8-tag `tagsExhaustive` (`bench:match`) | `61.64M op/s` (`5629d83`) / `113.80M` (`JIT=0`) | **`252.85M op/s`** (`3.95 ms` / 1M) | **4.10x** vs `5629d83` / **2.22x** vs `JIT=0` / **1.72x** time of inline `switch` (`2.30 ms`) |
| Reused 10-step `ResultTask` (`bench:task-hot`) | `7.97M op/s` (`JIT=0`) / `3.18M` (`Effect` v4) | **`19.71M op/s`** | **2.47x** vs `JIT=0` / **6.20x** vs `Effect` v4 |
| Reused 50-step `ResultTask` (`bench:task-hot`) | `2.15M op/s` (`JIT=0`) / `898k` (`Effect` v4) | **`4.70M op/s`** | **2.18x** vs `JIT=0` / **5.23x** vs `Effect` v4 |
| Reused `catchTag + mapErr` (`bench:task-hot`) | `8.44M op/s` (`JIT=0`) / `3.42M` (`Effect` v4) | **`22.64M op/s`** | **2.68x** vs `JIT=0` / **6.62x** vs `Effect` v4 |
| `resultar-di` Tier 0 middleware + Hono (`bench:di-http`, body consumed) | `65,497 req/s` (`5629d83`, `15.27 µs`) | **`272,457 req/s`** (`3.67 µs`) | **4.16x** end-to-end (**+1.30 µs** over raw Hono `2.37 µs`; DI-only overhead **9.92x** lower) |
| `resultar-di` Tier 1 middleware + locals + Hono (`bench:di-http`, body consumed) | `41,018 req/s` (`5629d83`, `24.38 µs`) | **`235,191 req/s`** (`4.25 µs`) | **5.73x** end-to-end (**+1.88 µs** over raw Hono `2.37 µs`; DI-only overhead **11.71x** lower) |
| `resultar-di` Tier 0 / Tier 1 `createHonoApp` (`bench:di-http`, body consumed) | `86,084` / `46,461 req/s` (`5629d83`) | **`411,014` / `426,647 req/s`** (`2.43` / `2.34 µs`) | **4.77x** / **9.18x** end-to-end (**+0.07 µs** / **~0 µs** over raw Hono) |
| `resultar-di` direct 8-service `root.fetch` (`bench:di-http`, body consumed) | `28,951 req/s` (`5629d83`, `34.54 µs`) | **`444,781 req/s`** (`2.25 µs`) | **15.36x** vs `5629d83` / **1.17x** vs `JIT=0` |
| `resultar-fastify` Tier 0 singleton (`bench:fastify-http`) | `25,571 req/s` (`39.11 µs`) | **`44,419 req/s`** (`22.51 µs`) | **1.74x** (**95.3%** of raw Fastify; **16.1x** less DI overhead) |
| `resultar-fastify` Tier 1 scoped + locals (`bench:fastify-http`) | `20,846 req/s` (`47.97 µs`) | **`44,472 req/s`** (`22.49 µs`) | **2.13x** (**95.4%** of raw Fastify; **24.9x** less DI overhead) |
| `resultar-fastify` Tier 1 deep 8-service DAG (`bench:fastify-http`) | `16,641 req/s` (`60.09 µs`) | **`43,929 req/s`** (`22.76 µs`) | **2.64x** (**94.2%** of raw Fastify; **29.0x** less DI overhead) |
| `resultar-nestjs` Tier 0 singleton (`bench:nestjs-http`, `interceptor` / `guard`) | `24,141 req/s` (`41.42 µs`) | **`37,505`** / **`41,167 req/s`** (`26.66` / `24.29 µs`) | **1.55x** (**84.3%** of raw NestJS; **92.1%** with `requestHook: "guard"`) |
| `resultar-nestjs` Tier 1 scoped + locals (`bench:nestjs-http`) | `18,309 req/s` (`54.62 µs`) | **`36,636 req/s`** (`27.30 µs`) | **2.00x** (**82.0%** of raw NestJS; **6.3x** less DI overhead) |
| `resultar-nestjs` Tier 1 deep 8-service DAG (`bench:nestjs-http`) | `14,872 req/s` (`67.24 µs`) | **`37,290 req/s`** (`26.82 µs`) | **2.51x** (**83.4%** of raw NestJS; **9.9x** less DI overhead) |
| TypeBox `Compile(schema)` direct (`bench:typebox`) | `160,721 op/s` (`Value.Check`) | **`108.14M op/s`** | **672.87x** |
| `requestJsonTypeBoxTask` end-to-end (`bench:typebox`) | `107,641 op/s` (`JIT=0`) | **`375,337 op/s`** | **3.49x** |
| `bench:effect` (all 10/10 scenarios, `4,000` iters) | `TaggedError+catchTag`: `448k` (`Effect` v4) | **`719k`** (`±0.58%`; isolated repeats `1.54x`–`1.83x`) | Beats `Effect` v4 on **10/10** scenarios (**1.60x** on `TaggedError+catchTag`) |
| One-shot `ResultTask` chains (`10..10,000` steps vs `5629d83`) | `Run 100..10k andThen`: `1.98`–`358.7 µs` | **`1.71`–`333.1 µs`** | **+2.2% to +15.6% faster** on execution; `map` chains **-1.5% to +8.2%** |
| One-shot `Result`/`ResultTask` batched ops vs `5629d83` | `map on Ok` `6.17M` / `orElse on Err` `5.44M` | **`6.58M`** (`1.07x`) / **`6.67M`** (`1.23x`) | Net improvement across `ok`/`err`/`combine`/`map`/`andThen`/`orElse` |

### Quantitative target reconciliation and recorded deviations (§9.3)

- **Met targets**:
  - `bench:effect`: **10/10** scenarios won over `effect@4.1.2`, with `TaggedError + catchTag` at **1.60x** in the full suite (`1.54x`, `1.75x`, `1.83x` across 3 isolated repeats — above the `>= 1.5x` target).
  - `bench:di-http` added overhead: **+1.30 µs** (Tier 0 middleware), **+1.88 µs** (Tier 1 middleware), **+0.07 µs** (Tier 0 `createHonoApp`), **~0 µs** (Tier 1 `createHonoApp`) — all strictly **< 2 µs** over raw Hono (`2.37 µs`), and direct 8-service `root.fetch` reaches **15.36x** over `5629d83`.
  - `bench:typebox`: **672.87x** on direct validation (`>= 10x` target) and **3.49x** on end-to-end HTTP `requestJsonTypeBoxTask`.
  - CI dual-mode gate: `.github/workflows/ci.yaml` now runs both `RESULTAR_JIT=1 vp run check:full` and `RESULTAR_JIT=0 vp run test`.
- **Recorded deviations (accepted with rationale)**:
  1. **`bench:di-http` end-to-end ratio vs `5629d83` (`4.16x` Tier 0 / `5.73x` Tier 1 middleware; `4.77x` / `9.18x` `createHonoApp` vs `>= 10x` target)**: With full `Response.text()` body consumption, raw Hono + `new Request()` + `res.text()` sets an irreducible floor of `2.37 µs/req`. Because `5629d83` took `15.27 µs` (Tier 0 middleware), Amdahl's law caps the maximum possible end-to-end speedup at `15.27 / 2.37 = 6.44x` even with zero DI cost. Excluding the fixed Hono/Fetch floor, **DI-only overhead dropped by 9.92x (Tier 0) and 11.71x (Tier 1)** in middleware and **>100x** in `createHonoApp`, and DI-dominated 8-service `root.fetch` reached **15.36x**. Accepted without further API compromises.
  2. **`bench:match` 8-tag `tagsExhaustive` (`1.72x` time of inline `switch`, `4.10x` vs `5629d83` vs `<= 1.3x` / `>= 5x` target)**: Because `Match.tagsExhaustive` dispatches user-provided handler closures rather than inlining expressions inside `case` arms, even a hand-written `switch` calling the same 8 handler callbacks measures `~1.57x` the time of an inline-expression `switch` under V8 TurboFan inlining limits. The compiled `Match` matcher runs within `~1.05x` of a hand-written callback-dispatching `switch` and reaches **15.06x** over `5629d83` on nested object/array/guard patterns while preserving strict single-read getter semantics. Accepted without unsafe code-inlining hacks.
  3. **Pure construction-only `Build 100` / `Build 10,000` one-shot `ResultTask` chains (`+5.5%` / `+6.7%` vs `5629d83`)**: Storing tiered JIT metadata (`jitHits`, `jitExecutor`, `customExecute`) on `ResultTask` adds ~0.3 ns per allocated node on unexecuted construction-only loops while **improving** combined build+execute times (`Run 10..10,000 andThen` is **+2.2% to +15.6% faster** than `5629d83`). Accepted as a net win for real execution paths.
