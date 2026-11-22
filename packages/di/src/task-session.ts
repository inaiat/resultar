import {
  Cause,
  Deferred,
  err,
  ResultTask,
  ResultTaskCauseError,
  unit,
  type Result,
} from "resultar";

/** A running application task whose resources remain owned until close. */
export interface ServiceTaskSession {
  readonly ready: Promise<Result<void, ResultTaskCauseError>>;
  readonly close: () => Promise<Result<void, ResultTaskCauseError>>;
}

/** Low-level adapter bridge. Bind the task with the application's existing useSingletons scope. */
export function startServiceTask(
  use: (task: ResultTask<void, unknown, unknown>) => ResultTask<void, unknown>,
  startup: ResultTask<void, unknown, unknown>,
): ServiceTaskSession {
  const { promise: ready, resolve: resolveReady } =
    Promise.withResolvers<Result<void, ResultTaskCauseError>>();
  const done = Deferred.make<void>();
  const controller = new AbortController();
  let initialized = false;
  let completed = false;
  let closing: Promise<Result<void, ResultTaskCauseError>> | undefined = undefined;
  const task = ResultTask.gen(function* runApplicationTask() {
    return yield* use(
      startup.andThen(() => {
        initialized = true;
        resolveReady(unit());
        return done.await();
      }),
    );
  });
  const completion = Promise.resolve()
    .then(() => ResultTask.runExit(task, { signal: controller.signal }))
    .then((exit) => {
      completed = true;
      if (exit._tag === "Failure") resolveReady(err(new ResultTaskCauseError(exit.cause)));
      return exit;
    });
  return {
    ready,
    close: () => {
      if (closing !== undefined) return closing;
      // Initialization failures (including its rollback) were already reported by ready.
      const reported = completed && !initialized;
      if (!initialized && !completed) controller.abort();
      done.succeed(undefined).runSync();
      closing = completion.then((exit) =>
        exit._tag === "Failure" && !reported && !Cause.isInterruptedOnly(exit.cause)
          ? err(new ResultTaskCauseError(exit.cause))
          : unit(),
      );
      return closing;
    },
  };
}
