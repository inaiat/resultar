import { strict as assert } from "node:assert";
import type { ResultAsync } from "resultar";
import { describe, it } from "vite-plus/test";

import {
  isHttpResponseError,
  requestJson,
  RequestError,
  type RequestJsonMapError,
  type UndiciJsonResponseData,
} from "../src/index.js";

type UserSample = { readonly email: string; readonly name: string };
type UnknownRecord = Readonly<Record<string, unknown>>;

const userSample = { email: "elizeu.drummond@telerj.br", name: "Elizeu Drummond" };

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const isUserSample = (value: unknown): value is UserSample =>
  isRecord(value) && typeof value.name === "string" && typeof value.email === "string";

class MappedRequestJsonError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly context: UnknownRecord = {},
  ) {
    super(message);
    this.name = "MappedRequestJsonError";
  }
}

const expectMappedError = (error: Error) => {
  assert.ok(error instanceof MappedRequestJsonError);

  return error;
};

const expectRequestError = (error: Error) => {
  assert.ok(error instanceof RequestError);

  return error;
};

const createMapError = (overrides: Partial<RequestJsonMapError> = {}): RequestJsonMapError => ({
  http: ({ statusCode }) => new MappedRequestJsonError("http", String(statusCode)),
  invalidJson: ({ cause }) => new MappedRequestJsonError("invalid-json", cause.message),
  request: ({ cause }) => new MappedRequestJsonError("request", cause.message),
  validation: ({ message }) => new MappedRequestJsonError("validation", message),
  ...overrides,
});

const createFetchResponse = (
  body: unknown,
  init: { readonly headers?: Record<string, string>; readonly status?: number } = {},
) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: init.headers,
    status: init.status ?? 200,
  });

const createUndiciResponse = (
  body: unknown,
  init: { readonly headers?: Record<string, string>; readonly statusCode?: number } = {},
): UndiciJsonResponseData => {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);

  return {
    body: { json: async () => JSON.parse(bodyText) as unknown, text: async () => bodyText },
    headers: init.headers,
    statusCode: init.statusCode ?? 200,
  };
};

const createPlainRequestFailure = (): unknown => ({ reason: "plain failure" });

const getPromiseReject = () =>
  Reflect.get(Promise, "reject") as <T = never>(reason?: unknown) => Promise<T>;

const rejectPlainRequestFailure = <T>() =>
  Reflect.apply(getPromiseReject(), Promise, [createPlainRequestFailure()]) as Promise<T>;

const expectType = <T>(value: T) => value;
const requestJsonUnsafe = requestJson as (input: unknown) => ResultAsync<unknown, Error>;

describe("requestJson", () => {
  it("given Fetch Response and valid JSON, then returns typed payload", async () => {
    const result = requestJson({
      request: async () => createFetchResponse(userSample),
      validator: isUserSample,
    });

    expectType<ResultAsync<UserSample, RequestError>>(result);

    const awaited = await result;

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given Undici-shaped response and valid JSON, then returns typed payload", async () => {
    const result = await requestJson({
      request: async () => createUndiciResponse(userSample),
      validator: isUserSample,
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
  });

  it("given decode transforms payload, then returns decoded value", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse(userSample),
      decode: (value) =>
        isUserSample(value)
          ? { success: true, value: { ...value, email: value.email.toUpperCase() } }
          : { errors: [{ message: "Expected user payload" }], success: false },
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, { email: "ELIZEU.DRUMMOND@TELERJ.BR", name: userSample.name });
  });

  it("given HTTP 400 without mapError, then returns RequestError with HTTP cause metadata", async () => {
    const result = await requestJson({
      request: async () =>
        createFetchResponse("Bad Request", {
          headers: { "x-request-id": "request-400" },
          status: 400,
        }),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Bad Request");
    assert.equal(error.statusCode, 400);
    assert.ok(isHttpResponseError(error));
    assert.equal(error.cause.body, "Bad Request");
    assert.equal(error.cause.statusCode, 400);
  });

  it("given Undici HTTP 500 without mapError, then returns RequestError with status 500", async () => {
    const result = await requestJson({
      request: async () => createUndiciResponse("Internal Server Error", { statusCode: 500 }),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Internal Server Error");
    assert.equal(error.statusCode, 500);
  });

  it("given invalid JSON without mapError, then returns RequestError with SyntaxError cause", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse(""),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.statusCode, 500);
    assert.ok(error.cause instanceof SyntaxError);
  });

  it("given request factory throws without mapError, then returns RequestError preserving cause", async () => {
    const cause = new Error("request setup failed");

    const result = await requestJson({
      request: () => {
        throw cause;
      },
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "request setup failed");
    assert.equal(error.statusCode, 500);
    assert.equal(error.cause, cause);
  });

  it("given request rejects with non-Error without mapError, then returns RequestError", async () => {
    const result = await requestJson({
      request: () => rejectPlainRequestFailure<Response>(),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, '{"reason":"plain failure"}');
    assert.equal(error.statusCode, 500);
  });

  it("given missing decoder, then returns integration RequestError", async () => {
    const result = await requestJsonUnsafe({
      request: async () => createFetchResponse(userSample),
      validationError: "Missing validator",
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Missing JSON response decoder");
    assert.equal(error.statusCode, 500);
  });

  it("given validation failure without validationError, then returns default validation message", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse({ name: userSample.name }),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Invalid JSON response payload");
    assert.equal(error.statusCode, 500);
  });

  it("given validationError function, then receives validation errors and raw value", async () => {
    const invalidPayload = { name: userSample.name };
    const received: { value?: unknown } = {};
    let receivedErrorCount = 0;

    const result = await requestJson({
      request: async () => createFetchResponse(invalidPayload),
      decode: (_value) => ({
        errors: [{ message: "Missing email", path: ["email"] }],
        success: false,
      }),
      validationError: ({ errors, value }) => {
        receivedErrorCount = errors.length;
        received.value = value;

        return `User API returned ${errors.length} schema errors`;
      },
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "User API returned 1 schema errors");
    assert.equal(receivedErrorCount, 1);
    assert.deepEqual(received.value, invalidPayload);
  });

  it("given retry and first HTTP 5xx fails, then retries and returns the next success", async () => {
    const retryContexts: UnknownRecord[] = [];
    let requestCalls = 0;

    const result = await requestJson({
      request: async () => {
        requestCalls += 1;

        return requestCalls === 1
          ? createFetchResponse("Service Unavailable", { status: 503 })
          : createFetchResponse(userSample);
      },
      retry: {
        delayMs: 0,
        onRetry: (context) => {
          assert.equal(context.reason, "http");

          if (context.reason === "http") {
            retryContexts.push({
              attempt: context.attempt,
              nextAttempt: context.nextAttempt,
              reason: context.reason,
              retriesRemaining: context.retriesRemaining,
              statusCode: context.statusCode,
            });
          }
        },
        times: 1,
      },
      validator: isUserSample,
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
    assert.equal(requestCalls, 2);
    assert.deepEqual(retryContexts, [
      { attempt: 0, nextAttempt: 1, reason: "http", retriesRemaining: 1, statusCode: 503 },
    ]);
  });

  it("given retry and HTTP 4xx fails, then does not retry by default", async () => {
    let requestCalls = 0;

    const result = await requestJson({
      request: async () => {
        requestCalls += 1;

        return createFetchResponse("Bad Request", { status: 400 });
      },
      retry: { delayMs: 0, times: 1 },
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(requestCalls, 1);
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, "Bad Request");
  });

  it("given custom retry predicate for invalid JSON, then retries and can recover", async () => {
    const retryReasons: string[] = [];
    let requestCalls = 0;

    const result = await requestJson({
      request: async () => {
        requestCalls += 1;

        return requestCalls === 1 ? createFetchResponse("") : createFetchResponse(userSample);
      },
      retry: {
        delayMs: 0,
        onRetry: ({ reason }) => {
          retryReasons.push(reason);
        },
        times: 1,
        when: ({ reason }) => reason === "invalidJson",
      },
      validator: isUserSample,
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
    assert.deepEqual(retryReasons, ["invalidJson"]);
  });

  it("given retry with a promise request source, then returns an integration RequestError", async () => {
    const result = await requestJson({
      request: Promise.resolve(createFetchResponse(userSample)),
      retry: { times: 1 },
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.statusCode, 500);
    assert.equal(error.message, "JSON request retry requires a request factory");
  });

  it("given mapError and exact status handler, then exact handler wins over generic HTTP", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse("Bad Request", { status: 400 }),
      mapError: createMapError({
        400: ({ body }) => new MappedRequestJsonError("bad-request", body),
      }),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectMappedError(result.error);

    assert.equal(error.kind, "bad-request");
    assert.equal(error.message, "Bad Request");
  });

  it("given mapError and invalid JSON, then invalidJson handler is used", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse(""),
      mapError: createMapError(),
      validator: isUserSample,
    });

    assert.ok(result.isErr());
    const error = expectMappedError(result.error);

    assert.equal(error.kind, "invalid-json");
  });

  it("given mapError and validation failure, then validation handler receives context", async () => {
    const invalidPayload = { name: userSample.name };

    const result = await requestJson({
      request: async () => createFetchResponse(invalidPayload),
      decode: (_value) => ({
        errors: [{ message: "Missing email", path: ["email"] }],
        success: false,
      }),
      mapError: createMapError({
        validation: ({ error, errors, message, value }) =>
          new MappedRequestJsonError("validation", message, {
            errorStatusCode: error.statusCode,
            errorsLength: errors.length,
            value,
          }),
      }),
      validationError: ({ errors }) => `Schema failed with ${errors.length} errors`,
    });

    assert.ok(result.isErr());
    const error = expectMappedError(result.error);

    assert.equal(error.kind, "validation");
    assert.equal(error.message, "Schema failed with 1 errors");
    assert.equal(error.context.errorStatusCode, 500);
    assert.equal(error.context.errorsLength, 1);
    assert.deepEqual(error.context.value, invalidPayload);
  });
});
