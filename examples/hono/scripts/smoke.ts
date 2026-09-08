import assert from "node:assert/strict";
import { createApplication } from "../src/app.ts";
const app = createApplication();
try {
  const health = await app.request("/health");
  assert.deepEqual(await health.json(), { status: "ok", users: 1 });
  assert.equal((await app.request("/users/1", { method: "DELETE" })).status, 204);
  const missing = await app.request("/users/1");
  assert.equal(missing.status, 404);
  await missing.text();
  const updated = await app.request("/health");
  assert.deepEqual(await updated.json(), { status: "ok", users: 0 });
} finally {
  assert.equal((await app.close()).isOk(), true);
}
console.log("Hono example passed: routes, bindings and cleanup.");
