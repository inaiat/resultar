import { strict as assert } from "node:assert";
import { AbortError, Cause, Clock, isAbortError, Match, ResultTask } from "resultar";
import { describe, it } from "vite-plus/test";

import {
  baseRequestErrorHandler,
  HttpClientRequestErrorCause,
  HttpResponseErrorCauseError,
  integrationErrorHandler,
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

class NotFoundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundRequestError";
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
const requestJsonUnsafe = requestJson as (input: unknown) => ResultTask<unknown, Error>;

describe("requestJson", () => {
  it("stays lazy at construction and executes fresh on every run", async () => {
    let calls = 0;

    const task = requestJson({
      request: async (signal) => {
        assert.equal(signal.aborted, false);
        calls += 1;

        return createFetchResponse({ ...userSample, name: `User ${calls}` });
      },
      validator: isUserSample,
    });

    expectType<ResultTask<UserSample, RequestError>>(task);
    assert.equal(calls, 0);

    const first = await task.runResult();
    const second = await task.runResult();

    assert.equal(calls, 2);
    assert.ok(first.isOk());
    assert.ok(second.isOk());
    assert.equal(first.value.name, "User 1");
    assert.equal(second.value.name, "User 2");
  });

  it("given Fetch Response and valid JSON, then returns typed payload", async () => {
    const task = requestJson({
      request: async () => createFetchResponse(userSample),
      validator: isUserSample,
    });

    expectType<ResultTask<UserSample, RequestError>>(task);

    const awaited = await task.runResult();

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given Undici-shaped response and valid JSON, then returns typed payload", async () => {
    const result = await requestJson({
      request: async () => createUndiciResponse(userSample),
      validator: isUserSample,
    }).runResult();

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
    }).runResult();

    assert.ok(result.isOk());
    assert.deepEqual(result.value, { email: "ELIZEU.DRUMMOND@TELERJ.BR", name: userSample.name });
  });

  it("given decode throws or returns custom message, then produces validation RequestError", async () => {
    const thrownCause = new Error("decoder crashed");
    const thrownResult = await requestJson({
      request: async () => createFetchResponse(userSample),
      decode: () => {
        throw thrownCause;
      },
    }).runResult();

    assert.ok(thrownResult.isErr());
    const thrownError = expectRequestError(thrownResult.error);
    assert.equal(thrownError.message, "Invalid JSON response payload");
    assert.equal(thrownError.statusCode, 500);

    const customMessageResult = await requestJson({
      request: async () => createFetchResponse(userSample),
      decode: () => ({ message: "Custom decoder failure", success: false }),
    }).runResult();

    assert.ok(customMessageResult.isErr());
    const customMessageError = expectRequestError(customMessageResult.error);
    assert.equal(customMessageError.message, "Custom decoder failure");
    assert.equal(customMessageError.statusCode, 500);
  });

  it("given HTTP 400 without mapError, then returns RequestError with HTTP cause metadata", async () => {
    assert.equal(HttpClientRequestErrorCause, HttpResponseErrorCauseError);

    const result = await requestJson({
      request: async () =>
        createFetchResponse("Bad Request", {
          headers: { "x-request-id": "request-400" },
          status: 400,
        }),
      validator: isUserSample,
    }).runResult();

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
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Internal Server Error");
    assert.equal(error.statusCode, 500);
  });

  it("given invalid JSON without mapError, then returns RequestError with SyntaxError cause", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse(""),
      validator: isUserSample,
    }).runResult();

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
    }).runResult();

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
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, '{"reason":"plain failure"}');
    assert.equal(error.statusCode, 500);
  });

  it("given missing decoder, then returns integration RequestError", async () => {
    const result = await requestJsonUnsafe({
      request: async () => createFetchResponse(userSample),
      validationError: "Missing validator",
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Missing JSON response decoder");
    assert.equal(error.statusCode, 500);
  });

  it("given non-function request source, then returns integration error without unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const rejectedPromise = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("rejected pre-started promise"));
        }, 5);
      });

      const unmapped = await requestJsonUnsafe({
        request: rejectedPromise,
        validator: isUserSample,
      }).runResult();

      assert.ok(unmapped.isErr());
      const unmappedError = expectRequestError(unmapped.error);
      assert.equal(unmappedError.statusCode, 500);
      assert.equal(unmappedError.message, "JSON request requires a request factory");

      const mapped = await requestJsonUnsafe({
        mapError: createMapError(),
        request: Promise.resolve(createFetchResponse(userSample)),
        validator: isUserSample,
      }).runResult();

      assert.ok(mapped.isErr());
      const mappedError = expectMappedError(mapped.error);
      assert.equal(mappedError.kind, "request");
      assert.equal(mappedError.message, "JSON request requires a request factory");

      let thenableCaught = false;
      const customThenable: Record<string, unknown> = {};
      Reflect.set(
        customThenable,
        "then",
        (_onFulfilled?: unknown, onRejected?: (reason: unknown) => unknown) => {
          thenableCaught = typeof onRejected === "function";
        },
      );
      const thenableResult = await requestJsonUnsafe({
        request: customThenable,
        validator: isUserSample,
      }).runResult();
      assert.ok(thenableResult.isErr());
      assert.equal(thenableCaught, true);

      const missingDecoderRejected = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("rejected with missing decoder"));
        }, 5);
      });
      const missingDecoderResult = await requestJsonUnsafe({
        request: missingDecoderRejected,
      }).runResult();
      assert.ok(missingDecoderResult.isErr());

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });

      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("given validation failure without validationError, then returns default validation message", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse({ name: userSample.name }),
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "Invalid JSON response payload");
    assert.equal(error.statusCode, 500);
  });

  it("given validationError string or function, then formats validation message with context", async () => {
    const staticResult = await requestJson({
      request: async () => createFetchResponse({ name: userSample.name }),
      validationError: "Expected valid user object",
      validator: isUserSample,
    }).runResult();

    assert.ok(staticResult.isErr());
    assert.equal(expectRequestError(staticResult.error).message, "Expected valid user object");

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
    }).runResult();

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
    }).runResult();

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
    }).runResult();

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
        delayMs: ({ attempt }) => (attempt > 0 ? 1 : 0),
        onRetry: ({ reason }) => {
          retryReasons.push(reason);
        },
        times: 1,
        when: ({ reason }) => reason === "invalidJson",
      },
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
    assert.deepEqual(retryReasons, ["invalidJson"]);
  });

  it("given mapError and exact status handler, then exact handler wins over generic HTTP and infers union", async () => {
    const mappedConfig = {
      404: ({ body }: { readonly body: string }) => new NotFoundRequestError(body),
      http: ({ statusCode }: { readonly statusCode: number }) =>
        new MappedRequestJsonError("http", String(statusCode)),
      invalidJson: ({ cause }: { readonly cause: Error }) =>
        new MappedRequestJsonError("invalid-json", cause.message),
      request: ({ cause }: { readonly cause: Error }) =>
        new MappedRequestJsonError("request", cause.message),
      validation: ({ message }: { readonly message: string }) =>
        new MappedRequestJsonError("validation", message),
    } satisfies RequestJsonMapError;

    const notFoundTask = requestJson({
      request: async () => createFetchResponse("Not Found", { status: 404 }),
      mapError: mappedConfig,
      validator: isUserSample,
    });

    expectType<ResultTask<UserSample, MappedRequestJsonError | NotFoundRequestError>>(notFoundTask);

    const notFoundResult = await notFoundTask.runResult();
    assert.ok(notFoundResult.isErr());
    assert.ok(notFoundResult.error instanceof NotFoundRequestError);
    assert.equal(notFoundResult.error.message, "Not Found");

    const genericHttpResult = await requestJson({
      request: async () => createFetchResponse("Bad Gateway", { status: 502 }),
      mapError: mappedConfig,
      validator: isUserSample,
    }).runResult();

    assert.ok(genericHttpResult.isErr());
    const genericError = expectMappedError(genericHttpResult.error);
    assert.equal(genericError.kind, "http");
    assert.equal(genericError.message, "502");
  });

  it("given mapError and invalid JSON, then invalidJson handler is used", async () => {
    const result = await requestJson({
      request: async () => createFetchResponse(""),
      mapError: createMapError(),
      validator: isUserSample,
    }).runResult();

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
    }).runResult();

    assert.ok(result.isErr());
    const error = expectMappedError(result.error);

    assert.equal(error.kind, "validation");
    assert.equal(error.message, "Schema failed with 1 errors");
    assert.equal(error.context.errorStatusCode, 500);
    assert.equal(error.context.errorsLength, 1);
    assert.deepEqual(error.context.value, invalidPayload);
  });

  it("given circular object, BigInt, symbol, or string in error helpers, serializes safely without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const circularError = RequestError.exception(circular, 500);
    assert.equal(circularError.statusCode, 500);
    assert.equal(circularError.message, "[object Object]");

    const bigintError = RequestError.exception(123n, 500);
    assert.equal(bigintError.statusCode, 500);
    assert.equal(bigintError.message, "123");

    const symbolError = integrationErrorHandler(Symbol("boom"));
    assert.equal(symbolError.statusCode, 500);
    assert.equal(symbolError.message, "Symbol(boom)");

    const missing: unknown = Reflect.get({}, "missing");
    const undefinedError = baseRequestErrorHandler(missing);
    assert.equal(undefinedError.statusCode, 500);
    assert.equal(undefinedError.message, "undefined");

    const objectWithBigIntError = RequestError.exception({ count: 123n }, 500);
    assert.equal(objectWithBigIntError.statusCode, 500);
    assert.equal(objectWithBigIntError.message, "[object Object]");
  });

  it("given HTTP error response and text() rejects, then returns RequestError without unhandled rejection", async () => {
    const textRejectError = new Error("stream read failure");
    const responseWithFailingText = {
      headers: {},
      json: async () => ({}),
      status: 500,
      text: () => Promise.reject(textRejectError),
    };

    const result = await requestJson({
      request: async () => responseWithFailingText,
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, "stream read failure");
    assert.equal(error.statusCode, 500);
    assert.equal(error.cause, textRejectError);
  });

  it("given HTTP error response and text() throws synchronously, then returns RequestError", async () => {
    const syncError = new Error("sync text error");
    const responseWithSyncThrowText = {
      headers: {},
      json: async () => ({}),
      status: 502,
      text: () => {
        throw syncError;
      },
    };

    const result = await requestJson({
      request: async () => responseWithSyncThrowText,
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, "sync text error");
    assert.equal(error.statusCode, 500);
    assert.equal(error.cause, syncError);
  });

  it("given body.json() throws BodyTimeoutError or TimeoutError, then returns 408 RequestError", async () => {
    const bodyTimeoutError = Object.assign(new Error("body timeout"), { name: "BodyTimeoutError" });
    const responseWithBodyTimeout = {
      headers: {},
      json: () => Promise.reject(bodyTimeoutError),
      status: 200,
      text: async () => "",
    };

    const result = await requestJson({
      request: async () => responseWithBodyTimeout,
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, "body timeout");
    assert.equal(error.statusCode, 408);
    assert.equal(error.cause, bodyTimeoutError);

    const abortTimeoutError = Object.assign(new Error("signal timeout"), { name: "TimeoutError" });
    const responseWithSignalTimeout = {
      headers: {},
      json: () => Promise.reject(abortTimeoutError),
      status: 200,
      text: async () => "",
    };

    const resultSignal = await requestJson({
      request: async () => responseWithSignalTimeout,
      validator: isUserSample,
    }).runResult();

    assert.ok(resultSignal.isErr());
    const errorSignal = expectRequestError(resultSignal.error);
    assert.equal(errorSignal.message, "signal timeout");
    assert.equal(errorSignal.statusCode, 408);
    assert.equal(errorSignal.cause, abortTimeoutError);
  });

  it("given transport abort without external signal, then default retry policy does not retry", async () => {
    let attempts = 0;

    const result = await requestJson({
      request: async () => {
        attempts += 1;
        throw new DOMException("Transport aborted", "AbortError");
      },
      retry: { delayMs: 0, times: 2 },
      validator: isUserSample,
    }).runResult();

    assert.equal(attempts, 1);
    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, "Transport aborted");
  });

  it("given request-stage SyntaxError, then classifies as request failure and retries by default", async () => {
    let attempts = 0;

    const retried = await requestJson({
      request: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new SyntaxError("Invalid URL configuration");
        }

        return createFetchResponse(userSample);
      },
      retry: { delayMs: 0, times: 1 },
      validator: isUserSample,
    }).runResult();

    assert.equal(attempts, 2);
    assert.ok(retried.isOk());

    const mapped = await requestJson({
      mapError: createMapError(),
      request: async () => {
        throw new SyntaxError("Invalid header token");
      },
      validator: isUserSample,
    }).runResult();

    assert.ok(mapped.isErr());
    const mappedError = expectMappedError(mapped.error);
    assert.equal(mappedError.kind, "request");
    assert.equal(mappedError.message, "Invalid header token");
  });

  it("given JSON parse SyntaxError vs body stream read error, then classifies only JSON parse SyntaxError as invalidJson", async () => {
    let jsonParseAttempts = 0;
    const parseFailure = await requestJson({
      mapError: createMapError(),
      request: async () => {
        jsonParseAttempts += 1;

        return createFetchResponse("{invalid-json");
      },
      retry: { delayMs: 0, times: 2 },
      validator: isUserSample,
    }).runResult();

    assert.equal(jsonParseAttempts, 1);
    assert.ok(parseFailure.isErr());
    assert.equal(expectMappedError(parseFailure.error).kind, "invalid-json");

    let streamReadAttempts = 0;
    const streamReadFailure = await requestJson({
      mapError: createMapError(),
      request: async () => {
        streamReadAttempts += 1;

        return {
          headers: {},
          json: () => Promise.reject(new TypeError("terminated")),
          status: 200,
          text: async () => "",
        };
      },
      retry: { delayMs: 0, times: 1 },
      validator: isUserSample,
    }).runResult();

    assert.equal(streamReadAttempts, 2);
    assert.ok(streamReadFailure.isErr());
    assert.equal(expectMappedError(streamReadFailure.error).kind, "request");
  });

  it("given HTTP 5xx with circular, bigint, or throwing toJSON headers, then returns Err without rejecting Promise", async () => {
    const circularHeaders: Record<string, unknown> = { "x-trace": "1" };
    circularHeaders.self = circularHeaders;

    const bigintHeaders = { "x-ratelimit-reset": 123_456_789n };
    const throwingHeaders = {
      toJSON() {
        throw new Error("toJSON failed");
      },
    };

    for (const headers of [circularHeaders, bigintHeaders, throwingHeaders]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await requestJson({
        request: async () => ({
          headers,
          json: async () => ({}),
          status: 503,
          text: async () => "Service Unavailable",
        }),
        validator: isUserSample,
      }).runResult();

      assert.ok(result.isErr());
      const error = expectRequestError(result.error);
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, "Service Unavailable");
      assert.ok(isHttpResponseError(error));
      assert.equal(error.cause.headers, headers);
      assert.equal(error.cause.body, "Service Unavailable");
      assert.equal(error.cause.statusCode, 503);
    }

    const serializableHeaders = { "x-request-id": "req-1" };
    const ordinary = await requestJson({
      request: async () =>
        createFetchResponse("Bad Gateway", { headers: serializableHeaders, status: 502 }),
      validator: isUserSample,
    }).runResult();

    assert.ok(ordinary.isErr());
    const ordinaryError = expectRequestError(ordinary.error);
    assert.ok(isHttpResponseError(ordinaryError));
    assert.ok(ordinaryError.cause.headers instanceof Headers);
    assert.equal(ordinaryError.cause.headers.get("x-request-id"), "req-1");
    const expectedResponse = new Response("Bad Gateway", { headers: serializableHeaders });
    const expectedHeaders = Object.fromEntries(expectedResponse.headers.entries());
    assert.equal(
      ordinaryError.cause.message,
      JSON.stringify({ body: "Bad Gateway", headers: expectedHeaders, statusCode: 502 }),
    );
  });

  it("reuses Task clock for retries and preserves domain error mapping", async () => {
    let calls = 0;
    const delays: number[] = [];
    const clock = {
      now: () => 0,
      random: () => 0.5,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };

    const mappedErrors = {
      http: ({ statusCode }) => new MappedRequestJsonError("http", String(statusCode)),
      invalidJson: ({ cause }) => new MappedRequestJsonError("invalid-json", cause.message),
      request: ({ cause }) => new MappedRequestJsonError("request", cause.message),
      validation: ({ message }) => new MappedRequestJsonError("validation", message),
    } satisfies RequestJsonMapError;

    const task = requestJson({
      mapError: mappedErrors,
      request: async () => {
        calls += 1;

        return calls < 3
          ? createFetchResponse("Temporary error", { status: 503 })
          : createFetchResponse(userSample);
      },
      retry: { backoff: 2, delayMs: 25, jittered: 0, times: 2 },
      validator: isUserSample,
    });

    expectType<ResultTask<UserSample, MappedRequestJsonError>>(task);
    assert.equal(calls, 0);

    const value = await task.runPromise({ clock });

    assert.deepEqual(value, userSample);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [25, 50]);
  });

  it("given pre-aborted runner signal, then skips attempt and surfaces Task interruption", async () => {
    const controller = new AbortController();
    const customReason = new Error("caller cancelled before attempt");
    controller.abort(customReason);
    let attempts = 0;

    const task = requestJson({
      request: async () => {
        attempts += 1;

        return createFetchResponse(userSample);
      },
      retry: { delayMs: 10, times: 2 },
      validator: isUserSample,
    });

    const exit = await task.runExit({ signal: controller.signal });
    const interruptedWithCustomReason = Match.valueTags(exit, {
      Failure: ({ cause }) =>
        Match.valueTags(cause, {
          Die: () => false,
          Fail: () => false,
          Interrupt: ({ reason }) => reason === customReason,
          Parallel: () => false,
          Sequential: () => false,
        }),
      Success: () => false,
    });
    assert.equal(attempts, 0);
    assert.equal(interruptedWithCustomReason, true);

    await assert.rejects(task.runResult({ signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof AbortError);
      assert.ok(isAbortError(error));
      assert.equal(error.cause, customReason);

      return true;
    });
    assert.equal(attempts, 0);
  });

  it("given signal aborts during attempt, retry.when, or retry delay, then interrupts immediately without further attempts", async () => {
    const inFlightController = new AbortController();
    let inFlightAttempts = 0;

    const inFlightTask = requestJson({
      request: (signal) => {
        inFlightAttempts += 1;
        assert.equal(signal.aborted, false);
        inFlightController.abort(new Error("aborted in flight"));
        assert.equal(signal.aborted, true);

        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      retry: { delayMs: 0, times: 3, when: () => true },
      validator: isUserSample,
    });

    const inFlightExit = await inFlightTask.runExit({ signal: inFlightController.signal });
    assert.equal(inFlightAttempts, 1);
    assert.equal(
      Match.valueTags(inFlightExit, {
        Failure: ({ cause }) => Cause.hasInterrupts(cause),
        Success: () => false,
      }),
      true,
    );

    const retryWhenController = new AbortController();
    let retryWhenAttempts = 0;

    const retryWhenTask = requestJson({
      request: async () => {
        retryWhenAttempts += 1;

        return createFetchResponse("Service Unavailable", { status: 503 });
      },
      retry: {
        delayMs: 10,
        times: 2,
        when: async () => {
          await Promise.resolve();
          retryWhenController.abort(new Error("aborted inside retry.when"));

          return true;
        },
      },
      validator: isUserSample,
    });

    const retryWhenExit = await retryWhenTask.runExit({ signal: retryWhenController.signal });
    assert.equal(retryWhenAttempts, 1);
    assert.equal(
      Match.valueTags(retryWhenExit, {
        Failure: ({ cause }) => Cause.hasInterrupts(cause),
        Success: () => false,
      }),
      true,
    );

    const delayController = new AbortController();
    let delayAttempts = 0;
    const clock = Clock.virtual();

    const delayTask = requestJson({
      request: async () => {
        delayAttempts += 1;

        return createFetchResponse("Service Unavailable", { status: 503 });
      },
      retry: {
        backoff: 2,
        delayMs: 10_000,
        onRetry: () => {
          queueMicrotask(() => {
            delayController.abort(new Error("cancelled in backoff"));
          });
        },
        times: 3,
      },
      validator: isUserSample,
    });

    const delayExit = await delayTask.runExit({ clock, signal: delayController.signal });
    assert.equal(delayAttempts, 1);
    assert.equal(
      Match.valueTags(delayExit, {
        Failure: ({ cause }) => Cause.hasInterrupts(cause),
        Success: () => false,
      }),
      true,
    );
  });

  it("propagates Task interruption and awaits scope cleanup on timeout or cancellation", async () => {
    const events: string[] = [];
    let observedAbort = false;
    const clock = Clock.virtual();

    const workflow = ResultTask.scoped(
      ResultTask.gen(function* scopedRequestWorkflow() {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            events.push("acquire");
            return "lease";
          }),
          release: () =>
            ResultTask.sync(() => {
              events.push("release");
            }),
        });

        return yield* requestJson({
          request: (signal) =>
            new Promise<Response>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  events.push("transport-aborted");
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            }),
          retry: { delayMs: 100, times: 3 },
          validator: isUserSample,
        });
      }),
    );

    const timed = ResultTask.timeout(
      workflow,
      50,
      () => new MappedRequestJsonError("timeout", "Request timed out"),
    );

    const pending = timed.runResult({ clock });
    await clock.advanceBy(50);
    const outcome = await pending;

    assert.ok(outcome.isErr());
    assert.equal(observedAbort, true);
    assert.deepEqual(events, ["acquire", "transport-aborted", "release"]);
    assert.equal(outcome.error.message, "Request timed out");

    const controller = new AbortController();
    controller.abort();
    const interruptedExit = await workflow.runExit({ signal: controller.signal });
    const wasInterrupted = Match.valueTags(interruptedExit, {
      Failure: ({ cause }) => Cause.hasInterrupts(cause),
      Success: () => false,
    });
    assert.equal(wasInterrupted, true);
  });

  it("defers mapError.request lazily when request is not a function", async () => {
    let mapCalls = 0;
    const task = requestJsonUnsafe({
      mapError: createMapError({
        request: ({ cause }) => {
          mapCalls += 1;
          return new MappedRequestJsonError("request", cause.message);
        },
      }),
      request: Promise.resolve(createFetchResponse(userSample)),
      validator: isUserSample,
    });

    assert.equal(mapCalls, 0);

    const outcome = await task.runResult();
    assert.equal(mapCalls, 1);
    assert.ok(outcome.isErr());
    assert.equal(
      expectMappedError(outcome.error).message,
      "JSON request requires a request factory",
    );
  });

  it("aborts and cancels stalled response bodies during json() and text() without hanging or unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // 1. Stalled Fetch 200 json() with cancelable body and timeout
      let jsonCanceled = false;
      const jsonDeferred = Promise.withResolvers<unknown>();
      const stalledJsonTask = ResultTask.timeout(
        requestJson({
          request: async () => ({
            body: {
              cancel: () => {
                jsonCanceled = true;
                jsonDeferred.reject(new Error("late body cancel rejection"));
                return Promise.reject(new Error("cancel promise rejection"));
              },
            },
            headers: {},
            json: () => jsonDeferred.promise,
            status: 200,
            text: async () => "",
          }),
          validator: isUserSample,
        }),
        25,
        () => new MappedRequestJsonError("timeout", "JSON body timed out"),
      );
      const jsonOutcome = await stalledJsonTask.runResult();
      assert.ok(jsonOutcome.isErr());
      assert.equal(jsonOutcome.error.message, "JSON body timed out");
      assert.equal(jsonCanceled, true);

      // 2. Stalled Undici 500 text() with destroyable body and explicit AbortController
      let textDestroyed = false;
      const textDeferred = Promise.withResolvers<string>();
      const textController = new AbortController();
      const stalledTextTask = requestJson({
        request: async () => ({
          body: {
            destroy: () => {
              textDestroyed = true;
              textDeferred.reject(new Error("late text destroy rejection"));
            },
            json: async () => ({}),
            text: () => {
              textController.abort(new Error("aborted while reading error text"));
              return textDeferred.promise;
            },
          },
          headers: {},
          statusCode: 500,
        }),
        validator: isUserSample,
      });
      const textExit = await stalledTextTask.runExit({ signal: textController.signal });
      assert.equal(textDestroyed, true);
      assert.equal(
        Match.valueTags(textExit, {
          Failure: ({ cause }) => Cause.hasInterrupts(cause),
          Success: () => false,
        }),
        true,
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([200, 500])(
    "cancels and unlocks a stalled native Fetch body with status %i",
    async (status) => {
      const reading = Promise.withResolvers<void>();
      const clock = Clock.virtual();
      let canceled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel() {
            canceled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, { status });
      const timed = ResultTask.timeout(
        requestJson({ request: async () => response, validator: isUserSample }),
        25,
        () => new MappedRequestJsonError("timeout", "Fetch body timed out"),
      ).runResult({ clock });

      await reading.promise;
      assert.equal(body.locked, true);
      await clock.advanceBy(25);
      const outcome = await timed;
      assert.ok(outcome.isErr());
      assert.equal(outcome.error.message, "Fetch body timed out");
      assert.equal(canceled, true);
      assert.equal(body.locked, false);
    },
  );

  it("decodes split UTF-8 characters and a leading BOM in native Fetch JSON", async () => {
    const value = { ...userSample, name: "José" };
    const bytes = new TextEncoder().encode(`\uFEFF${JSON.stringify(value)}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const result = await requestJson({
      request: async () => new Response(body),
      validator: isUserSample,
    }).runResult();

    assert.ok(result.isOk());
    assert.deepEqual(result.value, value);
  });
});
