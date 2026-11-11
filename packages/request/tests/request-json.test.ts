import { strict as assert } from "node:assert";
import { Cause, Clock, Match, ResultTask, type ResultAsync } from "resultar";
import { describe, it } from "vite-plus/test";

import {
  isHttpResponseError,
  requestJson,
  requestJsonTask,
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

  it("given circular object or BigInt in exception, RequestError.exception serializes safely without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const circularError = RequestError.exception(circular, 500);
    assert.equal(circularError.statusCode, 500);
    assert.equal(circularError.message, "[object Object]");

    const bigintError = RequestError.exception(123n, 500);
    assert.equal(bigintError.statusCode, 500);
    assert.equal(bigintError.message, "123");

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
    });

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
    });

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
    });

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
    });

    assert.ok(resultSignal.isErr());
    const errorSignal = expectRequestError(resultSignal.error);
    assert.equal(errorSignal.message, "signal timeout");
    assert.equal(errorSignal.statusCode, 408);
    assert.equal(errorSignal.cause, abortTimeoutError);
  });

  it("given pre-aborted signal, then skips request attempt and preserves custom abort reason", async () => {
    const controller = new AbortController();
    const customReason = new Error("caller cancelled before attempt");
    controller.abort(customReason);
    let attempts = 0;

    const result = await requestJson({
      request: async () => {
        attempts += 1;

        return createFetchResponse(userSample);
      },
      retry: { delayMs: 10, times: 2 },
      signal: controller.signal,
      validator: isUserSample,
    });

    assert.equal(attempts, 0);
    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, "caller cancelled before attempt");
    assert.equal(error.cause, customReason);
  });

  it("given signal aborts during retry delay, then cancels immediately without starting next attempt", async () => {
    const controller = new AbortController();
    const customReason = { code: "CANCELLED_IN_BACKOFF" };
    let attempts = 0;

    const pending = requestJson({
      request: async () => {
        attempts += 1;

        return createFetchResponse("Service Unavailable", { status: 503 });
      },
      retry: {
        backoff: 2,
        delayMs: 10_000,
        onRetry: () => {
          setTimeout(() => {
            controller.abort(customReason);
          }, 5);
        },
        times: 3,
      },
      signal: controller.signal,
      validator: isUserSample,
    });

    const result = await pending;

    assert.equal(attempts, 1);
    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.message, '{"code":"CANCELLED_IN_BACKOFF"}');
    assert.equal(error.cause, customReason);
  });

  it("given signal aborts during attempt, then stops scheduling retries even when custom when returns true", async () => {
    const controller = new AbortController();
    let attempts = 0;

    const result = await requestJson({
      mapError: createMapError({
        request: ({ cause, error }) =>
          new MappedRequestJsonError("request", error.message, { cause }),
      }),
      request: (signal) => {
        attempts += 1;
        assert.equal(signal, controller.signal);
        controller.abort(new Error("aborted in flight"));

        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      retry: { delayMs: 0, times: 3, when: () => true },
      signal: controller.signal,
      validator: isUserSample,
    });

    assert.equal(attempts, 1);
    assert.ok(result.isErr());
    const error = expectMappedError(result.error);
    assert.equal(error.kind, "request");
    assert.equal(error.message, "aborted in flight");
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
    });

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
    });

    assert.equal(attempts, 2);
    assert.ok(retried.isOk());

    const mapped = await requestJson({
      mapError: createMapError(),
      request: async () => {
        throw new SyntaxError("Invalid header token");
      },
      validator: isUserSample,
    });

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
    });

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
    });

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
      });

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
    });

    assert.ok(ordinary.isErr());
    const ordinaryError = expectRequestError(ordinary.error);
    assert.ok(isHttpResponseError(ordinaryError));
    assert.equal(
      ordinaryError.cause.message,
      JSON.stringify({
        body: "Bad Gateway",
        headers: new Response("", { headers: serializableHeaders }).headers,
        statusCode: 502,
      }),
    );
  });

  it("given pre-started rejecting Promise and cancelled or early-failing call, then never emits unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const preAborted = new AbortController();
      const abortReason = new Error("already cancelled");
      preAborted.abort(abortReason);

      const asyncRejectingPromise = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("late transport failure"));
        }, 5);
      });
      const preAbortedResult = await requestJson({
        request: asyncRejectingPromise,
        signal: preAborted.signal,
        validator: isUserSample,
      });

      assert.ok(preAbortedResult.isErr());
      assert.equal(expectRequestError(preAbortedResult.error).cause, abortReason);

      const immediateRejected = Promise.reject<Response>(new Error("already rejected"));
      const immediateResult = await requestJson({
        request: immediateRejected,
        signal: preAborted.signal,
        validator: isUserSample,
      });
      assert.ok(immediateResult.isErr());

      const syncAbortController = new AbortController();
      const syncAbortPromise = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("post-abort transport rejection"));
        }, 5);
      });
      const syncAbortPending = requestJson({
        request: syncAbortPromise,
        signal: syncAbortController.signal,
        validator: isUserSample,
      });
      syncAbortController.abort(new Error("aborted immediately after call"));
      const syncAbortResult = await syncAbortPending;
      assert.ok(syncAbortResult.isErr());

      const retryRejected = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("rejected with invalid retry config"));
        }, 5);
      });
      const retryResult = await requestJson({
        request: retryRejected,
        retry: { times: 1 },
        validator: isUserSample,
      });
      assert.ok(retryResult.isErr());

      const missingDecoderRejected = new Promise<Response>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("rejected with missing decoder"));
        }, 5);
      });
      const missingDecoderResult = await requestJsonUnsafe({ request: missingDecoderRejected });
      assert.ok(missingDecoderResult.isErr());

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });

      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("given synchronous abort immediately after calling requestJson, then never invokes request factory", async () => {
    const directController = new AbortController();
    const directReason = new Error("cancelled before microtask");
    let directCalls = 0;

    const directPending = requestJson({
      request: async () => {
        directCalls += 1;

        return createFetchResponse(userSample);
      },
      signal: directController.signal,
      validator: isUserSample,
    });
    directController.abort(directReason);
    const directResult = await directPending;

    assert.equal(directCalls, 0);
    assert.ok(directResult.isErr());
    const directError = expectRequestError(directResult.error);
    assert.equal(directError.message, "cancelled before microtask");
    assert.equal(directError.cause, directReason);

    const retryController = new AbortController();
    const retryReason = new Error("cancelled retry before microtask");
    let retryCalls = 0;

    const retryPending = requestJson({
      request: async () => {
        retryCalls += 1;

        return createFetchResponse(userSample);
      },
      retry: { backoff: 2, delayMs: 10, times: 2 },
      signal: retryController.signal,
      validator: isUserSample,
    });
    retryController.abort(retryReason);
    const retryResult = await retryPending;

    assert.equal(retryCalls, 0);
    assert.ok(retryResult.isErr());
    const retryError = expectRequestError(retryResult.error);
    assert.equal(retryError.message, "cancelled retry before microtask");
    assert.equal(retryError.cause, retryReason);
  });

  it("given signal aborts during retry.when or with null reason, then preserves exact abort cause instead of prior attempt error", async () => {
    for (const decision of [false, true]) {
      const controller = new AbortController();
      const abortReason = new Error(`aborted inside retry.when (${String(decision)})`);
      let attempts = 0;

      // eslint-disable-next-line no-await-in-loop
      const result = await requestJson({
        request: async () => {
          attempts += 1;
          throw new Error("initial transport failure");
        },
        retry: {
          delayMs: 0,
          times: 2,
          when: async () => {
            await Promise.resolve();
            controller.abort(abortReason);

            return decision;
          },
        },
        signal: controller.signal,
        validator: isUserSample,
      });

      assert.equal(attempts, 1);
      assert.ok(result.isErr());
      const error = expectRequestError(result.error);
      assert.equal(error.message, abortReason.message);
      assert.equal(error.cause, abortReason);
    }

    const mappedController = new AbortController();
    const mappedAbortCause = new Error("aborted after 503 during retry.when");
    const mappedResult = await requestJson({
      mapError: createMapError({
        request: ({ cause, error }) =>
          new MappedRequestJsonError("request", error.message, { cause }),
      }),
      request: async () => createFetchResponse("Service Unavailable", { status: 503 }),
      retry: {
        backoff: 2,
        delayMs: 10,
        times: 2,
        when: () => {
          mappedController.abort(mappedAbortCause);

          return false;
        },
      },
      signal: mappedController.signal,
      validator: isUserSample,
    });

    assert.ok(mappedResult.isErr());
    const mappedError = expectMappedError(mappedResult.error);
    assert.equal(mappedError.kind, "request");
    assert.equal(mappedError.message, "aborted after 503 during retry.when");
    assert.equal(mappedError.context.cause, mappedAbortCause);

    const nullReason: unknown = JSON.parse("null");
    const preNullController = new AbortController();
    preNullController.abort(nullReason);
    const preNullResult = await requestJson({
      request: async () => createFetchResponse(userSample),
      signal: preNullController.signal,
      validator: isUserSample,
    });
    assert.ok(preNullResult.isErr());
    const preNullError = expectRequestError(preNullResult.error);
    assert.equal(preNullError.message, "null");
    assert.equal(Object.is(preNullError.cause, nullReason), true);

    const inFlightNullController = new AbortController();
    const inFlightNullResult = await requestJson({
      request: () => {
        inFlightNullController.abort(nullReason);

        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      signal: inFlightNullController.signal,
      validator: isUserSample,
    });
    assert.ok(inFlightNullResult.isErr());
    const inFlightNullError = expectRequestError(inFlightNullResult.error);
    assert.equal(inFlightNullError.message, "null");
    assert.equal(Object.is(inFlightNullError.cause, nullReason), true);

    const retryWhenNullController = new AbortController();
    const retryWhenNullResult = await requestJson({
      request: async () => createFetchResponse("Service Unavailable", { status: 503 }),
      retry: {
        delayMs: 10,
        times: 2,
        when: () => {
          retryWhenNullController.abort(nullReason);

          return true;
        },
      },
      signal: retryWhenNullController.signal,
      validator: isUserSample,
    });
    assert.ok(retryWhenNullResult.isErr());
    const retryWhenNullError = expectRequestError(retryWhenNullResult.error);
    assert.equal(retryWhenNullError.message, "null");
    assert.equal(Object.is(retryWhenNullError.cause, nullReason), true);
  });
});

describe("requestJsonTask", () => {
  it("stays lazy at construction and executes fresh on every run", async () => {
    let calls = 0;

    const task = requestJsonTask({
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

    const task = requestJsonTask({
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

        return yield* requestJsonTask({
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
});
