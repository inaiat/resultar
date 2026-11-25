import {
  Deferred,
  err,
  ok,
  ResultTask,
  ResultTaskCauseError,
  unit,
  type Cause,
  type Exit,
  type Result,
} from "resultar";

// Native lifecycle hooks erase provider error types while preserving every cause at runtime.
// resultar-check-disable-next-line no-unknown-result-error
export type RuntimeTask = ResultTask<void, unknown>;

export interface ServiceSession {
  readonly ready: Promise<Result<Readonly<Record<string, unknown>>, ResultTaskCauseError>>;
  readonly completion: Promise<Exit<void, unknown>>;
  readonly finish: () => Promise<Exit<void, unknown>>;
}

/** Bridges native lifecycle events to one live DI callback, without owning a second container. */
export function startSession(
  use: (hold: (services: Readonly<Record<string, unknown>>) => RuntimeTask) => RuntimeTask,
  signal?: AbortSignal,
): ServiceSession {
  const { promise: ready, resolve: resolveReady } =
    Promise.withResolvers<Result<Readonly<Record<string, unknown>>, ResultTaskCauseError>>();
  const done = Deferred.make<void>();
  const finish = (): void => {
    done.complete(ResultTask.fromResult(unit())).runSync();
  };
  const task = use((services) =>
    ResultTask.sync(() => {
      resolveReady(ok(services));
    }).andThen(() => done.await()),
  );
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted === true) finish();
  // runExit always fulfills with the complete outcome, including interruption and release failures.
  const completion = ResultTask.runExit(task, { signal }).then((exit) => {
    signal?.removeEventListener("abort", finish);
    if (exit._tag === "Failure") resolveReady(err(new ResultTaskCauseError(exit.cause)));
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
  if (cause._tag === "Sequential" || cause._tag === "Parallel")
    return hasFailure(cause.left) || hasFailure(cause.right);
  return true;
}
