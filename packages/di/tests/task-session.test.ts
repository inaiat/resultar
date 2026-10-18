import { ResultTask } from "resultar";
import { expect, test } from "vite-plus/test";
import { startServiceTask } from "../src/index.js";

// The native adapters bind requirements to DI before running the task.
const scoped = (task: ResultTask<void, unknown, unknown>) =>
  ResultTask.scoped(task as ResultTask<void, unknown>);

test("session reports synchronous binding defects without throwing at construction", async () => {
  const defect = new Error("bind failed");
  const session = startServiceTask(() => {
    throw defect;
  }, ResultTask.succeed(globalThis.undefined));
  const ready = await session.ready;
  expect(ready.isErr()).toBe(true);
  if (ready.isErr()) expect(ready.error.cause).toEqual({ _tag: "Die", defect });
  const closed = await session.close();
  expect(closed.isOk()).toBe(true);
});

test("close before readiness interrupts execution without acquiring resources", async () => {
  let acquired = 0;
  const session = startServiceTask(
    scoped,
    ResultTask.sync(() => {
      acquired += 1;
    }),
  );
  const first = session.close();
  expect(session.close()).toBe(first);
  const closed = await first;
  const ready = await session.ready;
  expect(closed.isOk()).toBe(true);
  expect(ready.isErr()).toBe(true);
  expect(acquired).toBe(0);
});

test("cancellation retains finalizer failures and close is idempotent", async () => {
  const entered = Promise.withResolvers<void>();
  const session = startServiceTask(
    scoped,
    ResultTask.gen(function* initialize() {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.succeed({}),
        release: () => ResultTask.fail("cleanup"),
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
  );
  await entered.promise;
  const first = session.close();
  expect(session.close()).toBe(first);
  const closed = await first;
  expect(closed.isErr()).toBe(true);
  if (closed.isErr())
    expect(closed.error.cause).toMatchObject({
      _tag: "Sequential",
      left: { _tag: "Interrupt" },
      right: { _tag: "Fail", error: "cleanup" },
    });
});
