import { ResultAsync, runPromise, type ResultAsyncAbortSignal } from "resultar";

import {
  AccountExampleServerError,
  closeServer,
  startAccountExampleServer,
} from "./account-server.js";

const printEndpoints = (baseUrl: string) => {
  process.stdout.write("Endpoints:\n");
  process.stdout.write(`  ${baseUrl}/accounts/team\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
};

const waitForShutdownSignal = (signal: ResultAsyncAbortSignal) =>
  ResultAsync.fromCallback<NodeJS.Signals, AccountExampleServerError>({
    catch: (cause) => new AccountExampleServerError({ cause, operation: "wait" }),
    signal,
    subscribe: ({ resolve }) => {
      const stop = (shutdownSignal: NodeJS.Signals) => resolve(shutdownSignal);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      return () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
    },
  });

const runServer = () =>
  ResultAsync.withResource({
    acquire: () => startAccountExampleServer(),
    release: ({ server }) =>
      closeServer(server).map(() => {
        process.stdout.write("Request example server stopped.\n");
      }),
    use: ({ baseUrl }, signal) => {
      process.stdout.write(`Request example server listening on ${baseUrl}\n`);
      printEndpoints(baseUrl);
      return waitForShutdownSignal(signal);
    },
  });

await runPromise(runServer());
