import fp from "fastify-plugin";
import Fastify, { type FastifyInstance } from "fastify";
import { ResultTask, ResultTaskCauseError } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createFastifyApp,
  createFastifyPlugin,
  createModule,
  resource,
  Service,
  service,
  type InferRequestServices,
} from "../src/index.js";

const noRoutes = () => {
  /* Only application lifecycle is exercised. */
};

const startupFactory =
  <E, R>(task: ResultTask<void, E, R>) =>
  (_app: FastifyInstance): ResultTask<void, E, R> =>
    task;

test("infers bindings with a generated startup factory", async () => {
  const Config = Service.require<string>()("config");
  const startup = startupFactory(
    ResultTask.gen(function* initialize() {
      expect(yield* Config).toBe("test");
    }),
  );
  const plugin = createFastifyPlugin({
    services: createModule().value("config", "test"),
    startup,
    bindings: ["config"],
  });
  expectTypeOf<InferRequestServices<typeof plugin>>().toEqualTypeOf<Readonly<{ config: string }>>();
  const app = Fastify();
  app.register(plugin);
  await app.ready();
  await app.close();
});

test("startup factory sees later plugins and retains direct resources before singleton cleanup", async () => {
  const events: string[] = [];
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => {
      events.push("connection");
      return {};
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("release connection");
      }),
  });
  const app = createFastifyApp(
    {
      services: createModule().singleton(Connection),
      bindings: ["connection"],
      startup: (fastify: FastifyInstance) =>
        ResultTask.gen(function* initialize() {
          expect(fastify.getDecorator("loaded")).toBe(true);
          const connection = yield* Connection;
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              events.push("consumer");
              return connection;
            }),
            release: () =>
              ResultTask.sync(() => {
                events.push("release consumer");
              }),
          });
        }),
    },
    (router) => {
      router.register(
        fp(async (child) => {
          child.decorate("loaded", true);
        }),
      );
      router.get("/", () => {
        expect(events).toEqual(["connection", "consumer"]);
        return "ok";
      });
    },
  );
  expect(events).toEqual([]);
  await app.ready();
  expect(events).toEqual(["connection", "consumer"]);
  const response = await app.inject("/");
  expect(response.statusCode).toBe(200);
  await app.close();
  await app.close();
  expect(events).toEqual(["connection", "consumer", "release consumer", "release connection"]);
});

test.each(["scoped", "transient"] as const)(
  "startup rejects %s dependencies at runtime",
  async (lifetime) => {
    let acquired = false;
    const Local = service("local", {}, () => {
      acquired = true;
      return {};
    });
    const app = createFastifyApp(
      {
        services: createModule()[lifetime](Local),
        bindings: [],
        startup: ResultTask.gen(function* initialize() {
          yield* Local;
        }),
      },
      noRoutes,
    );
    await expect(app.ready()).rejects.toBeInstanceOf(ResultTaskCauseError);
    expect(acquired).toBe(false);
    await app.close();
  },
);

test("startup and both resource cleanup failures remain observable", async () => {
  const Connection = resource("connection", {
    acquire: ResultTask.succeed({}),
    release: () => ResultTask.fail("root cleanup"),
  });
  const app = createFastifyApp(
    {
      services: createModule().singleton(Connection),
      bindings: [],
      startup: ResultTask.gen(function* initialize() {
        yield* Connection;
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed({}),
          release: () => ResultTask.fail("task cleanup"),
        });
        yield* ResultTask.fail("startup failed");
      }),
    },
    noRoutes,
  );
  await expect(app.ready()).rejects.toMatchObject({
    errors: [
      {
        cause: {
          _tag: "Sequential",
          left: { _tag: "Fail", error: "startup failed" },
          right: { _tag: "Fail", error: "task cleanup" },
        },
      },
      { errors: [{ cause: { _tag: "Fail", error: "root cleanup" } }] },
    ],
  });
  await expect(app.close()).rejects.toBeInstanceOf(AggregateError);
});

test("closing releases startup resources even when their finalizer fails", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed({}),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createFastifyApp(
    {
      services: createModule().singleton(Connection),
      bindings: [],
      startup: ResultTask.gen(function* initialize() {
        yield* Connection;
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed({}),
          release: () => ResultTask.fail("cleanup"),
        });
      }),
    },
    noRoutes,
  );
  await app.ready();
  expect(released).toBe(0);
  await expect(app.close()).rejects.toMatchObject({
    errors: [{ cause: { _tag: "Fail", error: "cleanup" } }],
  });
  expect(released).toBe(1);
});

const types = () => {
  const Config = Service.require<string>()("config");
  const startup = ResultTask.gen(function* initialize() {
    yield* Config;
  });
  const options: {
    services: ReturnType<typeof createModule>;
    bindings: readonly [];
    startup?: typeof startup;
  } = { services: createModule(), bindings: [], startup };
  // @ts-expect-error Optional startup still requires config.
  createFastifyApp(options, noRoutes);
  // @ts-expect-error Factory requirements must be provided, too.
  createFastifyApp({ services: createModule(), bindings: [], startup: () => startup }, noRoutes);
  createFastifyApp(
    // @ts-expect-error An incompatible registered dependency is rejected.
    { services: createModule().value("config", 42), bindings: [], startup },
    noRoutes,
  );
  // @ts-expect-error Startup must return void, not discard a business value.
  createFastifyApp({ services: createModule(), startup: ResultTask.succeed(42) }, noRoutes);
  createFastifyApp(
    {
      services: createModule(),
      // @ts-expect-error Startup factories cannot return raw promises.
      startup: async () => {
        /* Invalid native promise factory. */
      },
    },
    noRoutes,
  );
  createFastifyApp({ services: createModule(), startup: undefined }, noRoutes);
};
expectTypeOf(types).toBeFunction();

test("native readiness timeout can close and cancel a pending startup", async () => {
  const entered = Promise.withResolvers<void>();
  let released = 0;
  const app = Fastify({ pluginTimeout: 50 });
  app.register(
    createFastifyPlugin({
      services: createModule(),
      startup: ResultTask.gen(function* initialize() {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed({}),
          release: () =>
            ResultTask.sync(() => {
              released += 1;
            }),
        });
        yield* ResultTask.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              entered.resolve();
            }),
          catch: (error) => error,
        });
      }),
    }),
  );
  const readiness = expect(app.ready()).rejects.toThrow();
  await entered.promise;
  await readiness;
  await app.close();
  expect(released).toBe(1);
});
