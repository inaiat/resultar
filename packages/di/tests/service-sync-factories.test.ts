import { ResultTask } from "resultar";
import { expect, test } from "vite-plus/test";
import { Service, createModule, resource } from "../src/index.js";

test("constructs synchronous services lazily after ordered dependency resolution", async () => {
  const events: string[] = [];
  const First = Service("first", {
    requires: {},
    make: () => {
      events.push("first");
      return 1;
    },
  });
  const Second = Service("second", {
    requires: {},
    make: () => {
      events.push("second");
      return 2;
    },
  });
  class Total extends Service<{ value: number }>()("total", {
    requires: { left: First, right: Second },
    make: (dependencies) => {
      expect(Object.isFrozen(dependencies)).toBe(true);
      events.push("factory");
      return { value: dependencies.left + dependencies.right };
    },
  }) {}
  const task = createModule()
    .singleton(First)
    .scoped(Second)
    .scoped(Total)
    .use(["total"], ({ total }) => ResultTask.succeed(total));
  expect(events).toEqual([]);
  expect(Total.make).toBeInstanceOf(ResultTask);
  expect(await ResultTask.runPromise(task)).toEqual({ value: 3 });
  expect(events).toEqual(["first", "second", "factory"]);
});

test("synchronous factories follow singleton, scoped and transient lifetimes", async () => {
  let creations = 0;
  const definition = {
    requires: {},
    make: () => {
      creations += 1;
      return { id: creations };
    },
  };
  const Shared = Service("shared", definition);
  const Local = Service("local", definition);
  const Fresh = Service("fresh", definition);
  const application = createModule().singleton(Shared).scoped(Local).transient(Fresh).scope();
  const task = application.use(["shared", "local", "fresh"], (first) =>
    ResultTask.gen(function* resolveAgain() {
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

test("missing dependencies prevent a synchronous factory from running", async () => {
  let called = false;
  const Missing = Service.require<number>()("missing");
  const Dependent = Service("dependent", {
    requires: { value: Missing },
    make: ({ value }) => {
      called = true;
      return { value };
    },
  });
  const task = createModule()
    .scoped(Dependent)
    .use(["dependent"], ({ dependent }) => ResultTask.succeed(dependent));
  expect(await ResultTask.runExit(task, { services: {} as never })).toMatchObject({
    _tag: "Failure",
    cause: { _tag: "Die", defect: { message: "Missing ResultTask service: missing" } },
  });
  expect(called).toBe(false);
});

test.each(["defect", "interrupt"] as const)(
  "releases resources on synchronous factory %s",
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
      make: ({ connection }) => {
        if (mode === "defect") throw new Error("broken factory");
        controller.abort("stop");
        return { connection };
      },
    });
    const task = createModule()
      .scoped(Connection)
      .scoped(Broken)
      .use(["broken"], ({ broken }) => ResultTask.succeed(broken));
    expect(events).toEqual([]);
    const exit = await ResultTask.runExit(task, { signal: controller.signal });
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause:
        mode === "defect"
          ? { _tag: "Die", defect: { message: "broken factory" } }
          : { _tag: "Interrupt", reason: "stop" },
    });
    expect(events).toEqual(["open", "close"]);
  },
);

test("accepts synchronous null, undefined, functions and non-callable then properties", async () => {
  // eslint-disable-next-line unicorn/no-null -- Null is a valid synchronous service value.
  const Nil = Service("nil", { requires: {}, make: () => null });
  const Empty = Service()("empty", {
    requires: {},
    make: () => {
      /* A synchronous provider may have no value. */
    },
  });
  const Callable = Service("callable", { requires: {}, make: () => () => 42 });
  // eslint-disable-next-line unicorn/no-thenable -- A non-callable then is ordinary data.
  const Data = Service("data", { requires: {}, make: () => ({ then: "later" }) });
  const task = createModule()
    .scoped(Nil)
    .scoped(Empty)
    .scoped(Callable)
    .scoped(Data)
    .use(["nil", "empty", "callable", "data"], (values) => ResultTask.succeed(values));
  const values = await ResultTask.runPromise(task);
  expect(values.nil).toBeNull();
  expect(values.empty).toBeUndefined();
  expect(values.callable()).toBe(42);
  expect(values.data.then).toBe("later");
});
