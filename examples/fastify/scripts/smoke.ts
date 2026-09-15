import assert from "node:assert/strict";
import { errAsync, ResultAsync, ResultTask } from "resultar";
import { createApplication } from "../src/main.ts";
import {
  createServices,
  Health,
  Cache,
  Users,
  UsersRepository,
  UserReadError,
} from "../src/services.ts";

const cache = await ResultTask.runPromise(Cache.make);
const repository = await ResultTask.runPromise(UsersRepository.make.provideServices({ cache }));
const healthService = await ResultTask.runPromise(Health.make.provideServices({ cache }));
assert.deepEqual(await healthService.check().unwrapOrThrow(), { status: "ok", users: 1 });
cache.set("2", { id: "2", name: "Grace" });
assert.deepEqual(await healthService.check().unwrapOrThrow(), { status: "ok", users: 2 });
assert.equal(
  await repository
    .findById("2")
    .map((user) => user?.name)
    .unwrapOrThrow(),
  "Grace",
);
const repositoryLookup = repository.findById("1");
assert.ok(repositoryLookup instanceof ResultAsync);
assert.equal(await repositoryLookup.map((user) => user?.name).unwrapOrThrow(), "Ada");
const service = await ResultTask.runPromise(Users.make.provideServices({ repository }));
const lookup = service.findById("1");
assert.ok(lookup instanceof ResultAsync);
assert.equal(await lookup.map((user) => user.name).unwrapOrThrow(), "Ada");
const app = createApplication();
try {
  const health = await app.inject("/health");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok", users: 1 });
  const found = await app.inject("/users/1");
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), { id: "1", name: "Ada" });
  const missing = await app.inject("/users/2");
  assert.equal(missing.statusCode, 404);
} finally {
  await app.close();
}

const cause = new Error("offline");
const readError = new UserReadError({ id: "1", cause });
const brokenRepository = { ...repository, findById: () => errAsync(readError) };
const brokenService = await ResultTask.runPromise(
  Users.make.provideServices({ repository: brokenRepository }),
);
const failedLookup = await brokenService.findById("1");
assert.ok(failedLookup.isErr());
assert.equal(failedLookup.error, readError);
assert.equal(failedLookup.error.cause, cause);
const broken = createApplication(createServices().override("repository", brokenRepository));
try {
  assert.equal((await broken.inject("/users/1")).statusCode, 503);
} finally {
  await broken.close();
}
process.stdout.write(
  "Native Fastify routes, class services, functional health and shared cache passed.\n",
);
