import { createTaggedError, ResultAsync, runPromise } from "resultar";
import { requestJson as requestJsonTypeBox, t } from "resultar-request-typebox";

import { closeServer, startAccountExampleServer } from "./account-server.js";

export const accountTypeBoxSchema = t.Object(
  {
    email: t.String(),
    id: t.String(),
    plan: t.Union([t.Literal("free"), t.Literal("team")]),
    seats: t.Number(),
  },
  { additionalProperties: false },
);

export type AccountFromTypeBox = t.Static<typeof accountTypeBoxSchema>;

export class TypeBoxAccountApiError extends createTaggedError({
  name: "TypeBoxAccountApiError",
  message: "TypeBox account API $reason: $detail",
}) {}

export const loadAccountWithTypeBox = (baseUrl: string) =>
  requestJsonTypeBox({
    mapError: {
      404: ({ body, statusCode }) =>
        new TypeBoxAccountApiError({
          detail: `${body} (${statusCode})`,
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
    request: () => fetch(`${baseUrl}/accounts/team`),
    schema: accountTypeBoxSchema,
    validationError: ({ errors }) =>
      `TypeBox account response failed validation with ${errors.length} issue(s)`,
  });

const runTypeBoxExample = (baseUrl: string) =>
  loadAccountWithTypeBox(baseUrl).tap((account) => {
    process.stdout.write(
      `TypeBox account: ${account.id}, ${account.email}, ${account.seats} seats\n`,
    );
  });

const runTypeBoxExampleCli = () =>
  ResultAsync.withResource({
    acquire: () => startAccountExampleServer(),
    release: ({ server }) => closeServer(server),
    use: ({ baseUrl }) => {
      process.stdout.write(`Started local account API at ${baseUrl}\n`);
      return runTypeBoxExample(baseUrl);
    },
  });

await runPromise(runTypeBoxExampleCli());
