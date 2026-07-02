import { strict as assert } from "node:assert";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export const createAccountExampleServer = () => {
  let flakyCalls = 0;

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const accountId = url.pathname.match(/^\/accounts\/([^/]+)$/u)?.[1];

    if (request.method !== "GET" || accountId === undefined) {
      writeText(response, 404, "Route not found");
      return;
    }

    switch (accountId) {
      case "flaky": {
        flakyCalls += 1;

        if (flakyCalls === 1) {
          writeText(response, 503, "Service unavailable");
          return;
        }

        writeJson(response, 200, accountPayload);
        return;
      }
      case "invalid-json": {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
        return;
      }
      case "malformed": {
        writeJson(response, 200, { email: "not-an-email", id: "acct_bad" });
        return;
      }
      case "missing": {
        writeText(response, 404, "Account not found");
        return;
      }
      case "team": {
        writeJson(response, 200, accountPayload);
        return;
      }
      default: {
        writeText(response, 400, "Unsupported account id");
      }
    }
  });
};

const listen = (server: Server) =>
  new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });

export const closeServer = (server: Server) =>
  new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });

const getBaseUrl = (server: Server) => {
  const address = server.address();

  assert.equal(typeof address, "object");
  assert.notEqual(address, null);

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
};

export const startAccountExampleServer = async () => {
  const server = createAccountExampleServer();

  await listen(server);

  return { baseUrl: getBaseUrl(server), server };
};

const printEndpoints = (baseUrl: string) => {
  process.stdout.write("Endpoints:\n");
  process.stdout.write(`  ${baseUrl}/accounts/team\n`);
  process.stdout.write(`  ${baseUrl}/accounts/missing\n`);
  process.stdout.write(`  ${baseUrl}/accounts/malformed\n`);
  process.stdout.write(`  ${baseUrl}/accounts/invalid-json\n`);
  process.stdout.write(`  ${baseUrl}/accounts/flaky\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");
};

const runServer = async () => {
  const { baseUrl, server } = await startAccountExampleServer();

  process.stdout.write(`Resultar request example server listening on ${baseUrl}\n`);
  printEndpoints(baseUrl);

  const stop = async () => {
    await closeServer(server);
    process.stdout.write("Resultar request example server stopped.\n");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
};

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runServer();
}
