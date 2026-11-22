import { ResultTask } from "resultar";

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

const waitForShutdownSignal = () =>
  ResultTask.fromCallback<NodeJS.Signals, AccountExampleServerError>({
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
  ResultTask.scoped(
    ResultTask.gen(function* () {
      const { baseUrl } = yield* ResultTask.acquireRelease({
        acquire: startAccountExampleServer(),
        release: ({ server }) =>
          closeServer(server).map(() => {
            process.stdout.write("Request example server stopped.\n");
          }),
      });
      process.stdout.write(`Request example server listening on ${baseUrl}\n`);
      printEndpoints(baseUrl);
      return yield* waitForShutdownSignal();
    }),
  );

await runServer().runPromise();
