import {
  fromSafePromise,
  ResultAsync,
  ResultTask,
  ResultTaskCauseError,
  type Cause,
  type Exit,
  type ResultAsyncCallbackContext,
} from "resultar";

// Native lifecycle hooks erase provider error types while preserving every cause at runtime.
// resultar-check-disable-next-line no-unknown-result-error
export type RuntimeTask = ResultTask<void, unknown>;

export interface ServiceSession {
  readonly ready: ResultAsync<Readonly<Record<string, unknown>>, ResultTaskCauseError>;
  readonly completion: ResultAsync<Exit<void, unknown>, never>;
  readonly finish: () => ResultAsync<Exit<void, unknown>, never>;
}

const sessionError = (cause: unknown): ResultTaskCauseError =>
  cause instanceof ResultTaskCauseError
    ? cause
    : new ResultTaskCauseError({ _tag: "Die", defect: cause });

/** Bridges native lifecycle events to one live DI callback, without owning a second container. */
export function startSession(
  use: (hold: (services: Readonly<Record<string, unknown>>) => RuntimeTask) => RuntimeTask,
  signal?: AbortSignal,
): ServiceSession {
  // fromCallback subscribes immediately; neither signal owns a separate execution or scope.
  // eslint-disable-next-line init-declarations
  let readiness!: ResultAsyncCallbackContext<Readonly<Record<string, unknown>>>;
  const ready = ResultAsync.fromCallback({
    subscribe: (context: typeof readiness) => {
      readiness = context;
    },
    catch: sessionError,
  }).mapErr(sessionError);
  // Initialized synchronously by the subscription below.
  // eslint-disable-next-line init-declarations
  let finish!: () => void;
  const finished = ResultAsync.fromCallback<void, ResultTaskCauseError>({
    subscribe: ({ resolve }) => {
      finish = () => resolve();
    },
    catch: sessionError,
  }).mapErr(sessionError);
  const task = use((services) =>
    ResultTask.sync(() => readiness.resolve(services)).flatMap(() =>
      ResultTask.fromResultAsync(() => finished),
    ),
  );
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted === true) finish();
  // runExit always fulfills with the complete outcome, including interruption and release failures.
  const completion = fromSafePromise(ResultTask.runExit(task, { signal })).map((exit) => {
    signal?.removeEventListener("abort", finish);
    if (exit._tag === "Failure") readiness.reject(new ResultTaskCauseError(exit.cause));
    return exit;
  });
  return {
    ready,
    completion,
    finish: () => {
      finish();
      return completion;
    },
  };
}

export function hasFailure(cause: Cause<unknown>): boolean {
  if (cause._tag === "Interrupt") return false;
  if (cause._tag === "Sequential") return hasFailure(cause.left) || hasFailure(cause.right);
  return true;
}
