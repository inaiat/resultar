/* eslint-disable unicorn/no-await-expression-member, unicorn/no-null */
import { Hono, type Context } from "hono";
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
  const responses = await Promise.all([app.request("/private"), app.request("/private")]);
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
    acquire: ResultTask.succeed(42),
    release: () => ResultTask.fail("cleanup" as const),
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
