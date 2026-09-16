import Fastify, { type FastifyRequest } from "fastify";
import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  Service,
  createModule,
  createFastifyPlugin,
  type InferRequestServices,
} from "../src/index.js";

test("sync, task and inline dependencies preserve Fastify request isolation and cleanup", async () => {
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
  class View extends Service("view", {
    requires: { session: Session, greeting: Greeting },
    make: ({ session, greeting }) => ({ session, greeting }),
  }) {}
  const plugin = createFastifyPlugin({
    services: createModule().scoped(Session).scoped(Greeting).scoped(View),
    bindings: ["session", "greeting", "view"],
    locals: (request: FastifyRequest) => ({ tenant: String(request.headers["x-tenant"]) }),
  });
  const app = Fastify();
  await app.register(plugin);
  app.get("/", (request) => {
    const services = request.getDecorator<InferRequestServices<typeof plugin>>("services");
    expect(services.view.session).toBe(services.session);
    expect(services.view.greeting).toBe(services.greeting);
    expectTypeOf(services.greeting).toEqualTypeOf<string>();
    expect(services.greeting).toBe(`${services.session.owner}:${services.session.id}`);
    return services.session;
  });
  expect(opened).toBe(0);
  const responses = await Promise.all(
    ["alpha", "beta"].map((tenant) => app.inject({ url: "/", headers: { "x-tenant": tenant } })),
  );
  expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
  const bodies = responses.map((response) => response.json<{ owner: string; id: number }>());
  expect(bodies.map((body) => body.owner)).toEqual(["alpha", "beta"]);
  expect(new Set(bodies.map((body) => body.id)).size).toBe(2);
  await app.close();
  expect([opened, closed]).toEqual([2, 2]);
});
