import Fastify from "fastify";
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { expect, test } from "vite-plus/test";
import { ResultTask } from "resultar";
import { createModule, resource } from "resultar-di";
import { createFastifyPlugin, type InferRequestServices } from "../src/index.js";

function fixture(requestHook: "onRequest" | "preHandler") {
  let releases = 0;
  const Local = resource("local", {
    acquire: ResultTask.tryPromise({
      try: async () => {
        await setImmediate();
        return { closed: false };
      },
      catch: (error) => error,
    }),
    release: (local) =>
      ResultTask.sync(() => {
        local.closed = true;
        releases += 1;
      }),
  });
  const plugin = createFastifyPlugin({
    services: createModule().scoped(Local),
    bindings: ["local"],
    requestHook,
  });
  return { plugin, releases: () => releases };
}

test.each(["onRequest", "preHandler"] as const)(
  "%s keeps the scope alive after a real JSON request body finishes",
  async (requestHook) => {
    const { plugin, releases } = fixture(requestHook);
    const app = Fastify();
    await app.register(plugin);
    app.post("/", async (request, reply) => {
      const { local } = request.getDecorator<InferRequestServices<typeof plugin>>("services");
      await setImmediate();
      expect(local.closed).toBe(false);
      return reply.code(201).send(request.body);
    });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ originalUrl: "https://example.com" }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ originalUrl: "https://example.com" });
      await expect.poll(releases).toBe(1);
    } finally {
      await app.close();
    }
    expect(releases()).toBe(1);
  },
);

test("a client disconnect after a complete JSON upload releases the streamed reply scope", async () => {
  const { plugin, releases } = fixture("preHandler");
  const app = Fastify();
  const stream = new PassThrough();
  await app.register(plugin);
  app.post("/", (_request, reply) => {
    stream.write("first");
    return reply.send(stream);
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originalUrl: "https://example.com" }),
    });
    expect(response.status).toBe(200);
    expect(releases()).toBe(0);
    await response.body?.cancel();
    await expect.poll(releases).toBe(1);
  } finally {
    stream.destroy();
    await app.close();
  }
  expect(releases()).toBe(1);
});
