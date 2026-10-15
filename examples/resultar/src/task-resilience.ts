import { Cause, Clock, Fiber, ResultTask, Retry, Semaphore, createTaggedError } from "resultar";

export class TaskProviderError extends createTaggedError({
  name: "TaskProviderError",
  message: "Task provider failed on attempt $attempt",
}) {}

export class TaskDeadlineError extends createTaggedError({
  name: "TaskDeadlineError",
  message: "Task exceeded its $milliseconds millisecond deadline",
}) {}

/** The same programs use Clock.live in production; virtual time keeps the cookbook deterministic. */
export const runTaskResilience = async () => {
  const clock = Clock.virtual(0, () => 0.5);
  const retryEvents: string[] = [];
  let attempts = 0;

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
      if (attempt < 3) return yield* ResultTask.err(new TaskProviderError({ attempt }));
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

  const retryRun = ResultTask.runResult(loadFromProvider, { clock });
  await clock.advanceBy(15);
  const retried = await retryRun;
  const retryElapsedMs = clock.now();

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
  const batchRun = ResultTask.runPromise(batch, { clock });
  await clock.advanceBy(4);
  const values = await batchRun;
  const record = await ResultTask.runPromise(
    ResultTask.all({
      count: ResultTask.ok(values.length),
      status: ResultTask.ok("complete"),
    }),
  );

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
  const timeoutRun = ResultTask.runResult(slowQuery, { clock });
  await clock.advanceBy(7);
  const timedOut = await timeoutRun;

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
  const raceRun = ResultTask.runPromise(
    ResultTask.raceFirst(replica("fast", 2), replica("slow", 20)),
    { clock },
  );
  await clock.advanceBy(3);
  const winner = await raceRun;

  const observed = await ResultTask.runPromise(
    ResultTask.gen(function* () {
      const fiber = yield* ResultTask.forkChild(ResultTask.ok("observed"));
      return yield* Fiber.await(fiber);
    }),
  );

  const background = ResultTask.runFork(ResultTask.sleep(2).as("background ready"), { clock });
  const backgroundExits: string[] = [];
  const unsubscribe = Fiber.addObserver(background, (exit) => backgroundExits.push(exit._tag));
  const backgroundWasRunning = Fiber.poll(background) === undefined;
  await clock.advanceBy(2);
  const backgroundExit = await ResultTask.runPromise(Fiber.await(background));
  unsubscribe();

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
  const semaphoreValues = await ResultTask.runPromise(
    ResultTask.all([guard, guard], { concurrency: "unbounded" }),
    { yieldEvery: 1 },
  );

  const cleanupLog: string[] = [];
  const sandboxedRecovery = await ResultTask.runPromise(
    ResultTask.err(new TaskProviderError({ attempt: 9 }))
      .ensuring(() =>
        ResultTask.sync(() => {
          cleanupLog.push("ensured");
        }),
      )
      .sandbox()
      .mapError(
        (cause): Cause<string> => ({
          _tag: "Fail",
          error: Cause.findError(cause).match({
            ok: (failure) => `recovered:${failure._tag}:${failure.attempt}`,
            err: () => "recovered:unknown",
          }),
        }),
      )
      .unsandbox()
      .orElse((label) => ResultTask.ok(label)),
  );

  const validatedErrors = await ResultTask.runResult(
    ResultTask.validateAll([1, 2, 3], (item) =>
      item % 2 === 0
        ? ResultTask.err(new TaskProviderError({ attempt: item }))
        : ResultTask.ok(item),
    ),
    { yieldEvery: 2 },
  );

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

