import assert from "node:assert/strict";
import { createApplication } from "../src/app.ts";
import { createUsersService } from "../src/users.ts";

const repository = {
  findById: async (id: string) => (id === "1" ? { id, name: "Ada" } : undefined),
};
const service = createUsersService({ repository });
assert.equal((await service.findById("1")).isOk(), true);
const app = await createApplication(repository);
try {
  const found = await app.inject("/users/1");
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), { id: "1", name: "Ada" });
  const missing = await app.inject("/users/2");
  assert.equal(missing.statusCode, 404);
} finally {
  await app.close();
}

const broken = await createApplication({ findById: () => Promise.reject(new Error("offline")) });
try {
  assert.equal((await broken.inject("/users/1")).statusCode, 503);
} finally {
  await broken.close();
}
process.stdout.write("Native Fastify routes, TypeBox schemas and plain services passed.\n");
