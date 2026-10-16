/**
 * Bracketed Async Resource Cleanup (`ResultAsync.withResource`)
 *
 * This module demonstrates the acquire / use / release bracket pattern for
 * `ResultAsync`, where `release` always runs after `use` completes (whether with
 * `Ok`, `Err`, or cancellation) and receives the `ResultAsyncResourceReleaseContext`
 * to decide between commit/close and rollback.
 */
import { ResultAsync, createTaggedError, errAsync, okAsync } from "resultar";

export interface ImportSummary {
  readonly imported: number;
}

export interface ImportRun {
  readonly events: readonly string[];
  readonly result: Awaited<ReturnType<ResultAsync<ImportSummary, ImportFailedError>["then"]>>;
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
 * called with the outcome (`context.result`) so failed imports trigger a rollback.
 */
export const importRowsWithCleanup = async (
  rows: readonly string[],
  options: { readonly failAtRow?: number } = {},
) => {
  const events: string[] = [];

  const result = await ResultAsync.withResource({
    acquire: () => {
      events.push("acquire");
      return okAsync<Connection, ConnectionError>({ id: "warehouse-1" });
    },
    release: (connection, context) => {
      events.push(
        `${connection.id}:release:${context.result?.isErr() === true ? "rollback" : "close"}`,
      );
    },
    use: (connection) => {
      events.push(`${connection.id}:use`);

      if (options.failAtRow !== undefined) {
        return errAsync(new ImportFailedError({ row: options.failAtRow }));
      }

      return okAsync({ imported: rows.length });
    },
  });

  return {
    events,
    result,
  };
};

/**
 * `ResultAsync.withResource` treats `release` as best-effort cleanup: even if `release`
 * returns `Err` or rejects, the outcome of `use` is preserved without masking domain results.
 */
export const importRowsWithFallibleRelease = async (shouldFailRelease: boolean) => {
  const events: string[] = [];

  const result = await ResultAsync.withResource({
    acquire: () => {
      events.push("acquire");
      return okAsync<Connection, ConnectionError>({ id: "warehouse-2" });
    },
    release: (connection) => {
      events.push(`${connection.id}:release`);
      return shouldFailRelease
        ? errAsync(new ReleaseFailedError({ id: connection.id }))
        : okAsync(undefined);
    },
    use: (connection) => {
      events.push(`${connection.id}:use`);
      return okAsync<ImportSummary, ImportFailedError>({ imported: 1 });
    },
  });

  return {
    events,
    result,
  };
};
