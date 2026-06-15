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
