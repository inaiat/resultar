import { createServer, type Server, type ServerResponse } from "node:http";

import { ResultAsync, createTaggedError, err, ok, type StrictResult } from "resultar";

export class AccountExampleServerError extends createTaggedError({
  name: "AccountExampleServerError",
  message: "Account example server $operation failed",
}) {}

type AccountExampleServerOperation = "close" | "start";

const mapServerError = (operation: AccountExampleServerOperation) => (cause: unknown) =>
  new AccountExampleServerError({ cause, operation });

const accountPayload = {
  email: "ADA@EXAMPLE.COM",
  id: "acct_team",
  plan: "team",
  seats: 8,
};

const writeJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const writeText = (response: ServerResponse, statusCode: number, body: string) => {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

export const createAccountExampleServer = () =>
  createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method !== "GET" || url.pathname !== "/accounts/team") {
      writeText(response, 404, "Route not found");
      return;
    }

    writeJson(response, 200, accountPayload);
  });

const listen = (server: Server) =>
  ResultAsync.fromCallback<void, AccountExampleServerError>({
    catch: mapServerError("start"),
    subscribe: ({ reject, resolve }) => {
      const onError = (error: Error) => reject(error);

      server.once("error", onError);
      server.listen(0, "127.0.0.1", resolve);

      return () => server.off("error", onError);
    },
  });

export const closeServer = (server: Server) =>
  ResultAsync.fromCallback<void, AccountExampleServerError>({
    catch: mapServerError("close"),
    subscribe: ({ reject, resolve }) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    },
  });

const getBaseUrl = (server: Server): StrictResult<string, AccountExampleServerError> => {
  const address = server.address();

  return typeof address === "object" && address !== null
    ? ok(`http://127.0.0.1:${address.port}`)
    : err(new AccountExampleServerError({ operation: "start" }));
};

export const startAccountExampleServer = () => {
  const server = createAccountExampleServer();

  return listen(server)
    .andThen(() => getBaseUrl(server))
    .map((baseUrl) => ({ baseUrl, server }));
};
