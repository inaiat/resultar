/* eslint-disable unicorn/no-await-expression-member, unicorn/no-null */
import { Hono, type Context, type Env } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask, type Result } from "resultar";
import { createModule, resource, service } from "resultar-di";
import { createHonoServices } from "../src/index.js";

function fixture() {
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
  return { events, services: createModule().singleton(Shared).scoped(Local) };
}

test("native routes infer variables and acquire only for matching middleware", async () => {
  const { services, events } = fixture();
  const di = createHonoServices(services);
  const app = new Hono()
    .get("/public", (c) => c.text("public"))
    .get("/private", di.middleware(["local"]), (c) => {
      expectTypeOf(c.var.services.local.id).toEqualTypeOf<number>();
      return c.json({ id: c.var.services.local.id });
    });
  expect(await (await app.request("/public")).text()).toBe("public");
  expect(await (await app.request("/missing")).text()).toBe("404 Not Found");
  expect(events).toEqual([]);
  const sharedRequest = new Request("http://localhost/private");
  const responses = await Promise.all([app.fetch(sharedRequest), app.fetch(sharedRequest)]);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(bodies[0]).not.toEqual(bodies[1]);
  expect(events).toEqual(["open root", "close child", "close child"]);
  const closing = di.close();
  expect(di.close()).toBe(closing);
  await closing;
  expect(events.at(-1)).toBe("close root");
  app.onError((error) => new Response(error.message, { status: 503 }));
  expect(await (await app.request("/private")).text()).toBe("Hono services are closed");
});

test("locals preserve native bindings, middleware variables and execution context", async () => {
  type Environment = { Bindings: { suffix: string }; Variables: { tenant: string } };
  const Tenant = ResultTask.service<string, "tenant">("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);
  const di = createHonoServices(createModule().scoped(Greeting));
  const app = new Hono<Environment>();
  app.use(async (c, next) => {
    c.set("tenant", "acme");
    await next();
  });
  app.get(
    "/",
    di.middleware(["greeting"], {
      locals: async (context: Context<Environment>) => ({ tenant: context.var.tenant }),
    }),
    (c) => {
      expectTypeOf(c.var.services.greeting).toEqualTypeOf<string>();
      c.executionCtx.waitUntil(Promise.resolve());
      return c.text(c.var.services.greeting + c.env.suffix);
    },
  );
  let waiting = 0;
  const response = await app.fetch(
    new Request("http://localhost/"),
    { suffix: "!" },
    {
      waitUntil: () => {
        waiting += 1;
      },
      passThroughOnException: () => {
        /* Native context capability. */
      },
      props: {},
    },
  );
  expect(await response.text()).toBe("acme!");
  expect(waiting).toBe(1);
  await di.close();
});

test("middleware preserves Hono RPC status and response inference", async () => {
  const di = createHonoServices(createModule().value("answer", 42));
  const app = new Hono().get("/answer", di.middleware(["answer"]), (c) => {
    if (c.req.query("missing") === "true") return c.json({ error: "missing" }, 404);
    return c.json({ answer: c.var.services.answer }, 200);
  });
  const client = hc<typeof app>("http://localhost", {
    fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
  });
  expectTypeOf<InferResponseType<typeof client.answer.$get, 200>>().toEqualTypeOf<{
    answer: number;
  }>();
  expectTypeOf<InferResponseType<typeof client.answer.$get, 404>>().toEqualTypeOf<{
    error: string;
  }>();
  expect(await (await client.answer.$get()).json()).toEqual({ answer: 42 });
  await di.close();
});

test("streams keep the middleware scope alive through consumption and cancellation", async () => {
  const { services, events } = fixture();
  const di = createHonoServices(services);
  let canceled = false;
  const app = new Hono().get(
    "/",
    di.middleware(["local"]),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  );
  const response = await app.request("/");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected response body");
  await reader.read();
  expect(events).toEqual(["open root"]);
  let closed = false;
  const closing = di.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await reader.cancel();
  await closing;
  expect(canceled).toBe(true);
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("abort and native error responses release the selected graph", async () => {
  const { services, events } = fixture();
  const di = createHonoServices(services);
  const app = new Hono();
  app.onError((error) => new Response(error.message, { status: 418 }));
  app.get("/error", di.middleware(["local"]), () => {
    throw new Error("handled");
  });
  app.get("/stream", di.middleware(["local"]), () => new Response(new ReadableStream()));
  expect(await (await app.request("/error")).text()).toBe("handled");
  expect(events).toEqual(["open root", "close child"]);
  const signal = new AbortController();
  const response = await app.request("/stream", { signal: signal.signal });
  signal.abort("disconnected");
  await di.close();
  await expect(response.text()).rejects.toBeDefined();
  expect(events).toEqual(["open root", "close child", "close child", "close root"]);
});

test("cleanup failures remain typed and repeated middleware is rejected", async () => {
  const Bad = resource("bad", {
    acquire: ResultTask.ok(42),
    release: () => ResultTask.err("cleanup" as const),
  });
  const di = createHonoServices(createModule().singleton(Bad));
  const app = new Hono().get("/", di.middleware(["bad"]), (c) => c.body(null, 204));
  await app.request("/");
  const closing = di.close();
  expectTypeOf(closing).toEqualTypeOf<Promise<Result<void, "cleanup">>>();
  expect((await closing).isErr()).toBe(true);
  const other = createHonoServices(createModule().value("answer", 42));
  const duplicate = new Hono();
  duplicate.onError((error) => new Response(error.message, { status: 500 }));
  duplicate.get("/", other.middleware(["answer"]), other.middleware(["answer"]), (c) =>
    c.text("unreachable"),
  );
  expect(await (await duplicate.request("/")).text()).toContain("Only one services middleware");
  await other.close();
});

test("outer middleware throwing after next() releases Tier 0 and Tier 2 scopes without hanging close()", async () => {
  // Tier 0 (pure singleton value)
  const tier0 = createHonoServices(createModule().value("answer", 42));
  const tier0App = new Hono();
  tier0App.onError((error) => new Response(`caught:${error.message}`, { status: 500 }));
  tier0App.use("*", async (_c, next) => {
    await next();
    throw new Error("outer-tier0");
  });
  tier0App.get("/", tier0.middleware(["answer"]), (c) => c.text(String(c.var.services.answer)));
  expect(await (await tier0App.request("/")).text()).toBe("caught:outer-tier0");
  expect((await tier0.close()).isOk()).toBe(true);

  // Tier 2 (scoped resource) with custom onError returning a response
  const { services, events } = fixture();
  const tier2 = createHonoServices(services);
  const tier2App = new Hono();
  tier2App.onError((error) => new Response(`caught:${error.message}`, { status: 500 }));
  tier2App.use("*", async (_c, next) => {
    await next();
    throw new Error("outer-tier2");
  });
  tier2App.get("/", tier2.middleware(["local"]), (c) => c.text(String(c.var.services.local.id)));
  expect(await (await tier2App.request("/")).text()).toBe("caught:outer-tier2");
  expect((await tier2.close()).isOk()).toBe(true);
  expect(events).toEqual(["open root", "close child", "close root"]);

  // Tier 2 when onError itself rethrows (never assigns c.res)
  const rethrowFixture = fixture();
  const rethrowDi = createHonoServices(rethrowFixture.services);
  const rethrowApp = new Hono();
  rethrowApp.onError((error) => {
    throw error;
  });
  rethrowApp.use("*", async (_c, next) => {
    await next();
    throw new Error("outer-rethrow");
  });
  rethrowApp.get("/", rethrowDi.middleware(["local"]), (c) =>
    c.text(String(c.var.services.local.id)),
  );
  await expect(rethrowApp.request("/")).rejects.toThrow("outer-rethrow");
  expect((await rethrowDi.close()).isOk()).toBe(true);
  expect(rethrowFixture.events).toEqual(["open root", "close child", "close root"]);
});

test("outer middleware replacing c.res releases Tier 0 and Tier 2 scopes while preserving streaming transforms", async () => {
  // Tier 0 replacement
  const tier0 = createHonoServices(createModule().value("answer", 42));
  const tier0App = new Hono();
  tier0App.use("*", async (c, next) => {
    await next();
    c.res = new Response("replaced-tier0");
  });
  tier0App.get("/", tier0.middleware(["answer"]), (c) => c.text(String(c.var.services.answer)));
  expect(await (await tier0App.request("/")).text()).toBe("replaced-tier0");
  expect((await tier0.close()).isOk()).toBe(true);

  // Tier 2 replacement (including clearing c.res = undefined first)
  const { services, events } = fixture();
  const tier2 = createHonoServices(services);
  const tier2App = new Hono();
  tier2App.use("/replace", async (c, next) => {
    await next();
    c.res = new Response("replaced-tier2");
  });
  tier2App.use("/reset", async (c, next) => {
    await next();
    c.res = undefined as unknown as Response;
    c.res = new Response("reset-tier2");
  });
  tier2App.get("/replace", tier2.middleware(["local"]), (c) =>
    c.text(String(c.var.services.local.id)),
  );
  tier2App.get("/reset", tier2.middleware(["local"]), (c) =>
    c.text(String(c.var.services.local.id)),
  );
  expect(await (await tier2App.request("/replace")).text()).toBe("replaced-tier2");
  expect(await (await tier2App.request("/reset")).text()).toBe("reset-tier2");
  expect((await tier2.close()).isOk()).toBe(true);
  expect(events).toEqual(["open root", "close child", "close child", "close root"]);

  // Preserving body (header mutation + wrapping same body + pipeThrough) still drains normally
  const streamFixture = fixture();
  const streamDi = createHonoServices(streamFixture.services);
  const streamApp = new Hono();
  streamApp.use("*", async (c, next) => {
    await next();
    c.header("x-outer", "1");
    c.res = new Response(c.res.body, c.res);
  });
  streamApp.get(
    "/stream",
    streamDi.middleware(["local"]),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
        }),
      ),
  );
  const response = await streamApp.request("/stream");
  expect(response.headers.get("x-outer")).toBe("1");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected response body");
  await reader.read();
  expect(streamFixture.events).toEqual(["open root"]);
  let closed = false;
  const closing = streamDi.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await reader.cancel();
  await closing;
  expect(streamFixture.events).toEqual(["open root", "close child", "close root"]);
});

test("different service owners cannot overwrite the same Hono variable", async () => {
  const first = createHonoServices(createModule().value("answer", 1));
  const second = createHonoServices(createModule().value("answer", 2));
  const app = new Hono();
  app.onError((error) => new Response(error.message, { status: 500 }));
  app.get("/", first.middleware(["answer"]), second.middleware(["answer"]), (c) =>
    c.text("unreachable"),
  );
  expect(await (await app.request("/")).text()).toContain("Only one services middleware");
  await first.close();
  await second.close();
});

test.each(["1", "0"] as const)(
  "Tier 0 and Tier 1 fast middleware maintain JIT=%s parity, abort checks, and close drain",
  async (jitMode) => {
    const previousJit = process.env.RESULTAR_JIT;
    process.env.RESULTAR_JIT = jitMode;
    try {
      const Tenant = ResultTask.service<string, "tenant">("tenant");
      let scopedCount = 0;
      let localsCalls = 0;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let poolReleased = 0;
      const Pool = resource("pool", {
        acquire: ResultTask.ok("pool"),
        release: () =>
          ResultTask.sync(() => {
            poolReleased += 1;
          }),
      });
      const services = createModule()
        .singleton(Pool)
        .value("prefix", "v5")
        .scoped("ctx", ["prefix"], ({ prefix }) => {
          scopedCount += 1;
          return `${prefix}:${scopedCount}`;
        })
        .scoped(service("greeting", { tenant: Tenant }, ({ tenant }) => `hi:${tenant}`));

      const di = createHonoServices(services);
      const app = new Hono<Env>();
      app.onError((error) => new Response(error.message, { status: 500 }));
      app.get("/pool", di.middleware(["pool"]), (c) => c.text(c.var.services.pool));
      app.get("/static", di.middleware(["prefix"]), async (c) => {
        started.resolve();
        await release.promise;
        return c.text(c.var.services.prefix);
      });
      app.get(
        "/dynamic",
        di.middleware(["ctx", "greeting"], {
          locals: (context: Context<Env>) => {
            localsCalls += 1;
            return { tenant: context.req.header("x-tenant") ?? "default" };
          },
        }),
        (c) => c.text(`${c.var.services.ctx}:${c.var.services.greeting}`),
      );

      // Acquire singleton resource on Tier 2 route first.
      expect(await (await app.request("/pool")).text()).toBe("pool");

      // Tier 1 with locals resolves cleanly and skips locals on pre-aborted requests.
      const firstDynamic = await app.request("/dynamic", { headers: { "x-tenant": "acme" } });
      expect(await firstDynamic.text()).toBe("v5:1:hi:acme");
      const secondDynamic = await app.request("/dynamic", { headers: { "x-tenant": "beta" } });
      expect(await secondDynamic.text()).toBe("v5:2:hi:beta");
      expect(localsCalls).toBe(2);

      const abortedController = new AbortController();
      abortedController.abort(new Error("client-gone"));
      const abortedRes = await app.request("/dynamic", { signal: abortedController.signal });
      expect(abortedRes.status).toBe(500);
      expect(localsCalls).toBe(2);

      // Concurrent close() waits for in-flight Tier 0 middleware before releasing singleton resources.
      const inFlight = app.request("/static");
      await started.promise;
      let closed = false;
      const closing = di.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(poolReleased).toBe(0);

      release.resolve();
      expect(await (await inFlight).text()).toBe("v5");
      await closing;
      expect(closed).toBe(true);
      expect(poolReleased).toBe(1);
    } finally {
      if (previousJit === undefined) delete process.env.RESULTAR_JIT;
      else process.env.RESULTAR_JIT = previousJit;
    }
  },
);

test.each(["static", "dynamic"] as const)(
  "Tier 0/1 %s middleware keeps scope open until stream consumption/abort and cancels producer on abort",
  async (mode) => {
    const Tenant = ResultTask.service<string, "tenant">("tenant");
    let poolReleased = 0;
    let sourceCanceled = 0;
    const cancelObserved = Promise.withResolvers<void>();
    const Pool = resource("pool", {
      acquire: ResultTask.ok("pool"),
      release: () =>
        ResultTask.sync(() => {
          poolReleased += 1;
        }),
    });
    const services = createModule()
      .singleton(Pool)
      .value("tag", "stream")
      .scoped(service("greeting", { tenant: Tenant }, ({ tenant }) => `hi:${tenant}`));

    const di = createHonoServices(services);
    const app = new Hono<Env>();
    app.get("/pool", di.middleware(["pool"]), (c) => c.text(c.var.services.pool));
    const createStreamResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
          },
          cancel() {
            sourceCanceled += 1;
            cancelObserved.resolve();
          },
        }),
      );
    if (mode === "static") {
      app.get("/stream", di.middleware(["tag"]), createStreamResponse);
    } else {
      app.get(
        "/stream",
        di.middleware(["greeting"], {
          locals: (context: Context<Env>) => ({ tenant: context.req.header("x-tenant") ?? "acme" }),
        }),
        createStreamResponse,
      );
    }

    // Acquire singleton resource first so we can observe premature close().
    expect(await (await app.request("/pool")).text()).toBe("pool");

    const abortController = new AbortController();
    const response = await app.request("/stream", { signal: abortController.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected response body");
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);

    // di.close() must wait while the streaming response is still open.
    let closed = false;
    const closing = di.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    expect(closed).toBe(false);
    expect(poolReleased).toBe(0);

    // Aborting the request must reject the pending read, cancel the source stream, and allow close() to finish.
    const pendingRead = reader.read();
    abortController.abort(new Error("client-disconnected"));
    await cancelObserved.promise;
    await expect(pendingRead).rejects.toThrow("Request scope failed");
    await closing;
    expect(sourceCanceled).toBe(1);
    expect(closed).toBe(true);
    expect(poolReleased).toBe(1);
  },
);

const checkTypes = () => {
  const External = ResultTask.service<string, "external">("external");
  const Dependent = service("dependent", { external: External }, ({ external }) => external);
  const di = createHonoServices(createModule().scoped(Dependent).value("answer", 42));
  // @ts-expect-error Unknown selected service.
  di.middleware(["missing"]);
  // @ts-expect-error Selected graph has a missing requirement.
  di.middleware(["dependent"]);
  di.middleware(["answer"]);
  di.middleware(["dependent"], { locals: () => ({ external: "ok" }) });
  // @ts-expect-error Incompatible request local.
  di.middleware(["dependent"], { locals: () => ({ external: 42 }) });
  // @ts-expect-error Request locals cannot override registrations.
  di.middleware(["answer"], { locals: () => ({ answer: 42 }) });
};
expectTypeOf(checkTypes).toBeFunction();
