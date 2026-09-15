import assert from "node:assert/strict";
import { errAsync, okAsync } from "resultar";
import { createServices, UserReadError } from "../src/services.ts";
import { createApplication } from "../src/main.ts";
const app = createApplication();
try {
  const health = await app.request("/health");
  assert.deepEqual(await health.json(), { status: "ok", users: 1 });
  const found = await app.request("/users/1");
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { id: "1", name: "Ada" });
  assert.equal((await app.request("/users/1", { method: "DELETE" })).status, 204);
  const alreadyRemoved = await app.request("/users/1", { method: "DELETE" });
  assert.equal(alreadyRemoved.status, 404);
  await alreadyRemoved.text();
  const missing = await app.request("/users/1");
  assert.equal(missing.status, 404);
  await missing.text();
  const updated = await app.request("/health");
  assert.deepEqual(await updated.json(), { status: "ok", users: 0 });
} finally {
  assert.equal((await app.close()).isOk(), true);
}
const independent = createApplication();
try {
  const health = await independent.request("/health");
  assert.deepEqual(await health.json(), { status: "ok", users: 1 });
} finally {
  assert.equal((await independent.close()).isOk(), true);
}

const brokenRepository = {
  findById: () => errAsync(new UserReadError({ id: "1" })),
  remove: () => okAsync(false),
};
const broken = createApplication(createServices().override("repository", brokenRepository));
try {
  const response = await broken.request("/users/1");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Temporarily unavailable" });
} finally {
  assert.equal((await broken.close()).isOk(), true);
}
console.log("Hono example passed: local services, routes, isolation, failures and cleanup.");
