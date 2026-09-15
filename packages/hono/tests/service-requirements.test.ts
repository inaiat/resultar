import { Hono, type Context } from "hono";
import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { Service, createModule, createHonoServices } from "../src/index.js";

test("explicit and inline dependencies preserve Hono request isolation and cleanup", async () => {
  let opened = 0;
  let closed = 0;
  const Tenant = Service.require<string>()("tenant");
  class Session extends Service("session", {
    requires: { owner: Tenant },
    make: ({ owner }) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          opened += 1;
          return { owner, id: opened };
        }),
        release: () =>
          ResultTask.sync(() => {
            closed += 1;
          }),
      }),
  }) {}
  class Greeting extends Service("greeting", {
    make: ResultTask.gen(function* createGreeting() {
      const session = yield* Service.require<{ owner: string; id: number }>()("session");
      return `${session.owner}:${session.id}`;
    }),
  }) {}
  const di = createHonoServices(createModule().scoped(Session).scoped(Greeting));
  type Environment = { Variables: { tenant: string } };
  const router = new Hono<Environment>();
  router.use(async (context, next) => {
    context.set("tenant", context.req.header("x-tenant") ?? "unknown");
    await next();
  });
  const app = router.get(
    "/",
    di.middleware(["session", "greeting"], {
      locals: (context: Context<Environment>) => ({ tenant: context.var.tenant }),
    }),
    (context) => {
      const services = context.var.services;
      expectTypeOf(services.greeting).toEqualTypeOf<string>();
      expect(services.greeting).toBe(`${services.session.owner}:${services.session.id}`);
      return context.json(services.session);
    },
  );
  expect(opened).toBe(0);
  const responses = await Promise.all(
    ["alpha", "beta"].map((tenant) =>
      Promise.resolve(app.request("/", { headers: { "x-tenant": tenant } })),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const bodies = await Promise.all(
    responses.map((response) => response.json() as Promise<{ owner: string; id: number }>),
  );
  expect(bodies.map((body) => body.owner)).toEqual(["alpha", "beta"]);
  expect(new Set(bodies.map((body) => body.id)).size).toBe(2);
  await di.close();
  expect([opened, closed]).toEqual([2, 2]);
});
