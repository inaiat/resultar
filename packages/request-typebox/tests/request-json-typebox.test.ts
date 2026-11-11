import { strict as assert } from "node:assert";
import { Cause, Match, type ResultAsync, type ResultTask } from "resultar";
import { Type, type Static } from "typebox";
import { describe, it } from "vite-plus/test";

import {
  requestJson,
  requestJsonTask,
  requestJsonTypeBox,
  requestJsonTypeBoxTask,
  RequestError,
} from "../src/index.js";

const userSchema = Type.Object({ email: Type.String(), name: Type.String() });

type UserSample = Static<typeof userSchema>;

const userSample = { email: "elizeu.drummond@telerj.br", name: "Elizeu Drummond" };

const createFetchResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const expectRequestError = (error: Error) => {
  assert.ok(error instanceof RequestError);

  return error;
};

const expectType = <T>(value: T) => value;

describe("requestJsonTypeBox", () => {
  it("given valid TypeBox payload, then returns Static schema type", async () => {
    const result = requestJson({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });

    expectType<ResultAsync<UserSample, RequestError>>(result);

    const awaited = await result;

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given adapter helper name, then returns the same behavior", async () => {
    const result = await requestJsonTypeBox({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
  });

  it("given invalid TypeBox payload, then returns validation error context", async () => {
    const invalidPayload = { name: userSample.name };
    let receivedErrorCount = 0;

    const result = await requestJson({
      request: async () => createFetchResponse(invalidPayload),
      schema: userSchema,
      validationError: ({ errors }) => {
        receivedErrorCount = errors.length;

        return `User API returned ${errors.length} schema errors`;
      },
    });

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "User API returned 1 schema errors");
    assert.equal(receivedErrorCount, 1);
  });

  it("given invalid TypeBox payload, then preserves error code, path, and message", async () => {
    const invalidPayload = { email: 123, name: "Elizeu Drummond" };
    let capturedErrors: readonly unknown[] = [];

    const result = await requestJson({
      request: async () => createFetchResponse(invalidPayload),
      schema: userSchema,
      validationError: ({ errors }) => {
        capturedErrors = errors;

        return "Validation failed";
      },
    });

    assert.ok(result.isErr());
    assert.equal(capturedErrors.length, 1);
    assert.deepEqual(capturedErrors[0], {
      code: "type",
      message: "must be string",
      path: "/email",
    });
  });

  it("propagates signal cancellation through requestJsonTypeBox retries", async () => {
    const controller = new AbortController();
    const customReason = new Error("typebox request cancelled");
    controller.abort(customReason);
    let attempts = 0;

    const result = await requestJsonTypeBox({
      request: async () => {
        attempts += 1;
        return createFetchResponse(userSample);
      },
      retry: { delayMs: 10, times: 2 },
      schema: userSchema,
      signal: controller.signal,
    });

    assert.equal(attempts, 0);
    assert.ok(result.isErr());
    const error = expectRequestError(result.error);
    assert.equal(error.cause, customReason);
  });

  it("supports lazy, repeatable requestJsonTypeBoxTask and requestJsonTask", async () => {
    let calls = 0;
    const task = requestJsonTypeBoxTask({
      request: async (signal) => {
        assert.equal(signal.aborted, false);
        calls += 1;
        return createFetchResponse({ ...userSample, name: `Run ${calls}` });
      },
      schema: userSchema,
    });

    expectType<ResultTask<UserSample, RequestError>>(task);
    assert.equal(calls, 0);

    const first = await task.runPromise();
    const second = await task.runPromise();
    assert.equal(first.name, "Run 1");
    assert.equal(second.name, "Run 2");
    assert.equal(calls, 2);

    const aliasTask = requestJsonTask({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });
    expectType<ResultTask<UserSample, RequestError>>(aliasTask);

    const controller = new AbortController();
    controller.abort();
    const exit = await aliasTask.runExit({ signal: controller.signal });
    const wasInterrupted = Match.valueTags(exit, {
      Failure: ({ cause }) => Cause.hasInterrupts(cause),
      Success: () => false,
    });
    assert.equal(wasInterrupted, true);
  });
});
