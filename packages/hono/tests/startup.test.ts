/* eslint-disable unicorn/no-await-expression-member */
import { ResultTask, ResultTaskCauseError } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createHonoApp,
  createModule,
  resource,
  service,
  Service,
  type ServiceModule,
} from "../src/index.js";

const noRoutes = () => {
  /* Only application lifecycle is exercised. */
};

test("startup keeps direct resources until close and shares the singleton with requests", async () => {
  const events: string[] = [];
  const connection = {};
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => {
      events.push("connection");
      return connection;
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("release connection");
      }),
  });
  const app = createHonoApp(
    {
      services: createModule().singleton(Connection),
      startup: ResultTask.gen(function* initialize() {
        expect(yield* Connection).toBe(connection);
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            events.push("consumer");
            return {};
          }),
          release: () =>
            ResultTask.sync(() => {
              events.push("release consumer");
            }),
        });
      }),
    },
    (router) =>
      router.get("/", (context) => {
        expect(context.env.connection).toBe(connection);
        expect(events).toEqual(["connection", "consumer"]);
        return context.text("ready");
      }),
  );
  expect(events).toEqual([]);
  const responses = await Promise.all([app.request("/"), app.request("/")]);
  await Promise.all(responses.map((response) => response.text()));
  await app.close();
  await app.close();
  expect(events).toEqual(["connection", "consumer", "release consumer", "release connection"]);
});

test("close cancels pending startup, releases resources, and never dispatches a waiting request", async () => {
  const entered = Promise.withResolvers<void>();
  let released = 0;
  let dispatched = false;
  let aborted = false;
  const app = createHonoApp(
    {
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
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
              entered.resolve();
            }),
          catch: (error) => error,
        });
      }),
    },
    (router) =>
      router.get("/", (context) => {
        dispatched = true;
        return context.text("unexpected");
      }),
  );
  const request = expect(app.request("/")).rejects.toBeInstanceOf(ResultTaskCauseError);
  await entered.promise;
  const closing = app.close();
  expect(app.close()).toBe(closing);
  expect((await closing).isOk()).toBe(true);
  await request;
  expect([aborted, dispatched, released]).toEqual([true, false, 1]);
});

test("closing an unused app never starts initialization", async () => {
  let runs = 0;
  const app = createHonoApp(
    {
      services: createModule(),
      startup: ResultTask.sync(() => {
        runs += 1;
      }),
    },
    noRoutes,
  );
  await app.close();
  expect((await app.ready()).isErr()).toBe(true);
  await expect(app.request("/")).rejects.toThrow("closed");
  expect(runs).toBe(0);
});

test.each(["scoped", "transient"] as const)(
  "startup cannot capture %s services",
  async (lifetime) => {
    let acquired = false;
    const Local = service("local", {}, () => {
      acquired = true;
      return {};
    });
    const app = createHonoApp(
      {
        services: createModule()[lifetime](Local),
        bindings: [],
        startup: ResultTask.gen(function* initialize() {
          yield* Local;
        }),
      },
      noRoutes,
    );
    expect((await app.ready()).isErr()).toBe(true);
    expect(acquired).toBe(false);
    await app.close();
  },
);

test("startup failure retains direct and singleton rollback failures", async () => {
  const Connection = resource("connection", {
    acquire: ResultTask.succeed({}),
    release: () => ResultTask.fail("root cleanup"),
  });
  const app = createHonoApp(
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
  const result = await app.ready();
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error.cause).toEqual({
      _tag: "Sequential",
      left: {
        _tag: "Sequential",
        left: { _tag: "Fail", error: "startup failed" },
        right: { _tag: "Fail", error: "task cleanup" },
      },
      right: { _tag: "Fail", error: "root cleanup" },
    });
  expect(await app.ready()).toBe(result);
  expect((await app.close()).isErr()).toBe(true);
});

test("startup finalizer failure rejects close while root cleanup still runs", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed({}),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createHonoApp(
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
  expect((await app.ready()).isOk()).toBe(true);
  await expect(app.close()).rejects.toMatchObject({ cause: { _tag: "Fail", error: "cleanup" } });
  expect(released).toBe(1);
});

const startupTypes = () => {
  const Config = Service.require<string>()("config");
  const startup = ResultTask.gen(function* initialize() {
    yield* Config;
  });
  const missing = { services: createModule(), bindings: [] as const, startup };
  // @ts-expect-error Startup requires a registered config even with no bindings.
  createHonoApp(missing, noRoutes);
  const optional: {
    services: ReturnType<typeof createModule>;
    bindings: readonly [];
    startup?: typeof startup;
  } = missing;
  // @ts-expect-error An optional startup must still be satisfiable.
  createHonoApp(optional, noRoutes);
  const incompatible = {
    services: createModule().value("config", 42),
    bindings: [] as const,
    startup,
  };
  // @ts-expect-error Dependency contracts must match.
  createHonoApp(incompatible, noRoutes);
  const Greeting = service("greeting", { config: Config }, ({ config }) => config);
  const erased: ServiceModule<{ readonly greeting: string }, never, typeof Config> =
    createModule().singleton(Greeting);
  const transitive = {
    services: erased,
    bindings: [] as const,
    startup: ResultTask.gen(function* initialize() {
      yield* Greeting;
    }),
  };
  // @ts-expect-error Widening graph metadata must not hide transitive requirements.
  createHonoApp(transitive, noRoutes);
  createHonoApp({ services: createModule(), startup: undefined }, noRoutes);
};
expectTypeOf(startupTypes).toBeFunction();
