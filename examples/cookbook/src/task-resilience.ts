/**
 * Structured Concurrency, Fibers, Semaphores, Clocks & Cause Trees (`ResultTask`)
 *
 * This module demonstrates `ResultTask` resilience features:
 * - Deterministic testing with `Clock.virtual`
 * - Scoped resource acquisition (`ResultTask.scoped`, `ResultTask.acquireRelease`)
 * - Retries (`Retry.policy`), timeouts (`.timeout`), and bounded concurrency (`ResultTask.forEach`)
 * - Racing (`ResultTask.raceFirst`, `ResultTask.race`) with automatic loser interruption
 * - Child and root fibers (`ResultTask.forkChild`, `task.runFork()`, `Fiber.await`,
 *   `Fiber.join`, `Fiber.interrupt`, `Fiber.poll`, `Fiber.addObserver`)
 * - Concurrency limiting (`Semaphore.make`, `withPermit`, `withPermits`)
 * - Lossless failure trees (`Cause`, `sandbox`, `unsandbox`, `catchCause`, `inspectCause`, `onExit`)
 * - Cooperative scheduling (`Scheduler`, `ResultTask.yieldNow`, `yieldEvery`)
 */
import {
  Cause,
  Clock,
  Fiber,
  ResultTask,
  Retry,
  Scheduler,
  Semaphore,
  createTaggedError,
  type TaskScheduler,
} from "resultar";

export class TaskProviderError extends createTaggedError({
  name: "TaskProviderError",
  message: "Task provider failed on attempt $attempt",
}) {}

export class TaskDeadlineError extends createTaggedError({
  name: "TaskDeadlineError",
  message: "Task exceeded its $milliseconds millisecond deadline",
}) {}

/**
 * Runs the core `ResultTask` resilience showcase using `Clock.virtual` for
 * deterministic, zero-wait execution. The same programs use `Clock.live` in production.
 */
export const runTaskResilience = async () => {
  const clock = Clock.virtual(0, () => 0.5);
  const retryEvents: string[] = [];
  let attempts = 0;

  // 1. Scoped resource + Retry.policy: each retry attempt opens and closes its own scope cleanly.
  const loadFromProvider = ResultTask.scoped(
    ResultTask.gen(function* () {
      const attempt = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempts += 1;
          retryEvents.push(`open:${attempts}`);
          return attempts;
        }),
        release: (current) =>
          ResultTask.sync(() => {
            retryEvents.push(`close:${current}`);
          }),
      });
      if (attempt < 3) return yield* TaskProviderError.taskErr({ attempt });
      return "ready";
    }),
  ).retry(
    Retry.policy<TaskProviderError>({
      times: 2,
      delayMs: 5,
      backoff: 2,
      jittered: 0.2,
      while: (error) => TaskProviderError.is(error),
    }),
  );

  const retryRun = loadFromProvider.runResult({ clock });
  await clock.advanceBy(15);
  const retried = await retryRun;
  const retryElapsedMs = clock.now();

  // 2. Bounded concurrency (`concurrency: 2`) with `ResultTask.forEach` and `ResultTask.all`.
  let active = 0;
  let maxConcurrency = 0;
  const batch = ResultTask.forEach(
    [1, 2, 3],
    (value) =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              active += 1;
              maxConcurrency = Math.max(maxConcurrency, active);
            }),
            release: () =>
              ResultTask.sync(() => {
                active -= 1;
              }),
          });
          yield* ResultTask.sleep(4 - value);
          return value * 2;
        }),
      ),
    { concurrency: 2 },
  );
  const batchRun = batch.runPromise({ clock });
  await clock.advanceBy(4);
  const values = await batchRun;
  const record = await ResultTask.all({
    count: ResultTask.ok(values.length),
    status: ResultTask.ok("complete"),
  }).runPromise();

  // 3. `.timeout()` interrupts the hung promise (`interruption: "detach"`) and runs scope finalizers.
  const timeoutEvents: string[] = [];
  const slowQuery = ResultTask.scoped(
    ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok("connection"),
        release: (connection) =>
          ResultTask.sleep(2).map(() => {
            timeoutEvents.push(`close:${connection}`);
          }),
      });
      return yield* ResultTask.tryPromise({
        try: () => new Promise<string>(() => {}),
        catch: (cause) => new TaskProviderError({ attempt: 1, cause }),
        interruption: "detach",
      });
    }),
  ).timeout(5, () => new TaskDeadlineError({ milliseconds: 5 }));
  const timeoutRun = slowQuery.runResult({ clock });
  await clock.advanceBy(7);
  const timedOut = await timeoutRun;

  // 4. `ResultTask.raceFirst` interrupts the slower branch and awaits its finalizer before returning.
  const raceEvents: string[] = [];
  const replica = (name: string, milliseconds: number) =>
    ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.ok(name),
          release: (resource) =>
            ResultTask.sleep(name === "fast" ? 0 : 1).map(() => {
              raceEvents.push(`close:${resource}`);
            }),
        });
        yield* ResultTask.sleep(milliseconds);
        return name;
      }),
    );
  const raceRun = ResultTask.raceFirst(replica("fast", 2), replica("slow", 20)).runPromise({
    clock,
  });
  await clock.advanceBy(3);
  const winner = await raceRun;

  // 5. Structured child fiber (`ResultTask.forkChild` + `Fiber.await`) and root fiber (`runFork`).
  const observed = await ResultTask.gen(function* () {
    const fiber = yield* ResultTask.forkChild(ResultTask.ok("observed"));
    return yield* Fiber.await(fiber);
  }).runPromise();

  const background = ResultTask.sleep(2).as("background ready").runFork({ clock });
  const backgroundExits: string[] = [];
  const unsubscribe = Fiber.addObserver(background, (exit) => backgroundExits.push(exit._tag));
  const backgroundWasRunning = Fiber.poll(background) === undefined;
  await clock.advanceBy(2);
  const backgroundExit = await Fiber.await(background).runPromise();
  unsubscribe();

  // 6. `Semaphore.make(1)` serializes access to a critical section across concurrent tasks.
  const semaphore = Semaphore.make(1);
  const semaphoreEvents: string[] = [];
  const guard = semaphore.withPermit(
    ResultTask.gen(function* () {
      semaphoreEvents.push("enter");
      yield* ResultTask.sync(() => undefined);
      semaphoreEvents.push("exit");
      return "permit-ok";
    }),
  );
  const semaphoreValues = await ResultTask.all([guard, guard], {
    concurrency: "unbounded",
  }).runPromise({ yieldEvery: 1 });

  // 7. `.ensuring()`, `.sandbox()`, `Cause.findError`, and `.unsandbox()` for lossless Cause recovery.
  const cleanupLog: string[] = [];
  const sandboxedRecovery = await ResultTask.err(new TaskProviderError({ attempt: 9 }))
    .ensuring(() =>
      ResultTask.sync(() => {
        cleanupLog.push("ensured");
      }),
    )
    .sandbox()
    .mapErr((cause): Cause<string> => ({
      _tag: "Fail",
      error: Cause.findError(cause).match({
        ok: (failure) => `recovered:${failure._tag}:${failure.attempt}`,
        err: () => "recovered:unknown",
      }),
    }))
    .unsandbox()
    .orElse((label) => ResultTask.ok(label))
    .runPromise();

  // 8. `ResultTask.validateAll` accumulates all errors across items.
  const validatedErrors = await ResultTask.validateAll([1, 2, 3], (item) =>
    item % 2 === 0 ? ResultTask.err(new TaskProviderError({ attempt: item })) : ResultTask.ok(item),
  ).runResult({ yieldEvery: 2 });

  return {
    retry: {
      attempts,
      elapsedMs: retryElapsedMs,
      events: retryEvents,
      value: retried.match({ ok: (value) => value, err: (error) => error._tag }),
    },
    batch: { maxConcurrency, record, values },
    timeout: {
      events: timeoutEvents,
      tag: timedOut.match({ ok: () => "unexpected-success", err: (error) => error._tag }),
    },
    race: { events: raceEvents, winner },
    fiber: observed,
    rootFiber: { wasRunning: backgroundWasRunning, events: backgroundExits, exit: backgroundExit },
    semaphore: { events: semaphoreEvents, values: semaphoreValues },
    sandbox: { cleanup: cleanupLog, value: sandboxedRecovery },
    validation: validatedErrors.match({
      ok: (items) => items.map(String),
      err: (errors) => errors.map((e) => `${e._tag}:${e.attempt}`),
    }),
    pendingTimers: clock.pending,
  };
};

/**
 * Demonstrates additional `ResultTask` concurrency and diagnostic primitives:
 * - `ResultTask.race` (succeeds with the first `Ok`, ignoring a faster `Err` while the peer is running)
 * - `Fiber.join` (with `{ interruption: "detach" }`) and `Fiber.interrupt`
 * - `Semaphore.withPermits(n)` for multi-permit acquisition
 * - `.onExit()`, `.inspectCause()`, and `.catchCause()`
 * - `Cause` inspection helpers (`isCause`, `hasFails`, `hasDies`, `hasInterrupts`, `failures`, `defects`, `pretty`)
 * - Cooperative yielding (`ResultTask.yieldNow`, custom `TaskScheduler`, `Scheduler.live`)
 * - Explicit task runners and native Promise interoperability with `runPromise`
 */
export const runAdvancedTaskResilience = async () => {
  const clock = Clock.virtual(0);
  const lifecycleEvents: string[] = [];

  // 1. `ResultTask.race` waits for the first `Ok` winner when a faster branch fails with `Err`.
  const fastFail = ResultTask.sleep(1).andThen(() =>
    ResultTask.err(new TaskProviderError({ attempt: 1 })),
  );
  const slowOk = ResultTask.sleep(3).as("backup-winner" as const);
  const raceOkRun = ResultTask.race(fastFail, slowOk).runPromise({ clock });
  await clock.advanceBy(3);
  const raceOkWinner = await raceOkRun;

  // 2. `Fiber.join` and `Fiber.interrupt` on child fibers.
  const fiberWorkflow = ResultTask.gen(function* () {
    const worker = yield* ResultTask.forkChild(ResultTask.ok("joined-value" as const));
    const joined = yield* Fiber.join(worker, { interruption: "detach" });

    const longRunning = yield* ResultTask.forkChild(
      ResultTask.sleep(100).as("never-finishes" as const),
    );
    const interruptedExit = yield* Fiber.interrupt(longRunning);

    return {
      interruptedTag: interruptedExit._tag,
      joined,
    };
  }).onExit((exit) => {
    lifecycleEvents.push(`fiberWorkflow:${exit._tag}`);
  });
  const fiberResult = await fiberWorkflow.runPromise({ clock });

  // 3. `Semaphore.withPermits(2)` acquires multiple permits atomically.
  const pool = Semaphore.make(2);
  const multiPermitValue = await pool
    .withPermits(2, ResultTask.ok("two-permits-acquired" as const))
    .runPromise();

  // 4. `.inspectCause()`, `.catchCause()`, and `Cause` tree inspection helpers.
  const causeEvents: string[] = [];
  const compositeCause: Cause<TaskProviderError> = {
    _tag: "Sequential",
    left: { _tag: "Fail", error: new TaskProviderError({ attempt: 1 }) },
    right: { _tag: "Die", defect: "unexpected-defect" },
  };

  const causeDiagnostics = {
    defects: Cause.defects(compositeCause),
    failures: Cause.failures(compositeCause).map((e) => e._tag),
    hasDies: Cause.hasDies(compositeCause),
    hasFails: Cause.hasFails(compositeCause),
    hasInterrupts: Cause.hasInterrupts(compositeCause),
    isCause: Cause.isCause(compositeCause),
    prettyIncludesFail: Cause.pretty(compositeCause).includes("TaskProviderError"),
  };

  const recoveredFromCause = await ResultTask.err(new TaskProviderError({ attempt: 4 }))
    .inspectCause((cause) => {
      causeEvents.push(`inspectCause:${Cause.hasFails(cause)}`);
    })
    .catchCause((cause) =>
      ResultTask.ok(
        `caught:${Cause.failures(cause)
          .map((e) => e.attempt)
          .join(",")}`,
      ),
    )
    .runPromise();

  // 5. Custom `TaskScheduler` (`yieldEvery: 1`) and explicit execution / Promise interoperability.
  let schedulerYields = 0;
  const countingScheduler: TaskScheduler = {
    yield: (signal) => {
      schedulerYields += 1;
      return Scheduler.live.yield(signal);
    },
  };

  const yieldedValue = await ResultTask.gen(function* () {
    const step1 = yield* ResultTask.ok("step-1" as const);
    const step2 = yield* ResultTask.ok(`${step1}->after-yield` as const);
    return step2;
  }).runPromise({ scheduler: countingScheduler, yieldEvery: 1 });

  // Run tasks explicitly; `runPromise` starts one execution and returns a native Promise.
  const explicitlyRun = await ResultTask.ok("direct-await" as const).runPromise();
  const promiseInterop = await ResultTask.ok("promise-interop" as const)
    .runPromise()
    .then((value) => value);

  return {
    awaitedDirectly: explicitlyRun,
    promiseInterop,
    causeDiagnostics,
    causeEvents,
    fiberResult,
    lifecycleEvents,
    multiPermitValue,
    raceOkWinner,
    recoveredFromCause,
    schedulerYields,
    yieldedValue,
  };
};
