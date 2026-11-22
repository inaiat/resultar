import { strict as assert } from "node:assert";
import { AbortError, Cause, Match, type ResultTask } from "resultar";
import { Type, type Static } from "typebox";
import { describe, expectTypeOf, it } from "vite-plus/test";

import {
  requestJson,
  requestJsonTypeBox,
  RequestError,
  t,
  type RequestJsonMapError,
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

class MappedTypeBoxError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "MappedTypeBoxError";
  }
}

const expectType = <T>(value: T) => value;

describe("requestJsonTypeBox", () => {
  it("reexports TypeBox as t with exact ResultTask inference", async () => {
    assert.equal(t, Type);
    const schema = t.Object({
      name: Type.String(),
      plan: t.Union([t.Literal("free"), t.Literal("team")]),
      email: t.Optional(t.String()),
    });
    type Account = t.Static<typeof schema>;
    expectTypeOf<Account>().toEqualTypeOf<{
      name: string;
      plan: "free" | "team";
      email?: string;
    }>();
    const payload = { name: "Ada", plan: "team" };
    let calls = 0;
    const request = async (signal: AbortSignal) => {
      assert.equal(signal.aborted, false);
      calls += 1;
      return createFetchResponse(payload);
    };
    const task = requestJson({ request, schema });
    expectTypeOf(task).toEqualTypeOf<ResultTask<Account, RequestError>>();
    assert.equal(calls, 0);
    assert.deepEqual(await task.runPromise(), payload);
    assert.equal(calls, 1);

    const second = await task.runResult();
    assert.ok(second.isOk());
    assert.deepEqual(second.value, payload);
    assert.equal(calls, 2);
  });

  it("given valid TypeBox payload, then returns lazy ResultTask with Static schema type", async () => {
    const task = requestJson({
      request: async () => createFetchResponse(userSample),
      schema: userSchema,
    });

    expectType<ResultTask<UserSample, RequestError>>(task);

    const awaited = await task.runResult();

    assert.ok(awaited.isOk());
    assert.deepEqual(awaited.value, userSample);
  });

  it("given adapter helper name, then supports lazy repeatable execution", async () => {
    let calls = 0;
    const task = requestJsonTypeBox({
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
  });

  it("given mapError, then infers mapped error union on ResultTask", async () => {
    const mapError = {
      404: () => new MappedTypeBoxError("not-found", "missing"),
      http: ({ statusCode }) => new MappedTypeBoxError("http", String(statusCode)),
      invalidJson: ({ cause }) => new MappedTypeBoxError("invalid-json", cause.message),
      request: ({ cause }) => new MappedTypeBoxError("request", cause.message),
      validation: ({ message }) => new MappedTypeBoxError("validation", message),
    } satisfies RequestJsonMapError;

    const task = requestJsonTypeBox({
      mapError,
      request: async () => createFetchResponse("Not Found", 404),
      schema: userSchema,
    });

    expectType<ResultTask<UserSample, MappedTypeBoxError>>(task);

    const result = await task.runResult();
    assert.ok(result.isErr());
    assert.ok(result.error instanceof MappedTypeBoxError);
    assert.equal(result.error.kind, "not-found");
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
    }).runResult();

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
    }).runResult();

    assert.ok(result.isErr());
    assert.equal(capturedErrors.length, 1);
    assert.deepEqual(capturedErrors[0], {
      code: "type",
      message: "must be string",
      path: "/email",
    });
  });

  it("propagates Task runner signal cancellation through requestJsonTypeBox retries", async () => {
    const controller = new AbortController();
    const customReason = new Error("typebox request cancelled");
    controller.abort(customReason);
    let attempts = 0;

    const task = requestJsonTypeBox({
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

  it("matches identically across cached JIT and RESULTAR_JIT=0 fallback modes", async () => {
    const schema = Type.Object({ id: Type.Number(), tags: Type.Array(Type.String()) });
    const valid = { id: 7, tags: ["fast", "jit"] };
    const invalid = { id: "bad", tags: [123] };

    const runWithMode = async (mode: "1" | "0") => {
      const previous = process.env.RESULTAR_JIT;
      process.env.RESULTAR_JIT = mode;
      try {
        const firstValid = await requestJsonTypeBox({
          request: async () => createFetchResponse(valid),
          schema,
        }).runResult();
        const secondValid = await requestJsonTypeBox({
          request: async () => createFetchResponse(valid),
          schema,
        }).runResult();
        let capturedErrors: readonly unknown[] = [];
        const invalidRes = await requestJsonTypeBox({
          request: async () => createFetchResponse(invalid),
          schema,
          validationError: ({ errors }) => {
            capturedErrors = errors;
            return "invalid";
          },
        }).runResult();
        return {
          firstOk: firstValid.isOk() ? firstValid.value : undefined,
          secondOk: secondValid.isOk() ? secondValid.value : undefined,
          invalidIsErr: invalidRes.isErr(),
          capturedErrors,
        };
      } finally {
        if (previous === undefined) {
          delete process.env.RESULTAR_JIT;
        } else {
          process.env.RESULTAR_JIT = previous;
        }
      }
    };

    const jit = await runWithMode("1");
    const fallback = await runWithMode("0");

    assert.deepEqual(jit, fallback);
    assert.deepEqual(jit.firstOk, valid);
    assert.deepEqual(jit.secondOk, valid);
    assert.equal(jit.invalidIsErr, true);
    assert.equal(jit.capturedErrors.length, 2);
  });
});
