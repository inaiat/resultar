/* eslint-disable unicorn/no-await-expression-member */
import { ResultTask, type Result } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createHonoApp,
  createHonoServices,
  createModule,
  resource,
  service,
  Service,
  type InferRequestServices,
} from "../src/index.js";

test("omitted bindings infer all services and preserve singleton, scoped and transient lifetimes", async () => {
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
  const app = createHonoApp({ services }, (router) => {
    router.get("/", (c) => {
      views.push(c.env);
      expect(Object.isFrozen(c.env)).toBe(true);
      expect(c.env.transient).toBe(c.env.transient);
      return c.json({ id: c.env.local });
    });
  });
  expectTypeOf<keyof InferRequestServices<typeof app>>().toEqualTypeOf<
    "shared" | "local" | "transient"
  >();
  expect(events).toEqual([]);
  expect(await (await app.request("/")).json()).toEqual({ id: 1 });
  expect(events).toEqual(["shared", "local", "transient", "release local"]);
  expect(await (await app.request("/")).json()).toEqual({ id: 2 });
  expect(views[0]?.shared).toBe(views[1]?.shared);
  expect(views[0]?.transient).not.toBe(views[1]?.transient);
  await app.close();
  expect(events.at(-1)).toBe("release shared");
});

test("default selection propagates acquisition failure and rolls back request resources", async () => {
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
  const app = createHonoApp({ services: createModule().scoped(Lease).scoped(Broken) }, (router) => {
    router.get("/health", (c) => {
      handled += 1;
      return c.text("ok");
    });
  });
  await expect(app.request("/health")).rejects.toThrow("Request scope failed");
  expect([handled, released]).toEqual([0, 1]);
  await app.close();
});

test("default bindings keep streaming resources until cancellation", async () => {
  let released = 0;
  const Lease = resource("lease", {
    acquire: ResultTask.succeed("open"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createHonoApp({ services: createModule().scoped(Lease) }, (router) => {
    router.get("/", () => new Response(new ReadableStream()));
  });
  const response = await app.request("/");
  expect(released).toBe(0);
  const closing = app.close();
  await response.body?.cancel();
  await closing;
  expect(released).toBe(1);
});

test("explicit and empty selections do not initialize unrelated services; empty modules work", async () => {
  let created = 0;
  const Hidden = service("hidden", {}, () => {
    created += 1;
    return "hidden";
  });
  const services = createModule().value("answer", 42).scoped(Hidden);
  const selected = createHonoApp({ services, bindings: ["answer"] }, (router) => {
    router.get("/", (c) => c.json(c.env));
  });
  const empty = createHonoApp({ services, bindings: [] }, (router) => {
    router.get("/", (c) => c.json(c.env));
  });
  const none = createHonoApp({ services: createModule() }, (router) => {
    router.get("/", (c) => c.json(c.env));
  });
  expect(await (await selected.request("/")).json()).toEqual({ answer: 42 });
  expect(await (await empty.request("/")).json()).toEqual({});
  expect(await (await none.request("/")).json()).toEqual({});
  expect(created).toBe(0);
  await selected.close();
  await empty.close();
  await none.close();
});

const checkTypes = () => {
  const services = createModule().value("answer", 42).value("hidden", "private");
  const factory = () =>
    createHonoApp({ services }, () => {
      /* Types only. */
    });
  type All = InferRequestServices<typeof factory>;
  expectTypeOf<keyof All>().toEqualTypeOf<"answer" | "hidden">();
  expectTypeOf<All["answer"]>().toEqualTypeOf<number>();
  const view: All = { answer: 42, hidden: "private" };
  expectTypeOf(view.hidden).toEqualTypeOf<string>();
  // @ts-expect-error Default bindings are readonly.
  view.answer = 1;
  const optional: { services: typeof services; bindings?: readonly ["answer"] } = { services };
  const uncertain = createHonoApp(optional, () => {
    /* Types only. */
  });
  expectTypeOf<keyof InferRequestServices<typeof uncertain>>().toEqualTypeOf<"answer">();
  const explicitUndefined = createHonoApp({ services, bindings: undefined }, () => {
    /* Types only. */
  });
  expectTypeOf<keyof InferRequestServices<typeof explicitUndefined>>().toEqualTypeOf<keyof All>();
  const dynamicBindings = Math.random() > 0.5 ? (["answer"] as const) : (["hidden"] as const);
  // @ts-expect-error Explicit selections must remain one literal tuple.
  createHonoApp({ services, bindings: dynamicBindings }, () => {
    /* Types only. */
  });
  // @ts-expect-error Middleware cannot promise both properties when only one tuple is selected.
  createHonoServices(services).middleware(dynamicBindings);
  const widenedBindings: ("answer" | "hidden")[] = ["answer"];
  // @ts-expect-error A widened array cannot guarantee that every named binding is present.
  createHonoApp({ services, bindings: widenedBindings }, () => {
    /* Types only. */
  });
  const Missing = service(
    "dependent",
    { external: Service.require<string>()("external") },
    ({ external }) => external,
  );
  const incomplete = createModule().scoped(Missing);
  // @ts-expect-error Default bindings require every registered service's dependencies.
  createHonoApp({ services: incomplete }, () => {
    /* Types only. */
  });
  // @ts-expect-error Incompatible dependency contracts cannot be satisfied by name alone.
  createHonoApp({ services: incomplete.value("external", 42) }, () => {
    /* Types only. */
  });
  createHonoApp({ services: incomplete, bindings: [] }, () => {
    /* Types only. */
  });
  const cleanup = resource("cleanup", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("cleanup" as const),
  });
  const app = createHonoApp({ services: createModule().singleton(cleanup) }, () => {
    /* Types only. */
  });
  expectTypeOf<ReturnType<typeof app.close>>().toEqualTypeOf<Promise<Result<void, "cleanup">>>();
};
expectTypeOf(checkTypes).toBeFunction();
