/* eslint-disable unicorn/no-null, unicorn/no-await-expression-member */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Readable, PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask } from "resultar";
import { createModule, service, resource } from "resultar-di";
import {
  createFastifyPlugin,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

function fixture() {
  const events: string[] = [];
  let next = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      events.push("open root");
      return { closed: false };
    }),
    release: (value) =>
      ResultTask.sync(() => {
        value.closed = true;
        events.push("close root");
      }),
  });
  const Local = resource("local", {
    acquire: ResultTask.gen(function* acquireLocal() {
      const shared = yield* Shared;
      next += 1;
      return { shared, id: next, closed: false };
    }),
    release: (value) =>
      ResultTask.sync(() => {
        value.closed = true;
        events.push("close child");
      }),
  });
  const services = createModule().singleton(Shared).scoped(Local);
  const plugin = createFastifyPlugin({ services, appBindings: ["shared"], bindings: ["local"] });
  return { events, services, plugin };
}

test("native registration initializes app singletons and isolates concurrent request services", async () => {
  const { events, plugin } = fixture();
  const app = Fastify();
  type App = InferAppServices<typeof plugin>;
  type Request = InferRequestServices<typeof plugin>;
  expectTypeOf<App>().toEqualTypeOf<Readonly<{ shared: { closed: boolean } }>>();
  const instances: Request["local"][] = [];
  app.register(plugin);
  app.register(async (child) => {
    expect(child.getDecorator<App>("services").shared.closed).toBe(false);
    child.get("/", (request) => {
      const { local } = request.getDecorator<Request>("services");
      instances.push(local);
      expect(local.shared).toBe(child.getDecorator<App>("services").shared);
      return { id: local.id };
    });
  });
  expect(events).toEqual([]);
  await app.ready();
  expect(events).toEqual(["open root"]);
  const [first, second] = await Promise.all([app.inject("/"), app.inject("/")]);
  expect(first.statusCode).toBe(200);
  expect(first.json()).not.toEqual(second.json());
  expect(instances.every((instance) => instance.closed)).toBe(true);
  expect(events).toEqual(["open root", "close child", "close child"]);
  await app.close();
  await app.close();
  expect(events.at(-1)).toBe("close root");
  expect(instances[0]?.shared.closed).toBe(true);
});

test("plain factories stay uninitialized until selected and explicit overrides are shared", async () => {
  let calls = 0;
  const Value = service("value", {}, () => {
    calls += 1;
    return 1;
  });
  const app = Fastify();
  const plugin = createFastifyPlugin({
    services: createModule().singleton(Value),
    bindings: ["value"],
  });
  await app.register(plugin);
  expect(calls).toBe(0);
  app.get("/", (request) => request.getDecorator<InferRequestServices<typeof plugin>>("services"));
  await app.inject("/");
  await app.inject("/");
  expect(calls).toBe(1);
  await app.close();
  const other = Fastify();
  await other.register(
    createFastifyPlugin({
      services: createModule().singleton(Value).override("value", 42),
      bindings: ["value"],
    }),
  );
  other.get("/", (request) => request.getDecorator("services"));
  expect((await other.inject("/")).json()).toEqual({ value: 42 });
  expect(calls).toBe(1);
  await other.close();
});

test("module factories see prior plugins and locals see authentication before preHandler", async () => {
  const Tenant = ResultTask.service<string, "tenant">("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);
  const app = Fastify();
  app.decorate("settings", { suffix: "!" });
  app.decorateRequest("tenant");
  app.addHook("onRequest", async (request) => {
    request.setDecorator("tenant", "acme");
  });
  const plugin = createFastifyPlugin({
    services: async (instance: FastifyInstance) =>
      createModule()
        .scoped(Greeting)
        .value("suffix", instance.getDecorator<{ suffix: string }>("settings").suffix),
    bindings: ["greeting", "suffix"],
    locals: async (request: FastifyRequest) => ({ tenant: request.getDecorator<string>("tenant") }),
  });
  await app.register(plugin);
  app.get("/", (request) => {
    const services = request.getDecorator<InferRequestServices<typeof plugin>>("services");
    expectTypeOf(services.greeting).toEqualTypeOf<string>();
    return services.greeting + services.suffix;
  });
  expect((await app.inject("/")).body).toBe("acme!");
  await app.close();
});

test("early responses skip acquisition and error handlers retain live request resources", async () => {
  const { services, events } = fixture();
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/early") await reply.code(401).send("auth");
  });
  const plugin = createFastifyPlugin({ services, bindings: ["local"] });
  await app.register(plugin);
  app.setErrorHandler((error, request, reply) => {
    const { local } = request.getDecorator<InferRequestServices<typeof plugin>>("services");
    expect(local.closed).toBe(false);
    return reply.code(418).send({ handled: true });
  });
  app.get("/error", () => {
    throw new Error("route failed");
  });
  app.get("/early", () => "unreachable");
  app.delete("/", (_request, reply) => reply.code(204).send());
  expect((await app.inject("/early")).statusCode).toBe(401);
  expect(events).toEqual([]);
  expect((await app.inject("/error")).statusCode).toBe(418);
  expect(events).toEqual(["open root", "close child"]);
  expect((await app.inject({ method: "DELETE", url: "/" })).statusCode).toBe(204);
  await app.close();
  expect(events).toEqual(["open root", "close child", "close child", "close root"]);
});

test("rolls back partial startup and rejects scoped application bindings", async () => {
  const { services, events } = fixture();
  const Failing = service("failing", ResultTask.fail("offline"));
  const app = Fastify();
  app.register(
    createFastifyPlugin({
      services: services.singleton(Failing),
      appBindings: ["shared", "failing"],
      bindings: [],
    }),
  );
  await expect(app.ready()).rejects.toThrow();
  expect(events).toEqual(["open root", "close root"]);
  await app.close();
  const other = Fastify();
  other.register(createFastifyPlugin({ services, appBindings: ["local"], bindings: [] }));
  await expect(other.ready()).rejects.toThrow();
  await other.close();
});

test("request acquisition failures use the native error handler and preserve the cause", async () => {
  const Failing = service("failing", ResultTask.fail("offline"));
  const app = Fastify();
  await app.register(
    createFastifyPlugin({ services: createModule().scoped(Failing), bindings: ["failing"] }),
  );
  app.setErrorHandler((error, _request, reply) => {
    expect(error).toHaveProperty("cause");
    return reply.code(503).send({ unavailable: true });
  });
  app.get("/", () => "unreachable");
  expect((await app.inject("/")).statusCode).toBe(503);
  await app.close();
});

test("encapsulated sibling registrations use independent roots and duplicates fail", async () => {
  const app = Fastify();
  for (const name of ["a", "b"]) {
    app.register(async (child) => {
      await child.register(
        createFastifyPlugin({ services: createModule().value("name", name), bindings: ["name"] }),
      );
      child.get(`/${name}`, (request) => request.getDecorator("services"));
    });
  }
  expect((await app.inject("/a")).json()).toEqual({ name: "a" });
  expect((await app.inject("/b")).json()).toEqual({ name: "b" });
  expect(app.hasDecorator("services")).toBe(false);
  await app.close();
  const duplicate = Fastify();
  duplicate.decorate("services", {});
  duplicate.register(createFastifyPlugin({ services: createModule(), bindings: [] }));
  await expect(duplicate.ready()).rejects.toThrow("already registered");
  await duplicate.close();
});

test("streamed replies keep resources alive until consumption finishes", async () => {
  const { plugin, events } = fixture();
  const app = Fastify();
  await app.register(plugin);
  const release = Promise.withResolvers<void>();
  app.get("/", (request, reply) => {
    const { local } = request.getDecorator<InferRequestServices<typeof plugin>>("services");
    return reply.send(
      Readable.from(
        (async function* body() {
          yield "first";
          await release.promise;
          expect(local.closed).toBe(false);
          yield "last";
        })(),
      ),
    );
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const response = await fetch(url, { headers: { connection: "close" } });
  expect(events).toEqual(["open root"]);
  const closing = app.close();
  release.resolve();
  expect(await response.text()).toBe("firstlast");
  await closing;
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("client disconnect releases its request scope exactly once", async () => {
  const { plugin, events } = fixture();
  const app = Fastify();
  await app.register(plugin);
  const stream = new PassThrough();
  app.get("/", (_request, reply) => {
    stream.write("chunk");
    return reply.send(stream);
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    const client = httpRequest(url, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    client.once("error", reject);
    client.end();
  });
  await expect.poll(() => events.filter((event) => event === "close child").length).toBe(1);
  stream.destroy();
  await app.close();
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("native handler timeout aborts request work and releases scoped resources", async () => {
  const { plugin, events } = fixture();
  const app = Fastify({ handlerTimeout: 40 });
  await app.register(plugin);
  app.get("/", async (request) => {
    const result = await ResultTask.runResult(
      ResultTask.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        catch: (error) => error,
      }),
      { signal: request.signal },
    ).catch(() => {
      /* The native timeout response owns interruption. */
    });
    return result ?? "interrupted";
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const response = await fetch(url, { headers: { connection: "close" } });
  expect(response.status).toBe(503);
  await response.text();
  await app.close();
  expect(events).toEqual(["open root", "close child", "close root"]);
});

const typeChecks = () => {
  const services = createModule().value("answer", 42);
  // @ts-expect-error Unknown selected service.
  createFastifyPlugin({ services, bindings: ["missing"] });
  const External = ResultTask.service<string, "external">("external");
  const Dependent = service("dependent", { external: External }, ({ external }) => external);
  const module = createModule().scoped(Dependent).merge(services);
  // @ts-expect-error A selected graph must have all external requirements supplied.
  createFastifyPlugin({ services: module, bindings: ["dependent"] });
  createFastifyPlugin({ services: module, bindings: ["answer"] });
  createFastifyPlugin({
    services: module,
    bindings: ["dependent"],
    locals: () => ({ external: "ok" }),
  });
  createFastifyPlugin({
    services: module,
    // @ts-expect-error Incompatible local service contract.
    bindings: ["dependent"],
    locals: () => ({ external: 42 }),
  });
  // @ts-expect-error Locals cannot replace registrations.
  createFastifyPlugin({ services, bindings: ["answer"], locals: () => ({ answer: 2 }) });
  createFastifyPlugin({
    services: module,
    bindings: [],
    // @ts-expect-error Application bindings cannot capture request locals.
    appBindings: ["dependent"],
    locals: () => ({ external: "ok" }),
  });
};
expectTypeOf(typeChecks).toBeFunction();
