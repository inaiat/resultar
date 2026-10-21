import { Controller, Get, type INestApplicationContext } from "@nestjs/common";
import { ResultTask, ResultTaskCauseError } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createNestApp,
  createNestModule,
  createModule,
  resource,
  Service,
  service,
  type InferRequestServices,
} from "../src/index.js";

const startupFactory =
  <E, R>(task: ResultTask<void, E, R>) =>
  (_app: INestApplicationContext): ResultTask<void, E, R> =>
    task;

test("infers bindings with a generated startup factory", async () => {
  const Config = Service.require<string>()("config");
  const startup = startupFactory(
    ResultTask.gen(function* initialize() {
      expect(yield* Config).toBe("test");
    }),
  );
  const nestModule = createNestModule({
    services: createModule().value("config", "test"),
    startup,
    bindings: ["config"],
  });
  expectTypeOf<InferRequestServices<typeof nestModule>>().toEqualTypeOf<
    Readonly<{ config: string }>
  >();
  const app = createNestApp({
    services: createModule().value("config", "test"),
    startup,
    bindings: ["config"],
  });
  await app.ready();
  await app.close();
});

test("startup factory sees app decorators and retains direct resources before singleton cleanup", async () => {
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

  @Controller()
  class OkController {
    @Get()
    get() {
      expect(events).toEqual(["connection", "consumer"]);
      return "ok";
    }
  }

  const app = createNestApp(
    {
      services: createModule().singleton(Connection),
      bindings: ["connection"],
      controllers: [OkController],
      startup: (instance: INestApplicationContext) =>
        ResultTask.gen(function* initialize() {
          const decorated = instance as INestApplicationContext & {
            getDecorator: (name: PropertyKey) => unknown;
          };
          expect(decorated.getDecorator("loaded")).toBe(true);
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
    (instance) => {
      instance.decorate("loaded", true);
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
    const app = createNestApp({
      services: createModule()[lifetime](Local),
      bindings: [],
      startup: ResultTask.gen(function* initialize() {
        yield* Local;
      }),
    });
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
  const app = createNestApp({
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
  });
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
  const app = createNestApp({
    services: createModule().singleton(Connection),
    bindings: [],
    startup: ResultTask.gen(function* initialize() {
      yield* Connection;
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed({}),
        release: () => ResultTask.fail("cleanup"),
      });
    }),
  });
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
  createNestApp(options);
  // @ts-expect-error Factory requirements must be provided, too.
  createNestApp({ services: createModule(), bindings: [], startup: () => startup });
  createNestApp(
    // @ts-expect-error An incompatible registered dependency is rejected.
    { services: createModule().value("config", 42), bindings: [], startup },
  );
  // @ts-expect-error Startup must return void, not discard a business value.
  createNestApp({ services: createModule(), startup: ResultTask.succeed(42) });
  createNestApp({
    services: createModule(),
    // @ts-expect-error Startup factories cannot return raw promises.
    startup: async () => {
      /* Invalid native promise factory. */
    },
  });
  createNestApp({ services: createModule(), startup: undefined });
};
expectTypeOf(types).toBeFunction();

test("initTimeout can close and cancel a pending startup", async () => {
  const entered = Promise.withResolvers<void>();
  let released = 0;
  const app = createNestApp({
    services: createModule(),
    initTimeout: 50,
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
  });
  const readiness = expect(app.ready()).rejects.toThrow();
  await entered.promise;
  await readiness;
  await app.close();
  expect(released).toBe(1);
});
