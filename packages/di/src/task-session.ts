import {
  err,
  fromSafePromise,
  ResultAsync,
  ResultTask,
  ResultTaskCauseError,
  unit,
  type Cause,
  type ResultAsyncCallbackContext,
} from "resultar";

/** A running application task whose resources remain owned until close. */
export interface ServiceTaskSession {
  readonly ready: ResultAsync<void, ResultTaskCauseError>;
  readonly close: () => ResultAsync<void, ResultTaskCauseError>;
}

const sessionError = (defect: unknown): ResultTaskCauseError =>
  defect instanceof ResultTaskCauseError
    ? defect
    : new ResultTaskCauseError({ _tag: "Die", defect });

function interruptedOnly(cause: Cause<unknown>): boolean {
  return (
    cause._tag === "Interrupt" ||
    (cause._tag === "Sequential" && interruptedOnly(cause.left) && interruptedOnly(cause.right))
  );
}

/** Low-level adapter bridge. Bind the task with the application's existing useSingletons scope. */
export function startServiceTask(
  use: (task: ResultTask<void, unknown, unknown>) => ResultTask<void, unknown>,
  startup: ResultTask<void, unknown, unknown>,
): ServiceTaskSession {
  // Subscriptions run synchronously; these gates do not create another DI container.
  // eslint-disable-next-line init-declarations
  let readiness!: ResultAsyncCallbackContext<void>;
  const ready = ResultAsync.fromCallback<void, ResultTaskCauseError>({
    subscribe: (context) => {
      readiness = context;
    },
    catch: sessionError,
  }).mapErr(sessionError);
  // eslint-disable-next-line init-declarations
  let finish!: () => void;
  const finished = ResultAsync.fromCallback<void, ResultTaskCauseError>({
    subscribe: ({ resolve }) => {
      finish = () => resolve();
    },
    catch: sessionError,
  });
  const controller = new AbortController();
  let initialized = false;
  let completed = false;
  let closing: ResultAsync<void, ResultTaskCauseError> | undefined = undefined;
  const task = ResultTask.gen(function* runApplicationTask() {
    return yield* use(
      startup.flatMap(() => {
        initialized = true;
        readiness.resolve();
        return ResultTask.fromResultAsync(() => finished);
      }),
    );
  });
  const completion = fromSafePromise(ResultTask.runExit(task, { signal: controller.signal })).map(
    (exit) => {
      completed = true;
      if (exit._tag === "Failure") readiness.reject(new ResultTaskCauseError(exit.cause));
      return exit;
    },
  );
  return {
    ready,
    close: () => {
      if (closing !== undefined) return closing;
      // Initialization failures (including its rollback) were already reported by ready.
      const reported = completed && !initialized;
      if (!initialized && !completed) controller.abort();
      finish();
      closing = completion.andThen((exit) =>
        exit._tag === "Failure" && !reported && !interruptedOnly(exit.cause)
          ? err(new ResultTaskCauseError(exit.cause))
          : unit(),
      );
      return closing;
    },
  };
}
