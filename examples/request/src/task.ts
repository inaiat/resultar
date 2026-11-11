import { createTaggedError, ResultTask } from "resultar";
import {
  requestJsonTask,
  type RequestJsonDecodeResult,
  type RequestJsonMapError,
} from "resultar-request";
import { requestJsonTypeBoxTask } from "resultar-request-typebox";
import { requestJsonZodTask } from "resultar-request-zod";

import { closeServer, startAccountExampleServer } from "./account-server.js";
import { accountTypeBoxSchema } from "./typebox.js";
import { accountZodSchema } from "./zod.js";

export interface DecodedAccount {
  readonly email: string;
  readonly id: string;
  readonly seats: number;
}

export class TaskAccountApiError extends createTaggedError({
  name: "TaskAccountApiError",
  message: "Task account API $reason: $detail",
}) {}

const decodeAccount = (payload: unknown): RequestJsonDecodeResult<DecodedAccount> => {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "id" in payload &&
    typeof payload.id === "string" &&
    "email" in payload &&
    typeof payload.email === "string" &&
    "seats" in payload &&
    typeof payload.seats === "number"
  ) {
    return {
      success: true,
      value: {
        email: payload.email.toLowerCase(),
        id: payload.id,
        seats: payload.seats,
      },
    };
  }

  return {
    errors: [{ message: "Expected { id, email, seats } account object" }],
    success: false,
  };
};

const mapTaskAccountError = {
  404: ({ body, statusCode }) =>
    new TaskAccountApiError({ detail: `${body} (${statusCode})`, reason: "not-found" }),
  http: ({ body, statusCode }) =>
    new TaskAccountApiError({ detail: `failed with ${statusCode}: ${body}`, reason: "http" }),
  invalidJson: ({ cause }) =>
    new TaskAccountApiError({
      cause,
      detail: `returned invalid JSON: ${cause.message}`,
      reason: "invalid-json",
    }),
  request: ({ cause }) =>
    new TaskAccountApiError({
      cause,
      detail: `request failed: ${cause.message}`,
      reason: "request",
    }),
  validation: ({ errors, message }) =>
    new TaskAccountApiError({
      detail: `${message} (${errors.length} issue(s))`,
      reason: "validation",
    }),
} satisfies RequestJsonMapError;

export const loadAccountWithPlainTask = (baseUrl: string) =>
  requestJsonTask({
    decode: decodeAccount,
    mapError: mapTaskAccountError,
    request: (signal) => fetch(`${baseUrl}/accounts/team`, { signal }),
    retry: { delayMs: 25, times: 1 },
  });

export const loadAccountWithZodTask = (baseUrl: string) =>
  requestJsonZodTask({
    mapError: mapTaskAccountError,
    request: (signal) => fetch(`${baseUrl}/accounts/team`, { signal }),
    retry: { delayMs: 25, times: 1 },
    schema: accountZodSchema,
  });

export const loadAccountWithTypeBoxTask = (baseUrl: string) =>
  requestJsonTypeBoxTask({
    mapError: mapTaskAccountError,
    request: (signal) => fetch(`${baseUrl}/accounts/team`, { signal }),
    retry: { delayMs: 25, times: 1 },
    schema: accountTypeBoxSchema,
  });

const runTaskExampleWorkflow = () =>
  ResultTask.scoped(
    ResultTask.gen(function* () {
      const { baseUrl } = yield* ResultTask.acquireRelease({
        acquire: ResultTask.fromResultAsync(() => startAccountExampleServer()),
        release: ({ server }) => ResultTask.fromResultAsync(() => closeServer(server)),
      });

      const plain = yield* loadAccountWithPlainTask(baseUrl);
      const zodAccount = yield* loadAccountWithZodTask(baseUrl);
      const typeboxAccount = yield* loadAccountWithTypeBoxTask(baseUrl);

      process.stdout.write(
        `Task accounts: plain=${plain.email}, zod=${zodAccount.seatLabel}, typebox=${typeboxAccount.seats}\n`,
      );
    }),
  );

await runTaskExampleWorkflow().runPromise();
