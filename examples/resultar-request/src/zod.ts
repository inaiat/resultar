import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { createTaggedError } from "resultar";
import { type RequestJsonMapError } from "resultar-request";
import { requestJson as requestJsonZod } from "resultar-request-zod";

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

const mapZodAccountError = (accountId: string): RequestJsonMapError => ({
  404: ({ body, statusCode }) =>
    new ZodAccountApiError({
      detail: `${accountId}: ${body} (${statusCode})`,
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
});

const zodAccountValidationMessage = ({ errors }: { readonly errors: readonly unknown[] }) =>
  `Zod account response failed validation with ${errors.length} issue(s)`;

export const loadAccountWithZod = (baseUrl: string, accountId: string) =>
  requestJsonZod({
    mapError: mapZodAccountError(accountId),
    request: () => fetch(`${baseUrl}/accounts/${accountId}`),
    schema: accountZodSchema,
    validationError: zodAccountValidationMessage,
  });

export const loadAccountWithZodAfterRetry = (baseUrl: string) =>
  requestJsonZod({
    mapError: mapZodAccountError("flaky"),
    request: () => fetch(`${baseUrl}/accounts/flaky`),
    retry: { delayMs: 0, times: 1 },
    schema: accountZodSchema,
    validationError: zodAccountValidationMessage,
  });

const runZodExample = async (baseUrl: string) => {
  const accountResult = await loadAccountWithZod(baseUrl, "team");

  if (accountResult.isOk()) {
    const account = accountResult.value;

    process.stdout.write(`Zod account: ${account.email}, ${account.seatLabel}\n`);
  }

  const retriedResult = await loadAccountWithZodAfterRetry(baseUrl);

  if (retriedResult.isOk()) {
    process.stdout.write(`Zod retried account after HTTP 503: ${retriedResult.value.id}\n`);
  }

  const malformedResult = await loadAccountWithZod(baseUrl, "malformed");

  if (malformedResult.isErr()) {
    process.stdout.write(`Zod mapped validation error: ${malformedResult.error.message}\n`);
  }
};

const runZodExampleCli = async () => {
  const baseUrlArg = process.argv[2];

  if (baseUrlArg !== undefined) {
    await runZodExample(baseUrlArg);
    return;
  }

  const { closeServer, startAccountExampleServer } = await import("../scripts/server.js");
  const { baseUrl, server } = await startAccountExampleServer();

  try {
    process.stdout.write(`Started local account API at ${baseUrl}\n`);
    await runZodExample(baseUrl);
  } finally {
    await closeServer(server);
  }
};

const isDirectRun =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await runZodExampleCli();
}
