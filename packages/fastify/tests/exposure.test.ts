import Fastify from "fastify";
import { ResultTask } from "resultar";
import { createModule, withProvider } from "resultar-di";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  createFastifyPlugin,
  type FastifyServicesOptions,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

describe("framework service exposure", () => {
  it("exposes lazy services in onRequest and releases them even when validation rejects", async () => {
    let opened = 0;
    let closed = 0;
    const module = withProvider(createModule(), "connection", {
      lifetime: "scoped",
      create: () => {
        opened += 1;
        return opened;
      },
      release: () =>
        ResultTask.sync(() => {
          closed += 1;
        }),
    });
    const options = {
      services: module,
      bindings: [] as const,
      requestHook: "onRequest",
      exposeApplication: () => ({ health: "ready" }),
      exposeRequest: (access) => ({ connection: () => access.get("connection").unwrapOrThrow() }),
    } satisfies FastifyServicesOptions;
    const plugin = createFastifyPlugin(options);
    expectTypeOf<InferAppServices<typeof plugin>>().toEqualTypeOf<{ health: string }>();
    expectTypeOf<InferRequestServices<typeof plugin>>().toEqualTypeOf<{
      connection: () => unknown;
    }>();
    const app = Fastify();
    await app.register(plugin);
    app.addHook("onRequest", async (request) => {
      const services = request.getDecorator<InferRequestServices<typeof plugin>>("services");
      expect(services.connection()).toBe(opened);
      expect(services.connection()).toBe(opened);
    });
    app.get(
      "/",
      {
        schema: {
          querystring: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
      async () => "ok",
    );
    expect(opened).toBe(0);
    const invalid = await app.inject("/");
    expect(invalid.statusCode).toBe(400);
    expect([opened, closed]).toEqual([1, 1]);
    const valid = await app.inject("/?id=1");
    expect(valid.statusCode).toBe(200);
    expect([opened, closed]).toEqual([2, 2]);
    await app.close();
    expect(closed).toBe(2);
  });
});
