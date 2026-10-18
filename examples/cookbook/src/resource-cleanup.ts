/**
 * Scoped Resource Cleanup (`ResultTask.scoped`, `ResultTask.acquireRelease`)
 *
 * This module demonstrates the acquire / use / release bracket pattern for
 * `ResultTask`, where a scope awaits release after success, failure, or interruption.
 * Finalizers receive the task Exit to choose between close and rollback, and their
 * own failures remain visible at the execution boundary.
 */
import { ResultTask, createTaggedError, type Exit, type Result } from "resultar";

export interface ImportSummary {
  readonly imported: number;
}

export interface ImportRun {
  readonly events: readonly string[];
  readonly result: Result<ImportSummary, ImportFailedError>;
}

export interface ImportReleaseRun {
  readonly events: readonly string[];
  readonly exit: Exit<ImportSummary, ReleaseFailedError>;
}

interface Connection {
  readonly id: string;
}

export class ConnectionError extends createTaggedError({
  name: "ConnectionError",
  message: "Could not open connection $id",
}) {}

export class ImportFailedError extends createTaggedError({
  name: "ImportFailedError",
  message: "Import failed at row $row",
}) {}

export class ReleaseFailedError extends createTaggedError({
  name: "ReleaseFailedError",
  message: "Could not release connection $id",
}) {}

/**
 * Acquires a warehouse connection, imports rows, and guarantees `release` is
 * called with the Exit so failed or interrupted imports trigger a rollback.
 */
export const importRowsWithCleanup = async (
  rows: readonly string[],
  options: { readonly failAtRow?: number } = {},
): Promise<ImportRun> => {
  const events: string[] = [];

  const task = ResultTask.scoped(
    ResultTask.gen(function* () {
      const connection = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync<Connection>(() => {
          events.push("acquire");
          return { id: "warehouse-1" };
        }),
        release: (connection, exit) =>
          ResultTask.sync(() => {
            events.push(
              `${connection.id}:release:${exit._tag === "Failure" ? "rollback" : "close"}`,
            );
          }),
      });
      events.push(`${connection.id}:use`);

      if (options.failAtRow !== undefined) {
        return yield* ImportFailedError.taskErr({ row: options.failAtRow });
      }

      return { imported: rows.length };
    }),
  );
  const result = await ResultTask.runResult(task);

  return {
    events,
    result,
  };
};

/**
 * Fallible release is part of the task outcome. `runExit` preserves its typed failure,
 * including composite causes if both use and release fail.
 */
export const importRowsWithFallibleRelease = async (
  shouldFailRelease: boolean,
): Promise<ImportReleaseRun> => {
  const events: string[] = [];

  const task = ResultTask.scoped(
    ResultTask.gen(function* () {
      const connection = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync<Connection>(() => {
          events.push("acquire");
          return { id: "warehouse-2" };
        }),
        release: (connection) =>
          ResultTask.gen(function* () {
            events.push(`${connection.id}:release`);
            if (shouldFailRelease) return yield* ReleaseFailedError.taskErr({ id: connection.id });
          }),
      });
      events.push(`${connection.id}:use`);
      return { imported: 1 };
    }),
  );
  const exit = await ResultTask.runExit(task);

  return {
    events,
    exit,
  };
};
