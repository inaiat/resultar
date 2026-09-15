import type { FastifyInstance } from "fastify";
import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createFastifyApp,
  createFastifyPlugin,
  createModule,
  resource,
  Service,
  service,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

test("configures a native application synchronously and preserves lazy scoped resources", async () => {
  let opened = 0;
  let released = 0;
  let configured = 0;
  const Session = resource("session", {
    acquire: ResultTask.sync(() => {
      opened += 1;
      return { id: opened };
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createFastifyApp(
    { services: createModule().scoped(Session), bindings: ["session"] },
    (router) => {
      configured += 1;
      expectTypeOf(router).toEqualTypeOf<FastifyInstance>();
      router.register(async (child) => {
        expect(child.hasRequestDecorator("services")).toBe(true);
        child.get("/", (request) => request.getDecorator("services"));
      });
    },
  );
  expectTypeOf(app).toExtend<FastifyInstance>();
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<
    Readonly<{ session: { id: number } }>
  >();
  expect(app).not.toHaveProperty("serviceTypes");
  expect(configured).toBe(1);
  expect(opened).toBe(0);
  expect(app.server.listening).toBe(false);
  try {
    const responses = await Promise.all([app.inject("/"), app.inject("/")]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) => response.json<{ session: { id: number } }>())).toEqual([
      { session: { id: 1 } },
      { session: { id: 2 } },
    ]);
  } finally {
    await app.close();
  }
  expect([configured, opened, released]).toEqual([1, 2, 2]);
});

test("keeps separate application roots and releases their singletons on close", async () => {
  let opened = 0;
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => {
      opened += 1;
      return opened;
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const options = {
    services: createModule().singleton(Connection),
    bindings: ["connection"],
    appBindings: ["connection"],
  } as const;
  const first = createFastifyApp(options, (app) => {
    app.get("/", (request) => request.getDecorator("services"));
  });
  const second = createFastifyApp(options, (app) => {
    app.get("/", (request) => request.getDecorator("services"));
  });
  expect(opened).toBe(0);
  try {
    const firstResponse = await first.inject("/");
    const secondResponse = await second.inject("/");
    expect(firstResponse.json()).toEqual({ connection: 1 });
    expect(secondResponse.json()).toEqual({ connection: 2 });
  } finally {
    await first.close();
    await second.close();
  }
  expect(released).toBe(2);
});

test("retains native startup failure and rollback", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed("connected"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const Failing = service("failing", ResultTask.fail("offline"));
  const app = createFastifyApp(
    {
      services: createModule().singleton(Connection).singleton(Failing),
      bindings: [],
      appBindings: ["connection", "failing"],
    },
    () => {
      /* No routes are needed for this check. */
    },
  );
  try {
    await expect(app.ready()).rejects.toThrow();
    expect(released).toBe(1);
  } finally {
    await app.close();
  }
});

const typeChecks = () => {
  const module = createModule().value("answer", 42);
  // @ts-expect-error Unknown binding.
  createFastifyApp({ services: module, bindings: ["missing"] }, () => {
    /* No routes are needed for this check. */
  });
  const Tenant = Service.require<string>()("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);
  const services = createModule().scoped(Greeting);
  // @ts-expect-error Required dependency was not supplied.
  createFastifyApp({ services, bindings: ["greeting"] }, () => {
    /* No routes are needed for this check. */
  });
  createFastifyApp({ services, bindings: ["greeting"], locals: () => ({ tenant: "ok" }) }, () => {
    /* No routes are needed for this check. */
  });
  // @ts-expect-error Incompatible local dependency.
  createFastifyApp({ services, bindings: ["greeting"], locals: () => ({ tenant: 42 }) }, () => {
    /* No routes are needed for this check. */
  });
};
expectTypeOf(typeChecks).toBeFunction();

test("infers selected services from the application factory without exposing internal providers", async () => {
  const module = createModule().value("answer", 42).value("internal", "hidden");
  const createApplication = (services = module) =>
    createFastifyApp({ services, bindings: ["answer"], appBindings: ["internal"] }, (app) => {
      app.get("/", (request) => request.getDecorator("services"));
    });
  type Application = ReturnType<typeof createApplication>;
  type RequestServices = InferRequestServices<typeof createApplication>;
  expectTypeOf<RequestServices>().toEqualTypeOf<InferRequestServices<Application>>();
  expectTypeOf<RequestServices>().toEqualTypeOf<Readonly<{ answer: number }>>();
  expectTypeOf<keyof RequestServices>().toEqualTypeOf<"answer">();
  expectTypeOf<InferAppServices<Application>>().toEqualTypeOf<Readonly<{ internal: string }>>();
  expectTypeOf<InferAppServices<typeof createApplication>>().toEqualTypeOf<
    InferAppServices<Application>
  >();
  const app = createApplication();
  try {
    const response = await app.inject("/");
    expect(response.json()).toEqual({ answer: 42 });
    expect(app.getDecorator("services")).toEqual({ internal: "hidden" });
  } finally {
    await app.close();
  }
});

const inferenceChecks = () => {
  const options = {
    services: createModule().value("answer", 42),
    bindings: ["answer"],
    exposeRequest: () => ({ visible: "request" }),
    exposeApplication: () => ({ visible: "app" }),
  } as const;
  const plugin = createFastifyPlugin(options);
  const createPlugin = (answer: number) =>
    createFastifyPlugin({ services: createModule().value("answer", answer), bindings: ["answer"] });
  expectTypeOf<InferRequestServices<typeof createPlugin>>().toEqualTypeOf<
    Readonly<{ answer: number }>
  >();
  expectTypeOf<keyof InferAppServices<typeof createPlugin>>().toEqualTypeOf<never>();
  expectTypeOf<InferRequestServices<() => number>>().toEqualTypeOf<never>();
  expectTypeOf<InferAppServices<() => number>>().toEqualTypeOf<never>();
  const app = createFastifyApp(options, () => {
    /* Only declaration inference is checked here. */
  });
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<
    InferRequestServices<typeof plugin>
  >();
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<{ visible: string }>();
  expectTypeOf<InferAppServices<typeof app>>().toEqualTypeOf<InferAppServices<typeof plugin>>();
  expectTypeOf<InferAppServices<typeof app>>().toEqualTypeOf<{ visible: string }>();
  const empty = createFastifyApp({ services: options.services, bindings: [] }, () => {
    /* Empty selections must not expose registered providers. */
  });
  expectTypeOf<keyof InferRequestServices<typeof empty>>().toEqualTypeOf<never>();
  expectTypeOf<keyof InferAppServices<typeof empty>>().toEqualTypeOf<never>();
};
expectTypeOf(inferenceChecks).toBeFunction();
