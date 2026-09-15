/* eslint-disable unicorn/no-await-expression-member */
import { errAsync, okAsync } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { createApplication, type AppHono } from "../../../examples/hono/src/main.js";
import { createServices, UserReadError } from "../../../examples/hono/src/services.js";
import type { InferRequestServices } from "../src/index.js";

test("the actual Hono example infers AppHono and serves lookup, deletion and health", async () => {
  type Services = InferRequestServices<typeof createApplication>;
  expectTypeOf<keyof Services>().toEqualTypeOf<"cache" | "repository" | "users" | "health">();
  expectTypeOf<AppHono>().toHaveProperty("get");
  const app = createApplication();
  const independent = createApplication();
  expect(await (await app.request("/health")).json()).toEqual({ status: "ok", users: 1 });
  expect(await (await app.request("/users/1")).json()).toEqual({ id: "1", name: "Ada" });
  expect((await app.request("/users/1", { method: "DELETE" })).status).toBe(204);
  const missing = await app.request("/users/1");
  expect(missing.status).toBe(404);
  await missing.text();
  const removed = await app.request("/users/1", { method: "DELETE" });
  expect(removed.status).toBe(404);
  await removed.text();
  expect(await (await app.request("/health")).json()).toEqual({ status: "ok", users: 0 });
  expect(await (await independent.request("/health")).json()).toEqual({ status: "ok", users: 1 });
  expect((await app.close()).isOk()).toBe(true);
  expect((await independent.close()).isOk()).toBe(true);
});

test("the Hono example maps an overridden repository failure to 503", async () => {
  const repository = {
    findById: () => errAsync(new UserReadError({ id: "1" })),
    remove: () => okAsync(false),
  };
  const app = createApplication(createServices().override("repository", repository));
  const response = await app.request("/users/1");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Temporarily unavailable" });
  expect((await app.close()).isOk()).toBe(true);
});
