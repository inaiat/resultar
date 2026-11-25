import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appConfigProperties } from "../src/app-config.ts";
import { defineAppConfig, ResultTask } from "resultar-app";
import { createServices, UserReadError } from "../src/services.ts";
import { createApplication } from "../src/main.ts";
const testConfig = defineAppConfig({ properties: appConfigProperties, source: {} });
const app = createApplication(createServices(testConfig));
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
const independent = createApplication(createServices(testConfig));
try {
  const health = await independent.request("/health");
  assert.deepEqual(await health.json(), { status: "ok", users: 1 });
} finally {
  assert.equal((await independent.close()).isOk(), true);
}

const brokenRepository = {
  findById: () => UserReadError.taskErr({ id: "1" }),
  remove: () => ResultTask.ok(false),
};
const broken = createApplication(
  createServices(testConfig).override("repository", brokenRepository),
);
try {
  const response = await broken.request("/users/1");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Temporarily unavailable" });
} finally {
  assert.equal((await broken.close()).isOk(), true);
}
console.log("Hono example passed: local services, routes, isolation, failures and cleanup.");

// Explicit maps isolate tests from the host environment and retain schema inference.
const defaults = await defineAppConfig({ properties: appConfigProperties, source: {} })
  .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
  .runPromise();
assert.equal(defaults.PORT, 3000);

let reads = 0;
const source = {
  get PORT() {
    reads += 1;
    return "9000";
  },
};
const configuredServices = createServices(
  defineAppConfig({ properties: appConfigProperties, source }),
);
const configured = createApplication(configuredServices);
assert.equal(reads, 0);
try {
  for (const route of ["/health", "/users/1"]) {
    const response = await configured.request(route);
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(reads, 1);
} finally {
  assert.equal((await configured.close()).isOk(), true);
}
const port = await configuredServices
  .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig.PORT))
  .runPromise();
assert.equal(port, 9000);

// Exercise the actual executable: malformed configuration must exit before listen.
for (const invalidPort of ["invalid-port-secret", "1e309", "0", "65536"]) {
  const child = spawnSync(process.execPath, ["--import", "vite-plus/register", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: invalidPort },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout.includes("Listening on"), false);
  assert.match(child.stderr, /Invalid application configuration/u);
  if (invalidPort === "invalid-port-secret")
    assert.equal(child.stderr.includes(invalidPort), false);
}
console.log("Hono configuration passed: defaults, injection, root cache and startup rejection.");
