/* eslint-disable unicorn/no-await-expression-member */
import { Hono, type Context } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask } from "resultar";
import { runTaskJson } from "../src/index.js";

const User = z.object({ id: z.string() });
const Missing = z.object({ error: z.literal("missing") });
const route = createRoute({
  method: "get",
  path: "/users/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "User", content: { "application/json": { schema: User } } },
    404: { description: "Missing", content: { "application/json": { schema: Missing } } },
  },
});

test("JSON task responses preserve OpenAPI and RPC status/payload contracts", async () => {
  const app = new OpenAPIHono().openapi(route, (c) =>
    runTaskJson(
      c,
      c.req.valid("param").id === "1"
        ? ResultTask.ok({ id: "1" })
        : ResultTask.err("missing" as const),
      {
        ok: (user) => c.json(user, 200),
        error: (error) => {
          expectTypeOf(error).toEqualTypeOf<"missing">();
          return c.json({ error }, 404);
        },
      },
    ),
  );
  const client = hc<typeof app>("http://localhost", {
    fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
  });
  const get = client.users[":id"].$get;
  expectTypeOf<InferResponseType<typeof get, 200>>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<InferResponseType<typeof get, 404>>().toEqualTypeOf<{ error: "missing" }>();
  const found = await get({ param: { id: "1" } });
  expect(found.status).toBe(200);
  expect(User.parse(await found.json())).toEqual({ id: "1" });
  const missing = await get({ param: { id: "2" } });
  expect(missing.status).toBe(404);
  expect(Missing.parse(await missing.json())).toEqual({ error: "missing" });
});

test("request cancellation reaches subscription and cleanup before Hono onError", async () => {
  const controller = new AbortController();
  let cleaned = false;
  const signals: AbortSignal[] = [];
  const app = new Hono();
  app.onError(() => {
    expect(cleaned).toBe(true);
    return new Response("aborted", { status: 499 });
  });
  app.get("/", (c) =>
    runTaskJson(
      c,
      ResultTask.fromCallback<number>({
        subscribe: (context) => {
          signals.push(context.signal);
          queueMicrotask(() => controller.abort("disconnect"));
          return () => {
            cleaned = true;
          };
        },
      }),
      { ok: (value) => c.json({ value }), error: () => c.json({ error: "unexpected" }, 500) },
    ),
  );
  const response = await app.request("/", { signal: controller.signal });
  expect(response.status).toBe(499);
  expect(signals[0]?.aborted).toBe(true);
});

test("defects bypass typed mapping and task resources close before JSON mapping", async () => {
  const events: string[] = [];
  const app = new Hono();
  app.onError((error) => new Response(error.message, { status: 500 }));
  app.get("/", (c) =>
    runTaskJson(
      c,
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(42),
        release: () =>
          ResultTask.sync(() => {
            events.push("released");
          }),
      }),
      {
        ok: (value) => {
          expect(events).toEqual(["released"]);
          return c.json({ value });
        },
        error: () => c.json({ error: "unexpected" }, 400),
      },
    ),
  );
  app.get("/defect", (c) =>
    runTaskJson(
      c,
      ResultTask.sync(() => {
        throw new Error("defect");
      }),
      {
        ok: () => c.json({ ok: true }),
        error: () => {
          throw new Error("typed mapper must not run");
        },
      },
    ),
  );
  expect(await (await app.request("/")).json()).toEqual({ value: 42 });
  expect(await (await app.request("/defect")).text()).toBe("defect");
});

test("release errors join the typed response mapping", async () => {
  const app = new Hono().get("/", (c) =>
    runTaskJson(
      c,
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(42),
        release: () => ResultTask.err("release" as const),
      }),
      {
        ok: (value) => c.json({ value }),
        error: (error) => {
          expectTypeOf(error).toEqualTypeOf<"release">();
          return c.json({ error }, 503);
        },
      },
    ),
  );
  expect((await app.request("/")).status).toBe(503);
});

const checkTypes = async (c: Context) => {
  const Service = ResultTask.service<number, "number">("number");
  const task = ResultTask.gen(function* task() {
    return yield* Service;
  });
  const handlers = {
    ok: (value: number) => c.json({ value }),
    error: () => c.json({ error: "failed" }, 500),
  };
  // @ts-expect-error Required services must be provided before running.
  await runTaskJson(c, task, handlers);
  await runTaskJson(c, task.provideService(Service, 42), handlers);
  // @ts-expect-error Only typed JSON responses are accepted, not streams or untyped Response.
  await runTaskJson(c, ResultTask.ok(1), { ok: () => new Response(), error: () => new Response() });
};
expectTypeOf(checkTypes).toBeFunction();
