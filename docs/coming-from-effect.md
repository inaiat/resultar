# Coming from Effect

This guide maps Effect core concepts and APIs to **Resultar** so teams evaluating or migrating from Effect can orient quickly.

## Why teams choose Resultar

- **Zero-ceremony core**: `Result<T, E>` (sync) and `ResultTask<A, E, R>` (lazy async + typed DI + scopes) cover day-to-day backend and library work without a monolithic standard library, plus an opt-in `resultar/async` compatibility subpath for legacy eager `ResultAsync`.
- **Native JavaScript idioms**: real `Error` subclasses (`createTaggedError` with `$variable` interpolation, `.fingerprint`, `.findCause`, and `redact()`), native `AbortSignal` / `AbortError` cancellation, `Promise` interoperability, and zero-runtime-overhead TypeScript inference.
- **Fine-grained tree-shaking**: `"sideEffects": false` across all library packages plus dedicated subpaths (`resultar/result`, `resultar/task`, `resultar/async`, `resultar/match`, `resultar/tagged`, `resultar/retry`, `resultar/function`).
- **Opt-in observability**: `Tracer.noop` by default with zero runtime overhead; attach `Tracer.memory()` or a custom `TaskTracer` (e.g. OpenTelemetry adapter) per run via `{ tracer }`, named `ResultTask.fn('span', ...)`, `task.withSpan('span')`, and `TaskLocal`.
- **Native Go static analyzer (`resultar-check`)**: 43 semantic TypeScript-Go rules catching accidental `await task` (`no-await-result-task`), unhandled results, `Promise<ResultTask<...>>` leaks, leaked scopes, and anti-patterns — with `--fix` for safe corrections, `migrate-v5`, LSP, and Zed/VS Code/Cursor setup.

## Concept & API mapping

| Effect                                                                   | Resultar                                                                                                                                     | Notes                                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Effect.Effect<A, E, R>`                                                 | `ResultTask<A, E, R>`                                                                                                                        | Lazy, replayable, typed `A`, `E`, `R`, cooperative interruption                                                                             |
| `Either` / sync `Effect`                                                 | `Result<T, E>` (`ok`, `err`)                                                                                                                 | Pure synchronous result; zero async overhead                                                                                                |
| `Effect.succeed` / `Effect.fail`                                         | `ResultTask.ok` / `ResultTask.err`                                                                                                           | Also `ok` / `err` for sync `Result`                                                                                                         |
| `Effect.sync` / `Effect.try`                                             | `ResultTask.sync` / `ResultTask.try`                                                                                                         | `ResultTask.tryPromise` or `ResultTask.try` for async                                                                                       |
| `Effect.suspend`                                                         | `ResultTask.suspend`                                                                                                                         | Defers task construction until execution                                                                                                    |
| `Effect.gen(function* () { ... })`                                       | `ResultTask.gen(function* () { ... })`                                                                                                       | Also `Result.gen` for sync; `yield*` works on `ResultTask`, `Result`, `ServiceTag`                                                          |
| `Effect.fn("span")(function* (x) { ... })`                               | `ResultTask.fn("span", function* (x) { ... }, ...pipes)`                                                                                     | Named span + trailing pipes (0–4 pipe stages)                                                                                               |
| `Effect.withSpan("name", { attributes })`                                | `task.withSpan("name", attributes)` / `ResultTask.withSpan("name", attributes)`                                                              | Passes `attributes` directly; attaches logical span trace to failure `Cause` even without a tracer; emits spans when `{ tracer }` is passed |
| `Effect.die` / `Effect.interrupt`                                        | `Cause.die` / `Cause.interrupt` (and `ResultTask.never()` for interruptible wait)                                                            | Throwing inside `ResultTask.sync` produces a `Die` defect; `AbortSignal` / `Fiber.interrupt` produces `Interrupt`                           |
| `Effect.runSync` / `Effect.runSyncExit`                                  | `task.runSync()` / `task.runSyncExit()`                                                                                                      | `runSync()` returns `Result<A, E>` synchronously (throws `Error` if async/defect/interrupt); `runSyncExit()` returns `Exit<A, E>`           |
| `Effect.runPromise` / `Effect.runPromiseExit`                            | `task.runPromise()` / `task.runExit()`                                                                                                       | Plus `task.runResult()` returning native `Promise<Result<A, E>>`                                                                            |
| `Effect.runFork` / `Effect.forkChild` / `Fiber.join` / `Fiber.await`     | `task.runFork()` / `task.forkChild()` / `Fiber.join` / `fiber.await()`                                                                       | Structured concurrency; `forkChild` binds to enclosing `ResultTaskScope`                                                                    |
| `Effect.all` / `Effect.forEach`                                          | `ResultTask.all` / `ResultTask.forEach`                                                                                                      | Supports `{ concurrency }` and `{ discard: true }`                                                                                          |
| `Effect.race` / `Effect.raceAll` / `Effect.raceFirst`                    | `ResultTask.race` / `ResultTask.raceAll` / `ResultTask.raceFirstAll`                                                                         | `race`/`raceAll` return first success; `raceFirst`/`raceFirstAll` return first settlement; losers are interrupted                           |
| `Effect.timeoutFail`                                                     | `task.timeout(ms, onTimeout)` / `ResultTask.timeout(task, ms, onTimeout)`                                                                    | Cooperative cancellation of timed-out work with typed timeout error                                                                         |
| `Effect.retry(schedule)`                                                 | `task.retry(Retry.policy({ times, delayMs, backoff, maxDelayMs, maxElapsedMs, jittered, while, onRetry }))`                                  | Supports error-aware `delayMs: (ctx, err) => number` and total elapsed budget                                                               |
| `Effect.repeat(schedule)`                                                | `task.repeat({ times, delayMs, backoff, maxDelayMs, maxElapsedMs, jittered, while, until, onRepeat })`                                       | Also static/curried `ResultTask.repeat(...)`                                                                                                |
| `Effect.acquireRelease` / `Effect.scoped`                                | `ResultTask.acquireRelease` / `task.scoped()` / `ResultTask.scoped`                                                                          | LIFO finalizers even on failure or interruption; `ResultTaskScope` tracked in `R`                                                           |
| `Cause` (`fail`, `die`, `interrupt`, `sequential`, `parallel`, `pretty`) | `Cause.fail`, `Cause.die`, `Cause.interrupt`, `Cause.sequential`, `Cause.parallel`, `Cause.isInterruptedOnly`, `Cause.spans`, `Cause.pretty` | Structured failure tree with logical span traces attached automatically inside `withSpan` / named `fn`                                      |
| `Exit` (`Success` / `Failure`)                                           | `type Exit<A, E>` (`{ _tag: 'Success'; value: A } \| { _tag: 'Failure'; cause: Cause<E> }`)                                                  | Discriminated union returned by `runExit()`, `runSyncExit()`, and `fiber.await()`                                                           |
| `Ref.make`                                                               | `Ref.make(initial)`                                                                                                                          | Atomic mutable state (`get`, `set`, `update`, `updateAndGet`, `getAndUpdate`, `getAndSet`, `modify`)                                        |
| `Deferred.make`                                                          | `Deferred.make<A, E>()`                                                                                                                      | One-shot async synchronization (`await`, `succeed`, `fail`, `die`, `done`, `complete`, `poll`, `isDone`)                                    |
| `Queue.bounded` / `Queue.unbounded`                                      | `Queue.bounded<A>(capacity)` / `Queue.unbounded<A>()`                                                                                        | FIFO backpressure, interruption-safe waiters, lossless shutdown draining                                                                    |
| `FiberRef` / `ServiceMap.Reference`                                      | `TaskLocal.make(defaultValue, name?)`                                                                                                        | Fiber-inherited ambient context (`get()`, `set(v)`, `update(fn)`, `locally`, `locallyWith`)                                                 |
| `TestClock`                                                              | `Clock.virtual()`                                                                                                                            | `advanceBy(ms)`, `advanceToNext()`, `runToCompletion(task, { maxSteps })`                                                                   |
| `Context.Tag` / `Layer`                                                  | `serviceTag` + `resultar-di` (`service`, `resource`, `Service`, `createModule`)                                                              | Composable typed DI with singleton/scoped/transient lifetimes (`module.use`, `module.scope`, `provideService`)                              |
| `Config`                                                                 | `resultar-config`                                                                                                                            | Declarative env/config loading with redaction and typed errors                                                                              |
| `Data.TaggedError`                                                       | `createTaggedError`                                                                                                                          | Real `Error` subclasses with `$var` interpolation, `.fingerprint` tuple, `.findCause`, `redact()`                                           |
| `Match`                                                                  | `Match` (`resultar/match`)                                                                                                                   | Exhaustive pattern matching (`Match.value`, `Match.type`, `Match.valueTags`, `Match.typeTags`, `Match.fn`)                                  |
| `Redacted`                                                               | `redact` / `isRedacted` / `revealRedacted`                                                                                                   | Safe `<redacted>` / `<redacted:label>` formatting in errors and JSON                                                                        |

## Side-by-side workflow example

```ts
import {
  Clock,
  createTaggedError,
  ResultTask,
  Retry,
  serviceTag,
  TaskLocal,
  Tracer,
} from "resultar";

class RepoError extends createTaggedError({
  name: "RepoError",
  message: "Failed to load user $id",
}).withProps<{ readonly id: string; readonly retryable: boolean }>() {}

interface UserRepo {
  readonly findById: (
    id: string,
  ) => ResultTask<{ readonly id: string; readonly name: string }, RepoError>;
}
const UserRepo = serviceTag<UserRepo>("UserRepo");
const RequestId = TaskLocal.make("anonymous", "requestId");

const retryTransient = Retry.policy<RepoError>({
  times: 3,
  delayMs: (ctx, err) => (err.retryable ? 50 * 2 ** (ctx.attempt - 1) : 0),
  maxDelayMs: 500,
  maxElapsedMs: 2_000,
  while: (err) => err.retryable,
});

export const loadUser = ResultTask.fn(
  "users.load",
  function* (id: string) {
    const repo = yield* UserRepo;
    const reqId = yield* RequestId.get();
    return yield* repo.findById(id).withSpan("users.repo.find", {
      "user.id": id,
      "request.id": reqId,
    });
  },
  ResultTask.retry(retryTransient),
);

// Deterministic test with virtual clock + in-memory tracer:
const clock = Clock.virtual();
const tracer = Tracer.memory();
const runnable = RequestId.locally("req-42", loadUser("u-1")).provideService(UserRepo, {
  findById: (id) => ResultTask.ok({ id, name: "Ada" }),
});
const exit = await runnable.runExit({ clock, tracer });
// Or drive multi-step retries / sleeps automatically without manual ticking:
const autoExit = await clock.runToCompletion(runnable);
```

## Deliberate omissions (what Resultar does _not_ aim to replace)

Resultar intentionally stays lean rather than re-implementing every ecosystem library:

- **No built-in schema library**: pair `resultar` with Zod (`resultar-request-zod`), TypeBox (`resultar-request-typebox`), Valibot, or ArkType at your boundaries.
- **No stream algebra / STM / distributed cluster runtime**: use Node/Web `AsyncIterable` / `ReadableStream` or dedicated queue/workflow libraries alongside `Queue`, `Deferred`, and `Ref`.
- **No custom HTTP server framework**: integrate cleanly into Fastify (`resultar-fastify`), Hono (`resultar-hono`), or NestJS (`resultar-nestjs`).
- **No mandatory global runtime**: every `ResultTask` runs with standard `runResult()` / `runPromise()` / `runExit()` / `runSync()`, and `Result<T, E>` runs completely synchronously with zero task runtime overhead.

## Recommended next reads

- [Full documentation](../DOCUMENTATION.md)
- [Gradual adoption guide](gradual-adoption.md)
- [Core package README](../packages/resultar/README.md)
- [Static analyzer (`resultar-check`)](../packages/check/README.md)
- [Dependency injection (`resultar-di`)](../packages/di/README.md)
