import { strict as assert } from "node:assert";
import { AbortError, Cause, Match, type ResultTask } from "resultar";
import { describe, it } from "vite-plus/test";
import { z } from "zod";

import {
  requestJson,
  requestJsonZod,
  RequestError,
  type RequestJsonMapError,
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

class MappedZodError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "MappedZodError";
  }
}

const expectType = <T>(value: T) => value;

describe("requestJsonZod", () => {
  it("given valid Zod payload, then returns lazy ResultTask with z.output schema type", async () => {
    let calls = 0;
    const task = requestJson({
      request: async (signal) => {
        assert.equal(signal.aborted, false);
        calls += 1;

        return createFetchResponse(userSample);
      },
      schema: userSchema,
    });

    expectType<ResultTask<z.output<typeof userSchema>, RequestError>>(task);
    assert.equal(calls, 0);

    const awaited = await task.runResult();

    assert.equal(calls, 1);
    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given transform schema, then returns lazy repeatable ResultTask with parsed output", async () => {
    let calls = 0;
    const task = requestJsonZod({
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
  });

  it("given mapError, then infers mapped error union on ResultTask", async () => {
    const mapError = {
      404: () => new MappedZodError("not-found", "missing"),
      http: ({ statusCode }) => new MappedZodError("http", String(statusCode)),
      invalidJson: ({ cause }) => new MappedZodError("invalid-json", cause.message),
      request: ({ cause }) => new MappedZodError("request", cause.message),
      validation: ({ message }) => new MappedZodError("validation", message),
    } satisfies RequestJsonMapError;

    const task = requestJsonZod({
      mapError,
      request: async () => createFetchResponse("Not Found", 404),
      schema: userSchema,
    });

    expectType<ResultTask<z.output<typeof userSchema>, MappedZodError>>(task);

    const result = await task.runResult();
    assert.ok(result.isErr());
    assert.ok(result.error instanceof MappedZodError);
    assert.equal(result.error.kind, "not-found");
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
    }).runResult();

    assert.ok(result.isErr());
    const error = expectRequestError(result.error);

    assert.equal(error.message, "User API returned 1 schema errors");
    assert.equal(receivedErrorCount, 1);
  });

  it("propagates Task runner signal cancellation through requestJsonZod and requestJson", async () => {
    const controller = new AbortController();
    const customReason = new Error("zod request cancelled");
    controller.abort(customReason);
    let attempts = 0;

    const task = requestJsonZod({
      request: async () => {
        attempts += 1;
        return createFetchResponse(userSample);
      },
      retry: { delayMs: 10, times: 2 },
      schema: userSchema,
    });

    const exit = await task.runExit({ signal: controller.signal });
    const wasInterrupted = Match.valueTags(exit, {
      Failure: ({ cause }) => Cause.hasInterrupts(cause),
      Success: () => false,
    });
    assert.equal(attempts, 0);
    assert.equal(wasInterrupted, true);

    await assert.rejects(task.runResult({ signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof AbortError);
      assert.equal(error.cause, customReason);

      return true;
    });
    assert.equal(attempts, 0);
  });
});
