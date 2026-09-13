import { ResultTask, ResultTaskCauseError, type Cause, type Exit } from "resultar";

// Native lifecycle hooks erase provider error types while preserving every cause at runtime.
// resultar-check-disable-next-line no-unknown-result-error
export type RuntimeTask = ResultTask<void, unknown>;

export interface ServiceSession {
  readonly ready: Promise<Readonly<Record<string, unknown>>>;
  readonly completion: Promise<Exit<void, unknown>>;
  readonly finish: () => Promise<Exit<void, unknown>>;
}

/** Bridges native lifecycle events to one live DI callback, without owning a second container. */
export function startSession(
  use: (hold: (services: Readonly<Record<string, unknown>>) => RuntimeTask) => RuntimeTask,
  signal?: AbortSignal,
): ServiceSession {
  const ready = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  const finished = Promise.withResolvers<void>();
  const onAbort = () => finished.resolve();
  const task = use((services) =>
    ResultTask.tryPromise({
      try: () => {
        ready.resolve(services);
        return finished.promise;
      },
      catch: (error) => error,
    }),
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  const completion = ResultTask.runExit(task, { signal });
  // Every failure is observed, including cancellation before the callback becomes ready.
  // eslint-disable-next-line no-void
  void completion.then((exit) => {
    signal?.removeEventListener("abort", onAbort);
    if (exit._tag === "Failure") ready.reject(new ResultTaskCauseError(exit.cause));
  });
  return {
    ready: ready.promise,
    completion,
    finish: () => {
      finished.resolve();
      return completion;
    },
  };
}

export function hasFailure(cause: Cause<unknown>): boolean {
  if (cause._tag === "Interrupt") return false;
  if (cause._tag === "Sequential") return hasFailure(cause.left) || hasFailure(cause.right);
  return true;
}
