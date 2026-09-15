import { ResultTask } from "resultar";
import { expect, test } from "vite-plus/test";
import { Service, createModule, resource } from "../src/index.js";

test("resolves explicit dependencies lazily in order and includes yielded requirements", async () => {
  const events: string[] = [];
  const First = Service("first", {
    make: ResultTask.sync(() => {
      events.push("first");
      return 1;
    }),
  });
  const Second = Service("second", {
    make: ResultTask.sync(() => {
      events.push("second");
      return 2;
    }),
  });
  class Total extends Service("total", {
    requires: { left: First, right: Second },
    make: (dependencies) => {
      expect(Object.isFrozen(dependencies)).toBe(true);
      events.push("factory");
      return ResultTask.gen(function* construct() {
        const extra = yield* Service.require<number>()("extra");
        events.push("task");
        return dependencies.left + dependencies.right + extra;
      });
    },
  }) {}
  const module = createModule().singleton(First).scoped(Second).scoped(Total).value("extra", 3);
  const task = module.use(["total"], ({ total }) => ResultTask.succeed(total));
  expect(events).toEqual([]);
  expect(await ResultTask.runPromise(task)).toBe(6);
  expect(events).toEqual(["first", "second", "factory", "task"]);
});

test("keeps singleton, scoped and transient lifetimes with requires", async () => {
  let creations = 0;
  const Config = Service.require<string>()("config");
  const definition = {
    requires: { config: Config },
    make: ({ config }: { readonly config: string }) =>
      ResultTask.sync(() => {
        creations += 1;
        return { config, id: creations };
      }),
  };
  const Shared = Service("shared", definition);
  const Local = Service("local", definition);
  const Fresh = Service("fresh", definition);
  const application = createModule()
    .value("config", "ok")
    .singleton(Shared)
    .scoped(Local)
    .transient(Fresh)
    .scope();
  const task = application.use(["shared", "local", "fresh"], (first) =>
    ResultTask.gen(function* construct() {
      expect(yield* Shared).toBe(first.shared);
      expect(yield* Local).toBe(first.local);
      expect(yield* Fresh).not.toBe(first.fresh);
      return first;
    }),
  );
  expect(creations).toBe(0);
  const first = await ResultTask.runPromise(task);
  const second = await ResultTask.runPromise(task);
  expect(first.shared).toBe(second.shared);
  expect(first.local).not.toBe(second.local);
  expect(first.fresh).not.toBe(second.fresh);
  expect(creations).toBe(7);
  await ResultTask.runPromise(application.close());
});

test("requires does not register providers and stops before the factory on a missing dependency", async () => {
  let initialized = false;
  const Missing = Service("missing", {
    make: ResultTask.sync(() => {
      initialized = true;
      return 1;
    }),
  });
  const Dependent = Service("dependent", {
    requires: { missing: Missing },
    make: () =>
      ResultTask.sync(() => {
        initialized = true;
        return 2;
      }),
  });
  const task = createModule()
    .scoped(Dependent)
    .use(["dependent"], ({ dependent }) => ResultTask.succeed(dependent));
  const exit = await ResultTask.runExit(task, { services: {} as never });
  expect(exit).toMatchObject({
    _tag: "Failure",
    cause: { _tag: "Die", defect: { message: "Missing ResultTask service: missing" } },
  });
  expect(initialized).toBe(false);
});

test("accepts empty requires and prototype-like aliases", async () => {
  const Independent = Service<{ value: number }>()("independent", {
    requires: {},
    make: () => ResultTask.succeed({ value: 42 }),
  });
  const Alias = Service()("alias", {
    requires: { ["__proto__"]: Independent },
    make: (deps) =>
      ResultTask.sync(() => {
        expect(Object.hasOwn(deps, "__proto__")).toBe(true);
        // eslint-disable-next-line no-proto -- This is an own injected alias, not prototype access.
        return deps.__proto__.value;
      }),
  });
  const task = createModule()
    .singleton(Independent)
    .scoped(Alias)
    .use(["alias"], ({ alias }) => ResultTask.succeed(alias));
  expect(await ResultTask.runPromise(task)).toBe(42);
});

test.each(["failure", "defect", "interrupt"] as const)(
  "releases acquired dependencies on initialization %s",
  async (mode) => {
    const events: string[] = [];
    const controller = new AbortController();
    const Connection = resource("connection", {
      acquire: ResultTask.sync(() => {
        events.push("open");
        return 1;
      }),
      release: () =>
        ResultTask.sync(() => {
          events.push("close");
        }),
    });
    const Broken = Service("broken", {
      requires: { connection: Connection },
      make: () => {
        if (mode === "defect") throw new Error("broken factory");
        if (mode === "failure") return ResultTask.fail("broken task" as const);
        return ResultTask.sync(() => {
          controller.abort("stop");
          return 1;
        });
      },
    });
    const task = createModule()
      .scoped(Connection)
      .scoped(Broken)
      .use(["broken"], ({ broken }) => ResultTask.succeed(broken));
    const exit = await ResultTask.runExit(task, { signal: controller.signal });
    const causes = {
      failure: { _tag: "Fail", error: "broken task" },
      defect: { _tag: "Die", defect: { message: "broken factory" } },
      interrupt: { _tag: "Interrupt", reason: "stop" },
    };
    const cause = causes[mode];
    expect(exit).toMatchObject({ _tag: "Failure", cause });
    expect(events).toEqual(["open", "close"]);
  },
);

test("preserves finalizer failures from the returned construction task", async () => {
  const Owned = Service("owned", {
    requires: {},
    make: () =>
      ResultTask.acquireRelease({
        acquire: ResultTask.succeed(42),
        release: () => ResultTask.fail("release" as const),
      }),
  });
  const task = createModule()
    .scoped(Owned)
    .use(["owned"], ({ owned }) => ResultTask.succeed(owned));
  expect(await ResultTask.runExit(task)).toEqual({
    _tag: "Failure",
    cause: { _tag: "Fail", error: "release" },
  });
});

test("rejects invalid factory shapes and returns as programmer defects", async () => {
  // @ts-expect-error Without requires, make must be a task.
  expect(() => Service("invalid", { make: () => ResultTask.succeed(1) })).toThrow(
    "Service make must be a ResultTask",
  );
  // @ts-expect-error With requires, make must be a factory.
  expect(() => Service("invalid", { requires: {}, make: ResultTask.succeed(1) })).toThrow(
    "Service make must be a factory",
  );
});

test.each([() => ({ value: 1 }), () => Promise.resolve(1)])(
  "rejects a non-task factory return",
  async (invalid) => {
    // @ts-expect-error Factories must return ResultTask.
    const Invalid = Service("invalid", { requires: {}, make: invalid });
    const task = createModule()
      .scoped(Invalid)
      .use(["invalid"], ({ invalid: value }) => ResultTask.succeed(value));
    expect(await ResultTask.runExit(task)).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Die", defect: { message: "Service make factory must return a ResultTask" } },
    });
  },
);
