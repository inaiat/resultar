/* eslint-disable unicorn/no-null */
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";
import { expect, test } from "vite-plus/test";
import { ResultTask } from "resultar";
import { createModule, resource } from "resultar-di";
import { createNestApp, Services } from "../src/index.js";

function serverUrl(server: { address: () => string | AddressInfo | null }): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function fixture(requestHook: "guard" | "interceptor") {
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
  return { services: createModule().scoped(Local), requestHook, releases: () => releases };
}

test.each(["guard", "interceptor"] as const)(
  "%s keeps the scope alive after a real JSON request body finishes",
  async (requestHook) => {
    const { services, releases } = fixture(requestHook);

    @Controller()
    class UploadController {
      @Post()
      @HttpCode(201)
      async create(@Services() reqServices: { local: { closed: boolean } }, @Body() body: unknown) {
        const { local } = reqServices;
        await setImmediate();
        expect(local.closed).toBe(false);
        return body;
      }
    }

    const app = createNestApp({
      services,
      bindings: ["local"],
      requestHook,
      controllers: [UploadController],
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = serverUrl(app.server);
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
  const { services, releases } = fixture("interceptor");
  const stream = new PassThrough();

  @Controller()
  class StreamUploadController {
    @Post()
    @HttpCode(200)
    create(@Res() res: { status: (code: number) => void; raw: NodeJS.WritableStream }) {
      res.status(200);
      stream.write("first");
      stream.pipe(res.raw);
    }
  }

  const app = createNestApp({
    services,
    bindings: ["local"],
    requestHook: "interceptor",
    controllers: [StreamUploadController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
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
