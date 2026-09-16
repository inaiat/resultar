/* eslint-disable unicorn/no-await-expression-member, unicorn/no-null */
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask, unit, type Result } from "resultar";
import { createModule, resource, Service, service } from "resultar-di";
import type { Hono } from "hono";
import { createHonoApp, type HonoApplication, type InferRequestServices } from "../src/index.js";

test("infers selected readonly services from applications and factories for separate routes", async () => {
  const services = createModule().value("answer", 42).value("hidden", "internal");
  const createApplication = (module = services) =>
    createHonoApp({ services: module, bindings: ["answer"] }, (router) => {
      routes(router);
    });
  type Bindings = InferRequestServices<typeof createApplication>;
  const routes = (router: Hono<{ Bindings: Bindings }>) => {
    router.get("/", (c) => c.json({ answer: c.env.answer }));
  };
  const app = createApplication();
  expectTypeOf<Bindings>().toEqualTypeOf<{ readonly answer: number }>();
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<Bindings>();
  expectTypeOf<
    InferRequestServices<ReturnType<typeof createApplication>>
  >().toEqualTypeOf<Bindings>();
  expectTypeOf(app).toExtend<HonoApplication>();
  expectTypeOf<ReturnType<typeof app.close>>().toEqualTypeOf<Promise<Result<void, never>>>();
  expect(app).not.toHaveProperty("serviceTypes");
  expect(await (await app.request("/")).json()).toEqual({ answer: 42 });
  await app.close();
});

test("runs an optional startup task once before requests and shares concurrent readiness", async () => {
  let runs = 0;
  const Config = Service.require<{ readonly environment: string }>()("config");
  const startup = ResultTask.gen(function* initialize() {
    const config = yield* Config;
    runs += 1;
    expect(config.environment).toBe("test");
  });
  const app = createHonoApp(
    { services: createModule().value("config", { environment: "test" }), startup, bindings: [] },
    (router) => router.get("/", (context) => context.text("ready")),
  );
  expect(runs).toBe(0);
  const readiness = await Promise.all([app.ready(), app.ready()]);
  expect(readiness.every((result) => result.isOk())).toBe(true);
  expect(runs).toBe(1);
  expect(await (await app.request("/")).text()).toBe("ready");
  expect(runs).toBe(1);
  await app.close();
});

test("rolls back application resources when optional startup fails", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => "connected"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createHonoApp(
    {
      services: createModule().singleton(Connection),
      startup: ResultTask.gen(function* failStartup() {
        yield* Connection;
        return yield* ResultTask.fail("offline" as const);
      }),
      bindings: [],
    },
    (router) => router.get("/", (context) => context.text("unreachable")),
  );
  const failure = await app.ready();
  expect(failure.isErr()).toBe(true);
  expect(released).toBe(1);
  await expect(app.request("/")).rejects.toThrow();
  await app.close();
});

const checkInferredTypes = () => {
  const legacy: HonoApplication = {
    fetch: async () => new Response(),
    request: async () => new Response(),
    close: async () => unit(),
  };
  expectTypeOf(legacy).toExtend<HonoApplication>();
  const createApplication = (answer: number) =>
    createHonoApp(
      { services: createModule().value("answer", answer), bindings: ["answer"] },
      () => {
        /* Type-only configuration. */
      },
    );
  type Bindings = InferRequestServices<typeof createApplication>;
  expectTypeOf<Bindings>().toEqualTypeOf<{ readonly answer: number }>();
  const bindings: Bindings = { answer: 42 };
  expectTypeOf(bindings).toEqualTypeOf<Bindings>();
  // @ts-expect-error Bindings preserve the readonly injected service view.
  bindings.answer = 0;
  // @ts-expect-error Only selected services are exposed.
  expectTypeOf(bindings.hidden).toBeUnknown();
  const empty = createHonoApp(
    { services: createModule().value("answer", 42), bindings: [] },
    () => {
      /* Type-only configuration. */
    },
  );
  expectTypeOf<keyof InferRequestServices<typeof empty>>().toEqualTypeOf<never>();
  expectTypeOf<InferRequestServices<number>>().toEqualTypeOf<never>();
};
expectTypeOf(checkInferredTypes).toBeFunction();

const build = () => {
  const events: string[] = [];
  let next = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      events.push("open root");
      return {};
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("close root");
      }),
  });
  const Local = resource("local", {
    acquire: ResultTask.gen(function* acquireLocal() {
      const shared = yield* Shared;
      next += 1;
      return { shared, id: next };
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("close child");
      }),
  });
  const services = createModule().singleton(Shared).scoped(Local);
  return { events, services };
};

const startupTypeChecks = () => {
  const Config = Service.require<string>()("config");
  const Greeting = service("greeting", { config: Config }, ({ config }) => config);
  const startup = ResultTask.gen(function* useGreeting() {
    yield* Greeting;
  });
  createHonoApp(
    { services: createModule().value("config", "test").singleton(Greeting), startup, bindings: [] },
    () => {
      /* Transitive startup requirements are supplied by the module. */
    },
  );
  // @ts-expect-error A startup task's transitive requirements must be registered.
  createHonoApp({ services: createModule().scoped(Greeting), startup, bindings: [] }, () => {
    /* No routes are needed for this check. */
  });
};
expectTypeOf(startupTypeChecks).toBeFunction();

test("infers bindings, shares a root and isolates concurrent requests", async () => {
  const { events, services } = build();
  let configured = 0;
  const instances: object[] = [];
  const app = createHonoApp({ services, bindings: ["local"] }, (router) => {
    configured += 1;
    router.get("/", (c) => {
      instances.push(c.env.local.shared);
      return c.json({ id: c.env.local.id });
    });
  });
  expect(events).toEqual([]);
  const responses = await Promise.all([
    app.request("/"),
    app.fetch(new Request("http://localhost/")),
  ]);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(bodies[0]).not.toEqual(bodies[1]);
  expect(instances[0]).toBe(instances[1]);
  expect(configured).toBe(1);
  expect(events).toEqual(["open root", "close child", "close child"]);
  const firstClose = app.close();
  expect(app.close()).toBe(firstClose);
  expect((await firstClose).isOk()).toBe(true);
  expect(events.at(-1)).toBe("close root");
  await expect(app.request("/")).rejects.toThrow("closed");
});

test("close waits for response consumption and streaming cancellation releases resources", async () => {
  const { events, services } = build();
  let canceled = false;
  const app = createHonoApp({ services, bindings: ["local"] }, (router) => {
    router.get(
      "/",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("chunk"));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    );
  });
  const response = await app.request("/");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected a response body");
  await reader.read();
  expect(events).toEqual(["open root"]);
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await reader.cancel();
  await closing;
  expect(canceled).toBe(true);
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("request abort closes its child and aborts the source stream", async () => {
  const { events, services } = build();
  const app = createHonoApp({ services, bindings: ["local"] }, (router) =>
    router.get("/", () => new Response(new ReadableStream())),
  );
  const controller = new AbortController();
  const response = await app.request("/", { signal: controller.signal });
  controller.abort("disconnect");
  await app.close();
  await expect(response.text()).rejects.toBeDefined();
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("handles empty responses, 404, Hono errors and overrides", async () => {
  const Value = service("value", {}, () => "live");
  const services = createModule().scoped(Value).override("value", "fake");
  const app = createHonoApp({ services, bindings: ["value"] }, (router) => {
    router.onError(() => new Response("handled", { status: 500 }));
    router.get("/value", (c) => c.text(c.env.value));
    router.delete("/value", (c) => c.body(null, 204));
    router.get("/error", () => {
      throw new Error("handler failed");
    });
  });
  expect(await (await app.request("/value")).text()).toBe("fake");
  expect((await app.request("/value", { method: "DELETE" })).status).toBe(204);
  const missing = await app.request("/missing");
  expect(missing.status).toBe(404);
  await missing.text();
  expect(await (await app.request("/error")).text()).toBe("handled");
  await app.close();
});

test("provider errors reject fetch and cleanup errors remain typed at close", async () => {
  const Failing = service("failing", ResultTask.fail("offline" as const));
  const broken = createHonoApp(
    { services: createModule().scoped(Failing), bindings: ["failing"] },
    (app) => app.get("/", (c) => c.text("unreachable")),
  );
  await expect(broken.request("/")).rejects.toThrow("Request scope failed");
  await broken.close();
  const Shared = resource("shared", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("cleanup" as const),
  });
  const app = createHonoApp(
    { services: createModule().singleton(Shared), bindings: ["shared"] },
    (r) => r.get("/", (c) => c.body(null, 204)),
  );
  await app.request("/");
  expectTypeOf(app.close()).toEqualTypeOf<Promise<Result<void, "cleanup">>>();
  const closed = await app.close();
  expect(closed.isErr()).toBe(true);
  if (closed.isErr()) expect(closed.error).toBe("cleanup");
});

test("stream errors and child cleanup failures surface to the body consumer", async () => {
  const { services, events } = build();
  const app = createHonoApp({ services, bindings: ["local"] }, (r) =>
    r.get(
      "/",
      () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new Error("stream failed");
            },
          }),
        ),
    ),
  );
  const response = await app.request("/");
  await expect(response.text()).rejects.toThrow("stream failed");
  await app.close();
  expect(events).toEqual(["open root", "close child", "close root"]);
  const Local = resource("local", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("cleanup"),
  });
  const other = createHonoApp(
    { services: createModule().scoped(Local), bindings: ["local"] },
    (r) => r.get("/", (c) => c.text("ok")),
  );
  await expect((await other.request("/")).text()).rejects.toThrow("Request scope failed");
  await other.close();
});

test("configuration runs before any provider can be acquired", () => {
  const { services, events } = build();
  expect(() =>
    createHonoApp({ services, bindings: ["local"] }, () => {
      throw new Error("configuration");
    }),
  ).toThrow("configuration");
  expect(events).toEqual([]);
});

// Compile-only negative cases must remain rejected by the public API.
const checkTypes = () => {
  const services = createModule().value("answer", 42);
  // @ts-expect-error Unknown binding name.
  createHonoApp({ services, bindings: ["missing"] }, () => {
    /* Type-only configuration. */
  });
  createHonoApp({ services, bindings: ["answer"] }, (app) => {
    app.get("/", (c) => {
      expectTypeOf(c.env.answer).toEqualTypeOf<number>();
      // @ts-expect-error Unselected services are not exposed.
      expect(c.env.missing).toBeUndefined();
      return c.text("ok");
    });
  });
  const External = ResultTask.service<string, "external">("external");
  const Dependent = service("dependent", { external: External }, ({ external }) => external);
  // @ts-expect-error The HTTP application cannot run with a missing dependency.
  createHonoApp({ services: createModule().scoped(Dependent), bindings: ["dependent"] }, () => {
    /* Type-only configuration. */
  });
  // Unselected dependencies do not prevent creating a healthy endpoint.
  createHonoApp(
    { services: createModule().scoped(Dependent).merge(services), bindings: ["answer"] },
    () => {
      /* Type-only configuration. */
    },
  );
};
expectTypeOf(checkTypes).toBeFunction();
