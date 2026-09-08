import { ResultTask, type ServiceTag } from "resultar";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { createModule, Service } from "../src/advanced.js";

class Cache extends Service<{ read: () => string }>()("cache", {
  make: ResultTask.succeed({ read: () => "ok" }),
}) {}
class Users extends Service<{ read: () => string }>()("users", {
  make: ResultTask.gen(function* createUsers() {
    const cache = yield* Cache;
    return { read: () => cache.read() };
  }),
}) {}

describe("DI guarantees", () => {
  test("root close waits for active children before disposing singleton resources", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let released = false;
    const root = createModule()
      .resource("db", [], {
        lifetime: "singleton",
        acquire: () => ResultTask.succeed(1),
        release: () =>
          ResultTask.sync(() => {
            released = true;
          }),
      })
      .scope();
    const request = ResultTask.runPromise(
      root.use(["db"], () =>
        ResultTask.tryPromise({
          try: async () => {
            started.resolve();
            await finish.promise;
            expect(released).toBe(false);
          },
          catch: (error) => error,
        }),
      ),
    );
    await started.promise;
    const closing = ResultTask.runPromise(root.close());
    await Promise.resolve();
    expect(released).toBe(false);
    finish.resolve();
    await Promise.all([request, closing]);
    expect(released).toBe(true);
  });

  test("rolls back partial singleton acquisition before retry", async () => {
    let attempts = 0;
    let releases = 0;
    class Connection extends Service<number>()("connection", {
      make: ResultTask.gen(function* connect() {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed(1),
          release: () =>
            ResultTask.sync(() => {
              releases += 1;
            }),
        });
        attempts += 1;
        if (attempts === 1) return yield* ResultTask.fail("retry");
        return attempts;
      }),
    }) {}
    const root = createModule().singleton(Connection).scope();
    const read = root.use(["connection"], ({ connection }) => ResultTask.succeed(connection));
    await ResultTask.runExit(read);
    expect(releases).toBe(1);
    expect(await ResultTask.runPromise(read)).toBe(2);
    expect(releases).toBe(1);
    await ResultTask.runPromise(root.close());
    expect(releases).toBe(2);
  });

  test("rejects incompatible contracts before and after a dependent registration", () => {
    // eslint-disable-next-line no-constant-condition
    if (false) {
      // @ts-expect-error A matching name cannot satisfy an incompatible service contract.
      createModule().value("cache", 123).scoped(Users);
      const forward = createModule().scoped(Users).value("cache", 123);
      // @ts-expect-error A later registration is checked at the use boundary.
      forward.use(["users"], ({ users }) => ResultTask.succeed(users));
      createModule()
        .value("cache", 123)
        // @ts-expect-error Callback requirements must match registered contracts too.
        .use([], () =>
          ResultTask.gen(function* needCache() {
            return yield* Cache;
          }),
        );
    }
    expect(Cache.identifier).toBe("cache");
  });

  test("provides registered tokens to callbacks, task providers, and resource finalizers", async () => {
    const seen: string[] = [];
    const module = createModule()
      .singleton(Cache)
      .task("task", [], () =>
        ResultTask.gen(function* buildTask() {
          return (yield* Cache).read();
        }),
      )
      .resource("resource", ["task"], {
        acquire: () =>
          ResultTask.gen(function* acquire() {
            return (yield* Cache).read();
          }),
        release: () =>
          ResultTask.gen(function* release() {
            seen.push((yield* Cache).read());
          }),
      });
    const program = module.use(["resource"], () =>
      ResultTask.gen(function* callback() {
        return (yield* Cache).read();
      }),
    );
    expect(await ResultTask.runPromise(program)).toBe("ok");
    expect(seen).toEqual(["ok"]);
  });

  test("retains external requirements and accepts forward class dependencies", async () => {
    const External = ResultTask.service<string, "external">("external");
    const module = createModule().scoped(Users).singleton(Cache);
    const program = module.use(["users"], ({ users }) =>
      ResultTask.gen(function* callback() {
        return users.read() + (yield* External);
      }),
    );
    expectTypeOf(program).toEqualTypeOf<
      ResultTask<string, never, ServiceTag<"external", string>>
    >();
    expect(await ResultTask.runPromise(program, { services: { external: "!" } })).toBe("ok!");
  });

  test("keeps singleton acquireRelease resources alive until root close", async () => {
    let releases = 0;
    class Database extends Service<{ open: boolean }>()("database", {
      make: ResultTask.acquireRelease({
        acquire: ResultTask.sync((): { open: boolean } => ({ open: true })),
        release: (db) =>
          ResultTask.sync(() => {
            db.open = false;
            releases += 1;
          }),
      }),
    }) {}
    const root = createModule().singleton(Database).scope();
    const close = root.close();
    const read = root.use(["database"], ({ database }) => ResultTask.succeed(database.open));
    expect(await ResultTask.runPromise(read)).toBe(true);
    expect(releases).toBe(0);
    expect(await ResultTask.runPromise(read)).toBe(true);
    await ResultTask.runPromise(close);
    await ResultTask.runPromise(root.close());
    expect(releases).toBe(1);
  });

  test("shares pending singleton initialization and retries a failed attempt", async () => {
    let attempts = 0;
    class Database extends Service<{ id: number }>()("database", {
      make: ResultTask.tryPromise({
        try: async () => {
          attempts += 1;
          await Promise.resolve();
          if (attempts === 1) throw new Error("offline");
          return { id: attempts };
        },
        catch: () => "offline" as const,
      }),
    }) {}
    const root = createModule().singleton(Database).scope();
    const read = root.use(["database"], ({ database }) => ResultTask.succeed(database));
    const failed = await Promise.all([ResultTask.runExit(read), ResultTask.runExit(read)]);
    expect(failed).toEqual([
      { _tag: "Failure", cause: { _tag: "Fail", error: "offline" } },
      { _tag: "Failure", cause: { _tag: "Fail", error: "offline" } },
    ]);
    expect(attempts).toBe(1);
    const [first, second] = await Promise.all([
      ResultTask.runPromise(read),
      ResultTask.runPromise(read),
    ]);
    expect(first).toBe(second);
    expect(attempts).toBe(2);
    await ResultTask.runPromise(root.close());
  });

  test("one interrupted consumer does not cancel a singleton needed by another", async () => {
    const started = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    let acquisitions = 0;
    class Database extends Service<{ id: number }>()("database", {
      make: ResultTask.tryPromise({
        try: async (signal) => {
          acquisitions += 1;
          started.resolve();
          await ready.promise;
          expect(signal.aborted).toBe(false);
          return { id: acquisitions };
        },
        catch: (error) => error,
      }),
    }) {}
    const root = createModule().singleton(Database).scope();
    const read = root.use(["database"], ({ database }) => ResultTask.succeed(database.id));
    const controller = new AbortController();
    const first = ResultTask.runExit(read, { signal: controller.signal });
    await started.promise;
    const second = ResultTask.runPromise(read);
    controller.abort("request gone");
    expect(await first).toEqual({
      _tag: "Failure",
      cause: { _tag: "Interrupt", reason: "request gone" },
    });
    ready.resolve();
    expect(await second).toBe(1);
    expect(acquisitions).toBe(1);
    await ResultTask.runPromise(root.close());
  });

  test("drains all releases and preserves body, typed errors, and defects", async () => {
    const events: string[] = [];
    const defect = new Error("release defect");
    const module = createModule()
      .resource("first", [], {
        acquire: () => ResultTask.succeed(1),
        release: () =>
          ResultTask.sync(() => {
            events.push("first");
          }).flatMap(() => ResultTask.fail("first failure")),
      })
      .resource("second", ["first"], {
        acquire: () => ResultTask.succeed(2),
        release: () =>
          ResultTask.sync(() => {
            events.push("second");
            throw defect;
          }),
      });
    const exit = await ResultTask.runExit(module.use(["second"], () => ResultTask.fail("body")));
    expect(events).toEqual(["second", "first"]);
    expect(exit).toEqual({
      _tag: "Failure",
      cause: {
        _tag: "Sequential",
        left: { _tag: "Fail", error: "body" },
        right: {
          _tag: "Sequential",
          left: { _tag: "Die", defect },
          right: { _tag: "Fail", error: "first failure" },
        },
      },
    });
  });

  test("detects cycles with a dependency path", async () => {
    const A = ResultTask.service<string, "a">("a");
    const B = ResultTask.service<string, "b">("b");
    const module = createModule()
      .task("a", [], () =>
        ResultTask.gen(function* buildA() {
          return yield* B;
        }),
      )
      .task("b", [], () =>
        ResultTask.gen(function* buildB() {
          return yield* A;
        }),
      );
    const exit = await ResultTask.runExit(module.use(["a"], ({ a }) => ResultTask.succeed(a)));
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Die", defect: { message: "Cyclic dependencies detected: a -> b -> a" } },
    });
  });

  test("class tokens cannot pretend to construct the service contract", () => {
    expect(() => new Cache()).toThrow("Service classes are tokens");
    // eslint-disable-next-line no-constant-condition
    if (false) {
      // @ts-expect-error The token constructor does not instantiate the provided service.
      const value: { read: () => string } = new Cache();
      expect(value).toBeDefined();
    }
  });
});
