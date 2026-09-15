/* eslint-disable unicorn/no-await-expression-member */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createFastifyApp,
  createFastifyPlugin,
  createModule,
  resource,
  service,
  Service,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

test("omitted bindings resolve all registrations in order, with request lifetimes and no startup acquisition", async () => {
  const events: string[] = [];
  let next = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      events.push("shared");
      return {};
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("release shared");
      }),
  });
  const Local = resource("local", {
    acquire: ResultTask.sync(() => {
      events.push("local");
      next += 1;
      return next;
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("release local");
      }),
  });
  const services = createModule()
    .singleton(Shared)
    .scoped(Local)
    .transient(
      service("transient", {}, () => {
        events.push("transient");
        return {};
      }),
    );
  const views: InferRequestServices<typeof app>[] = [];
  const app = createFastifyApp({ services }, (router) => {
    router.get("/", (request) => {
      const view = request.getDecorator<InferRequestServices<typeof app>>("services");
      views.push(view);
      expect(Object.isFrozen(view)).toBe(true);
      expect(view.transient).toBe(view.transient);
      return { id: view.local };
    });
  });
  expectTypeOf<keyof InferRequestServices<typeof app>>().toEqualTypeOf<
    "shared" | "local" | "transient"
  >();
  expectTypeOf<keyof InferAppServices<typeof app>>().toEqualTypeOf<never>();
  expect(events).toEqual([]);
  await app.ready();
  expect(events).toEqual([]);
  expect(app.getDecorator("services")).toEqual({});
  expect((await app.inject("/")).json()).toEqual({ id: 1 });
  expect(events).toEqual(["shared", "local", "transient", "release local"]);
  expect((await app.inject("/")).json()).toEqual({ id: 2 });
  expect(views[0]?.shared).toBe(views[1]?.shared);
  expect(views[0]?.transient).not.toBe(views[1]?.transient);
  await app.close();
  expect(events.at(-1)).toBe("release shared");
});

test("defaults follow a module factory and use locals without exposing them", async () => {
  const Tenant = Service.require<string>()("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);
  let factories = 0;
  const app = createFastifyApp(
    {
      services: async (_app: FastifyInstance) => {
        factories += 1;
        return createModule().scoped(Greeting);
      },
      locals: (request: FastifyRequest) => ({ tenant: request.id }),
    },
    (router) => {
      router.get("/", (request) => request.getDecorator("services"));
    },
  );
  expectTypeOf<keyof InferRequestServices<typeof app>>().toEqualTypeOf<"greeting">();
  expect(factories).toBe(0);
  const first = (await app.inject("/")).json<{ greeting: string }>();
  const second = (await app.inject("/")).json<{ greeting: string }>();
  expect(Object.keys(first)).toEqual(["greeting"]);
  expect(first).not.toEqual(second);
  expect(factories).toBe(1);
  await app.close();
});

test("default selection propagates acquisition failure and releases acquired request resources", async () => {
  let released = 0;
  let handled = 0;
  const Lease = resource("lease", {
    acquire: ResultTask.succeed("open"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const Broken = service("broken", ResultTask.fail(new Error("offline")));
  const app = createFastifyApp(
    { services: createModule().scoped(Lease).scoped(Broken) },
    (router) => {
      router.get("/health", () => {
        handled += 1;
        return "ok";
      });
    },
  );
  expect((await app.inject("/health")).statusCode).toBe(500);
  expect([handled, released]).toEqual([0, 1]);
  await app.close();
});

test("empty and explicit selections leave unrelated services uninitialized; empty modules work", async () => {
  let created = 0;
  const Hidden = service("hidden", {}, () => {
    created += 1;
    return "hidden";
  });
  const services = createModule().value("answer", 42).scoped(Hidden);
  const selected = createFastifyApp({ services, bindings: ["answer"] }, (app) => {
    app.get("/", (request) => request.getDecorator("services"));
  });
  const empty = createFastifyApp({ services, bindings: [] }, (app) => {
    app.get("/", (request) => request.getDecorator("services"));
  });
  const none = createFastifyApp({ services: createModule() }, (app) => {
    app.get("/", (request) => request.getDecorator("services"));
  });
  expect((await selected.inject("/")).json()).toEqual({ answer: 42 });
  expect((await empty.inject("/")).json()).toEqual({});
  expect((await none.inject("/")).json()).toEqual({});
  expect(created).toBe(0);
  await selected.close();
  await empty.close();
  await none.close();
});

const checkTypes = () => {
  const services = createModule().value("answer", 42).value("hidden", "private");
  const factory = () => createFastifyPlugin({ services });
  type All = InferRequestServices<typeof factory>;
  expectTypeOf<keyof All>().toEqualTypeOf<"answer" | "hidden">();
  expectTypeOf<All["answer"]>().toEqualTypeOf<number>();
  const view: All = { answer: 42, hidden: "private" };
  expectTypeOf(view.hidden).toEqualTypeOf<string>();
  // @ts-expect-error Default bindings are readonly.
  view.answer = 1;
  const optional: { services: typeof services; bindings?: readonly ["answer"] } = { services };
  const uncertain = createFastifyPlugin(optional);
  // An optional selection must not promise access to an unselected service.
  expectTypeOf<keyof InferRequestServices<typeof uncertain>>().toEqualTypeOf<"answer">();
  const explicitUndefined = createFastifyPlugin({ services, bindings: undefined });
  expectTypeOf<keyof InferRequestServices<typeof explicitUndefined>>().toEqualTypeOf<keyof All>();
  const dynamicBindings = Math.random() > 0.5 ? (["answer"] as const) : (["hidden"] as const);
  // @ts-expect-error Explicit selections must remain one literal tuple.
  createFastifyPlugin({ services, bindings: dynamicBindings });
  const widenedBindings: ("answer" | "hidden")[] = ["answer"];
  // @ts-expect-error A widened array cannot guarantee that every named binding is present.
  createFastifyPlugin({ services, bindings: widenedBindings });
  const Missing = service(
    "dependent",
    { external: Service.require<string>()("external") },
    ({ external }) => external,
  );
  const incomplete = createModule().scoped(Missing);
  // @ts-expect-error Omitting bindings requires the entire graph to be satisfied.
  createFastifyPlugin({ services: incomplete });
  // @ts-expect-error Incompatible locals cannot satisfy the graph.
  createFastifyPlugin({ services: incomplete, locals: () => ({ external: 42 }) });
  // @ts-expect-error Locals cannot overwrite registered services.
  createFastifyPlugin({ services, locals: () => ({ answer: 1 }) });
  // @ts-expect-error A lookalike scope is not a typed service module.
  createFastifyPlugin({ services: { scope: () => ({}) } });
  createFastifyPlugin({ services: incomplete, bindings: [] });
  const custom = createFastifyPlugin({ services, exposeRequest: () => ({ custom: true }) });
  expectTypeOf<InferRequestServices<typeof custom>>().toEqualTypeOf<{ custom: boolean }>();
};
expectTypeOf(checkTypes).toBeFunction();
