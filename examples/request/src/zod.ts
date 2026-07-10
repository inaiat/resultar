import { z } from "zod";

import { ResultAsync, createTaggedError, runPromise } from "resultar";
import { type RequestJsonMapError } from "resultar-request";
import { requestJson as requestJsonZod } from "resultar-request-zod";

import { closeServer, startAccountExampleServer } from "./account-server.js";

export const accountZodSchema = z
  .object({
    email: z.email(),
    id: z.string(),
    plan: z.enum(["free", "team"]),
    seats: z.number().int().nonnegative(),
  })
  .transform((account) => ({
    ...account,
    email: account.email.toLowerCase(),
    seatLabel: `${account.seats} seats`,
  }));

export type AccountFromZod = z.output<typeof accountZodSchema>;

export class ZodAccountApiError extends createTaggedError({
  name: "ZodAccountApiError",
  message: "Zod account API $reason: $detail",
}) {}

const mapZodAccountError: RequestJsonMapError = {
  404: ({ body, statusCode }) =>
    new ZodAccountApiError({
      detail: `${body} (${statusCode})`,
      reason: "not-found",
    }),
  http: ({ body, statusCode }) =>
    new ZodAccountApiError({
      detail: `failed with ${statusCode}: ${body}`,
      reason: "http",
    }),
  invalidJson: ({ cause }) =>
    new ZodAccountApiError({
      cause,
      detail: `returned invalid JSON: ${cause.message}`,
      reason: "invalid-json",
    }),
  request: ({ cause }) =>
    new ZodAccountApiError({
      cause,
      detail: `request failed: ${cause.message}`,
      reason: "request",
    }),
  validation: ({ errors, message }) =>
    new ZodAccountApiError({
      detail: `${message} (${errors.length} issue(s))`,
      reason: "validation",
    }),
};

const zodAccountValidationMessage = ({ errors }: { readonly errors: readonly unknown[] }) =>
  `Zod account response failed validation with ${errors.length} issue(s)`;

export const loadAccountWithZod = (baseUrl: string) =>
  requestJsonZod({
    mapError: mapZodAccountError,
    request: () => fetch(`${baseUrl}/accounts/team`),
    schema: accountZodSchema,
    validationError: zodAccountValidationMessage,
  });

const runZodExample = (baseUrl: string) =>
  loadAccountWithZod(baseUrl).map((account) => {
    process.stdout.write(`Zod account: ${account.email}, ${account.seatLabel}\n`);
    return account;
  });

const runZodExampleCli = () =>
  ResultAsync.withResource({
    acquire: () => startAccountExampleServer(),
    release: ({ server }) => closeServer(server),
    use: ({ baseUrl }) => {
      process.stdout.write(`Started local account API at ${baseUrl}\n`);
      return runZodExample(baseUrl);
    },
  });

await runPromise(runZodExampleCli());
