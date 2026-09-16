import Fastify from "fastify";
import { ResultTask } from "resultar";
import { createModule, resource } from "resultar-di";
import { expect, test } from "vite-plus/test";
import { createFastifyPlugin } from "../src/index.js";

test("provides and releases services for child routes registered before DI", async () => {
  const app = Fastify();
  let acquired = 0;
  let released = 0;
  const Local = resource("local", {
    acquire: ResultTask.sync(() => {
      acquired += 1;
      return acquired;
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  await app.register(async (docs) => {
    docs.get("/docs", (request) => request.getDecorator("services"));
    docs.get("/docs/direct", (request) => (request as unknown as { services: unknown }).services);
  });
  await app.register(createFastifyPlugin({ services: createModule().scoped(Local) }));
  app.get("/api/items", (request) => (request as unknown as { services: unknown }).services);
  try {
    const first = await app.inject("/docs");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ local: 1 });
    const direct = await app.inject("/docs/direct");
    expect(direct.statusCode).toBe(200);
    expect(direct.json()).toEqual({ local: 2 });
    const after = await app.inject("/api/items");
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ local: 3 });
    const third = await app.inject("/docs");
    expect(third.json()).toEqual({ local: 4 });
    expect(released).toBe(4);
  } finally {
    await app.close();
  }
});
