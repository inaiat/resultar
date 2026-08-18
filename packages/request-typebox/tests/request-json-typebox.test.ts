import { strict as assert } from "node:assert";
import type { ResultAsync } from "resultar";
import { Type, type Static } from "typebox";
import { describe, it } from "vite-plus/test";

import { requestJson, requestJsonTypeBox, RequestError } from "../src/index.js";

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
});
