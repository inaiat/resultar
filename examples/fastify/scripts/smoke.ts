import assert from "node:assert/strict";
import Fastify from "fastify";
import { errAsync, okAsync, ResultAsync } from "resultar";
import { createApplication } from "../src/main.ts";
import { usersRoutes } from "../src/routes.ts";
import { createServices } from "../src/services.ts";
import { createUsersService, UserReadError, type UsersRepository } from "../src/users.ts";

const repository: UsersRepository = {
  findById: (id) => okAsync(id === "1" ? { id, name: "Ada" } : undefined),
};
const repositoryLookup = repository.findById("1");
assert.ok(repositoryLookup instanceof ResultAsync);
assert.equal(await repositoryLookup.map((user) => user?.name).unwrapOrThrow(), "Ada");
const service = createUsersService({ repository });
const lookup = service.findById("1");
assert.ok(lookup instanceof ResultAsync);
assert.equal(await lookup.map((user) => user.name).unwrapOrThrow(), "Ada");
const app = createApplication();
try {
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
const brokenRepository: UsersRepository = { findById: () => errAsync(readError) };
const failedLookup = await createUsersService({ repository: brokenRepository }).findById("1");
assert.ok(failedLookup.isErr());
assert.equal(failedLookup.error, readError);
assert.equal(failedLookup.error.cause, cause);
const broken = Fastify();
broken.register(createServices(brokenRepository));
broken.register(usersRoutes);
try {
  assert.equal((await broken.inject("/users/1")).statusCode, 503);
} finally {
  await broken.close();
}
process.stdout.write("Native Fastify routes, TypeBox schemas and plain services passed.\n");
