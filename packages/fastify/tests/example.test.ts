/* eslint-disable unicorn/no-await-expression-member */
import { errAsync, okAsync } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { createApplication } from "../../../examples/fastify/src/main.js";
import { createServices, UserReadError } from "../../../examples/fastify/src/services.js";
import type { InferRequestServices } from "../src/index.js";

test("the actual Fastify example infers all bindings and serves its native routes", async () => {
  type Services = InferRequestServices<typeof createApplication>;
  expectTypeOf<keyof Services>().toEqualTypeOf<"cache" | "repository" | "users" | "health">();
  const app = createApplication();
  const independent = createApplication();
  expect(app.server.listening).toBe(false);
  const views: Services[] = [];
  app.addHook("preHandler", async (request) => {
    views.push(request.services);
  });
  expect((await app.inject("/health")).json()).toEqual({ status: "ok", users: 1 });
  expect((await app.inject("/users/1")).json()).toEqual({ id: "1", name: "Ada" });
  expect((await app.inject("/users/missing")).statusCode).toBe(404);
  expect(views[0]?.users).not.toBe(views[1]?.users);
  expect(views[0]?.repository).toBe(views[1]?.repository);
  expect(views[0]?.cache).toBe(views[1]?.cache);
  views[0]?.cache.clear();
  expect((await app.inject("/health")).json()).toEqual({ status: "ok", users: 0 });
  expect((await independent.inject("/health")).json()).toEqual({ status: "ok", users: 1 });
  await app.close();
  await independent.close();
});

test("the Fastify example maps an overridden repository failure to 503", async () => {
  const repository = {
    findById: () => errAsync(new UserReadError({ id: "1" })),
    remove: () => okAsync(false),
  };
  const app = createApplication(createServices().override("repository", repository));
  expect((await app.inject("/users/1")).statusCode).toBe(503);
  await app.close();
});
