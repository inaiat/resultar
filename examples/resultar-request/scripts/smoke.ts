import { strict as assert } from "node:assert";

import {
  loadAccountWithTypeBox,
  loadAccountWithZod,
  loadAccountWithZodAfterRetry,
  TypeBoxAccountApiError,
  ZodAccountApiError,
  type AccountFromTypeBox,
  type AccountFromZod,
} from "../src/index.js";
import { closeServer, startAccountExampleServer } from "./server.js";

const expectTypeBoxError = (error: Error) => {
  assert.equal(error instanceof TypeBoxAccountApiError, true);

  return error as TypeBoxAccountApiError;
};

const expectZodError = (error: Error) => {
  assert.equal(error instanceof ZodAccountApiError, true);

  return error as ZodAccountApiError;
};

const { baseUrl, server } = await startAccountExampleServer();

try {
  const typeBoxAccountResult = await loadAccountWithTypeBox(baseUrl, "team");

  assert.equal(typeBoxAccountResult.isOk(), true);

  if (typeBoxAccountResult.isOk()) {
    const account: AccountFromTypeBox = typeBoxAccountResult.value;

    assert.equal(account.id, "acct_team");
    assert.equal(account.email, "ADA@EXAMPLE.COM");
    assert.equal(account.seats, 8);
  }

  const missingTypeBoxAccount = await loadAccountWithTypeBox(baseUrl, "missing");

  assert.equal(missingTypeBoxAccount.isErr(), true);

  if (missingTypeBoxAccount.isErr()) {
    const error = expectTypeBoxError(missingTypeBoxAccount.error);

    assert.equal(error.reason, "not-found");
    assert.match(error.message, /404/u);
  }

  const malformedTypeBoxAccount = await loadAccountWithTypeBox(baseUrl, "malformed");

  assert.equal(malformedTypeBoxAccount.isErr(), true);

  if (malformedTypeBoxAccount.isErr()) {
    const error = expectTypeBoxError(malformedTypeBoxAccount.error);

    assert.equal(error.reason, "validation");
  }

  const invalidJsonTypeBoxAccount = await loadAccountWithTypeBox(baseUrl, "invalid-json");

  assert.equal(invalidJsonTypeBoxAccount.isErr(), true);

  if (invalidJsonTypeBoxAccount.isErr()) {
    const error = expectTypeBoxError(invalidJsonTypeBoxAccount.error);

    assert.equal(error.reason, "invalid-json");
  }

  const zodAccountResult = await loadAccountWithZod(baseUrl, "team");

  assert.equal(zodAccountResult.isOk(), true);

  if (zodAccountResult.isOk()) {
    const account: AccountFromZod = zodAccountResult.value;

    assert.equal(account.email, "ada@example.com");
    assert.equal(account.seatLabel, "8 seats");
  }

  const retriedZodAccount = await loadAccountWithZodAfterRetry(baseUrl);

  assert.equal(retriedZodAccount.isOk(), true);

  if (retriedZodAccount.isOk()) {
    assert.equal(retriedZodAccount.value.id, "acct_team");
  }

  const malformedZodAccount = await loadAccountWithZod(baseUrl, "malformed");

  assert.equal(malformedZodAccount.isErr(), true);

  if (malformedZodAccount.isErr()) {
    const error = expectZodError(malformedZodAccount.error);

    assert.equal(error.reason, "validation");
  }

  process.stdout.write("Resultar request TypeBox/Zod server smoke passed.\n");
} finally {
  await closeServer(server);
}
