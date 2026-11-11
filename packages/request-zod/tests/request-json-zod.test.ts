import { strict as assert } from "node:assert";
import { Cause, Match, type ResultAsync, type ResultTask } from "resultar";
import { describe, it } from "vite-plus/test";
import { z } from "zod";

import {
  requestJson,
  requestJsonTask,
  requestJsonZod,
  requestJsonZodTask,
  RequestError,
} from "../src/index.js";

const userSchema = z.object({ email: z.email(), name: z.string() });

const transformedUserSchema = z
  .object({ id: z.string() })
  .transform(({ id }) => ({ numericId: Number(id) }));

const userSample = { email: "elizeu.drummond@telerj.br", name: "Elizeu Drummond" };

const createFetchResponse = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const expectRequestError = (error: Error) => {
  assert.ok(error instanceof RequestError);

  return error;
};

const expectType = <T>(value: T) => value;

describe("requestJsonZod", () => {
  it("given valid Zod payload, then returns z.output schema type", async () => {
    const result = requestJson({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });

    expectType<ResultAsync<z.output<typeof userSchema>, RequestError>>(result);

    const awaited = await result;

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given transform schema, then returns parsed output", async () => {
    const result = requestJson({
      request: async () => createFetchResponse({ id: "42" }),
      schema: transformedUserSchema,
    });

    expectType<ResultAsync<z.output<typeof transformedUserSchema>, RequestError>>(result);

    const awaited = await result;

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, { numericId: 42 });
  });

  it("given adapter helper name, then returns the same behavior", async () => {
    const result = await requestJsonZod({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });

    assert.ok(result.isOk());
    assert.deepEqual(result.value, userSample);
  });

  it("given invalid Zod payload, then returns validation error context", async () => {
    const invalidPayload = { email: "not-an-email", name: userSample.name };
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

  it("propagates signal cancellation through requestJsonZod retries", async () => {
    const controller = new AbortController();
    const customReason = new Error("zod request cancelled");
    controller.abort(customReason);
    let attempts = 0;

    const result = await requestJsonZod({
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

  it("supports lazy, repeatable requestJsonZodTask and requestJsonTask", async () => {
    let calls = 0;
    const task = requestJsonZodTask({
      request: async (signal) => {
        assert.equal(signal.aborted, false);
        calls += 1;
        return createFetchResponse({ id: String(calls * 10) });
      },
      schema: transformedUserSchema,
    });

    expectType<ResultTask<z.output<typeof transformedUserSchema>, RequestError>>(task);
    assert.equal(calls, 0);

    assert.deepEqual(await task.runPromise(), { numericId: 10 });
    assert.deepEqual(await task.runPromise(), { numericId: 20 });
    assert.equal(calls, 2);

    const aliasTask = requestJsonTask({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });
    expectType<ResultTask<z.output<typeof userSchema>, RequestError>>(aliasTask);

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
