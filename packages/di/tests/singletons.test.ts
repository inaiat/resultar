import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask, type Result } from "resultar";
import { createModule, resource, service } from "../src/index.js";

test("useSingletons is lazy, shares acquisitions and retains resources until root close", async () => {
  const events: string[] = [];
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => {
      events.push("open");
      return { id: 1 };
    }),
    release: () =>
      ResultTask.sync(() => {
        events.push("close");
      }),
  });
  const scope = createModule().singleton(Connection).scope();
  const task = scope.useSingletons(["connection"], ({ connection }) =>
    ResultTask.succeed(connection.id),
  );
  expect(events).toEqual([]);
  expect(await ResultTask.runPromise(task)).toBe(1);
  expect(
    await ResultTask.runPromise(
      scope.use(["connection"], ({ connection }) => ResultTask.succeed(connection.id)),
    ),
  ).toBe(1);
  expect(events).toEqual(["open"]);
  await ResultTask.runPromise(scope.close());
  expect(events).toEqual(["open", "close"]);
  await expect(ResultTask.runPromise(task)).rejects.toThrow("closed");
});

test("rejects shorter-lived selections, callback tokens and request locals", async () => {
  const Scoped = service("scoped", {}, () => 1);
  const Transient = service("transient", {}, () => 2);
  const scope = createModule().scoped(Scoped).transient(Transient).scope();
  await expect(
    ResultTask.runPromise(scope.useSingletons(["scoped"], (values) => ResultTask.succeed(values))),
  ).rejects.toThrow("Lifetime violation");
  await expect(
    ResultTask.runPromise(
      scope.useSingletons(["transient"], (values) => ResultTask.succeed(values)),
    ),
  ).rejects.toThrow("Lifetime violation");
  await expect(
    ResultTask.runPromise(
      scope.useSingletons([], () =>
        Scoped.make.flatMap(() =>
          ResultTask.gen(function* callback() {
            return yield* Scoped;
          }),
        ),
      ),
    ),
  ).rejects.toThrow("Lifetime violation");
  await expect(
    ResultTask.runPromise(
      scope
        .withServices({ local: 1 })
        .useSingletons(["local"], (values) => ResultTask.succeed(values)),
    ),
  ).rejects.toThrow("Lifetime violation");
  await ResultTask.runPromise(scope.close());
});

test("root close waits for the application callback and retains selected error types", async () => {
  const finished = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const Bad = service("bad", ResultTask.fail("offline" as const));
  const scope = createModule().singleton(Bad).value("answer", 42).scope();
  const task = scope.useSingletons(["answer"], ({ answer }) => ResultTask.succeed(answer));
  expectTypeOf(ResultTask.runResult(task)).toEqualTypeOf<Promise<Result<number, never>>>();
  expectTypeOf(
    ResultTask.runResult(scope.useSingletons(["bad"], () => ResultTask.succeed(1))),
  ).toEqualTypeOf<Promise<Result<number, "offline">>>();
  const running = ResultTask.runPromise(
    scope.useSingletons([], () =>
      ResultTask.tryPromise({
        try: () => {
          ready.resolve();
          return finished.promise;
        },
        catch: (error) => error,
      }),
    ),
  );
  await ready.promise;
  let closed = false;
  const closing = ResultTask.runPromise(scope.close()).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finished.resolve();
  await running;
  await closing;
  expect(closed).toBe(true);
});
