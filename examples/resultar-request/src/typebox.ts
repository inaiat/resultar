import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "typebox";

import { createTaggedError } from "resultar";
import { requestJson as requestJsonTypeBox } from "resultar-request-typebox";

export const accountTypeBoxSchema = Type.Object(
  {
    email: Type.String(),
    id: Type.String(),
    plan: Type.Union([Type.Literal("free"), Type.Literal("team")]),
    seats: Type.Number(),
  },
  { additionalProperties: false },
);

export type AccountFromTypeBox = Static<typeof accountTypeBoxSchema>;

export class TypeBoxAccountApiError extends createTaggedError({
  name: "TypeBoxAccountApiError",
  message: "TypeBox account API $reason: $detail",
}) {}

export const loadAccountWithTypeBox = (baseUrl: string, accountId: string) =>
  requestJsonTypeBox({
    mapError: {
      404: ({ body, statusCode }) =>
        new TypeBoxAccountApiError({
          detail: `${accountId}: ${body} (${statusCode})`,
          reason: "not-found",
        }),
      http: ({ body, statusCode }) =>
        new TypeBoxAccountApiError({
          detail: `failed with ${statusCode}: ${body}`,
          reason: "http",
        }),
      invalidJson: ({ cause }) =>
        new TypeBoxAccountApiError({
          cause,
          detail: `returned invalid JSON: ${cause.message}`,
          reason: "invalid-json",
        }),
      request: ({ cause }) =>
        new TypeBoxAccountApiError({
          cause,
          detail: `request failed: ${cause.message}`,
          reason: "request",
        }),
      validation: ({ errors, message }) =>
        new TypeBoxAccountApiError({
          detail: `${message} (${errors.length} issue(s))`,
          reason: "validation",
        }),
    },
    request: () => fetch(`${baseUrl}/accounts/${accountId}`),
    schema: accountTypeBoxSchema,
    validationError: ({ errors }) =>
      `TypeBox account response failed validation with ${errors.length} issue(s)`,
  });

const runTypeBoxExample = async (baseUrl: string) => {
  const accountResult = await loadAccountWithTypeBox(baseUrl, "team");

  if (accountResult.isOk()) {
    const account = accountResult.value;

    process.stdout.write(`TypeBox account: ${account.id}, ${account.email}, ${account.seats} seats\n`);
  }

  const missingResult = await loadAccountWithTypeBox(baseUrl, "missing");

  if (missingResult.isErr()) {
    process.stdout.write(`TypeBox mapped 404 error: ${missingResult.error.message}\n`);
  }

  const invalidJsonResult = await loadAccountWithTypeBox(baseUrl, "invalid-json");

  if (invalidJsonResult.isErr()) {
    process.stdout.write(`TypeBox mapped invalid JSON error: ${invalidJsonResult.error.message}\n`);
  }
};

const runTypeBoxExampleCli = async () => {
  const baseUrlArg = process.argv[2];

  if (baseUrlArg !== undefined) {
    await runTypeBoxExample(baseUrlArg);
    return;
  }

  const { closeServer, startAccountExampleServer } = await import("../scripts/server.js");
  const { baseUrl, server } = await startAccountExampleServer();

  try {
    process.stdout.write(`Started local account API at ${baseUrl}\n`);
    await runTypeBoxExample(baseUrl);
  } finally {
    await closeServer(server);
  }
};

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runTypeBoxExampleCli();
}
