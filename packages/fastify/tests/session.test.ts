import { getEventListeners } from "node:events";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ok, ResultAsync, ResultTask, ResultTaskCauseError, type Exit } from "resultar";
import { createModule, resource, service } from "resultar-di";
import { startSession } from "../src/session.js";

test("ResultAsync session consumers share eager acquisition and one completion", async () => {
  let acquired = 0;
  let released = 0;
  const Local = resource("local", {
    acquire: ResultTask.sync(() => {
      acquired += 1;
      return { id: acquired };
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const root = createModule().scoped(Local).scope();
  const session = startSession((hold) => root.use(["local"], hold));
  expectTypeOf(session.ready).toEqualTypeOf<
    ResultAsync<Readonly<Record<string, unknown>>, ResultTaskCauseError>
  >();
  expectTypeOf(session.completion).toEqualTypeOf<ResultAsync<Exit<void, unknown>, never>>();
  expectTypeOf(session.finish).returns.toEqualTypeOf<ResultAsync<Exit<void, unknown>, never>>();
  expect(session.ready).toBeInstanceOf(ResultAsync);
  expect(session.completion).toBeInstanceOf(ResultAsync);
  // Acquisition starts before the first consumer subscribes to ready.
  await expect.poll(() => acquired).toBe(1);
  const ready = await session.ready;
  expect(ready).toEqual(ok({ local: { id: 1 } }));
  expect(await session.ready).toBe(ready);
  expect(released).toBe(0);
  const completion = session.finish();
  expect(completion).toBe(session.completion);
  expect(session.finish()).toBe(completion);
  expect(await completion).toEqual(ok({ _tag: "Success", value: undefined }));
  expect(acquired).toBe(1);
  expect(released).toBe(1);
  await ResultTask.runExit(root.close());
  expect(released).toBe(1);
});

test("readiness failures remain Err values when observed after composite cleanup completes", async () => {
  const Local = resource("local", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("release failed"),
  });
  const Failing = service("failing", ResultTask.fail("acquisition failed"));
  const root = createModule().scoped(Local).scoped(Failing).scope();
  const session = startSession((hold) => root.use(["local", "failing"], hold));
  const cause = {
    _tag: "Sequential",
    left: { _tag: "Fail", error: "acquisition failed" },
    right: { _tag: "Fail", error: "release failed" },
  };
  // No rejected readiness promise is left unobserved while acquisition and rollback finish.
  expect(await session.completion).toEqual(ok({ _tag: "Failure", cause }));
  const ready = await session.ready;
  expect(ready.isErr()).toBe(true);
  if (ready.isErr()) {
    expect(ready.error).toBeInstanceOf(ResultTaskCauseError);
    expect(ready.error.cause).toEqual(cause);
  }
  expect(session.finish()).toBe(session.completion);
  await ResultTask.runExit(root.close());
});

test("release failure stays in completion while successful readiness is preserved", async () => {
  const Local = resource("local", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("release failed"),
  });
  const root = createModule().scoped(Local).scope();
  const session = startSession((hold) => root.use(["local"], hold));
  const ready = await session.ready;
  expect(ready).toEqual(ok({ local: 1 }));
  expect(await session.finish()).toEqual(
    ok({ _tag: "Failure", cause: { _tag: "Fail", error: "release failed" } }),
  );
  expect(await session.ready).toBe(ready);
  await ResultTask.runExit(root.close());
});

test.each(["before acquisition", "after readiness"] as const)(
  "abort %s settles completion and removes the session listener",
  async (when) => {
    const controller = new AbortController();
    const reason = new Error("Client disconnected");
    let acquired = 0;
    let released = 0;
    const Local = resource("local", {
      acquire: ResultTask.sync(() => {
        acquired += 1;
        return 1;
      }),
      release: () =>
        ResultTask.sync(() => {
          released += 1;
        }),
    });
    const root = createModule().scoped(Local).scope();
    if (when === "before acquisition") controller.abort(reason);
    const session = startSession((hold) => root.use(["local"], hold), controller.signal);
    if (when === "after readiness") {
      expect(await session.ready).toEqual(ok({ local: 1 }));
      controller.abort(reason);
    }
    expect(await session.completion).toEqual(
      ok({ _tag: "Failure", cause: { _tag: "Interrupt", reason } }),
    );
    if (when === "before acquisition") {
      const ready = await session.ready;
      expect(ready.isErr()).toBe(true);
      if (ready.isErr()) expect(ready.error.cause).toEqual({ _tag: "Interrupt", reason });
    }
    expect(acquired).toBe(when === "before acquisition" ? 0 : 1);
    expect(released).toBe(acquired);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(session.finish()).toBe(session.completion);
    await ResultTask.runExit(root.close());
  },
);

test("synchronous selection defects do not attach cancellation listeners", () => {
  const controller = new AbortController();
  const defect = new TypeError("Invalid service selection");
  expect(() =>
    startSession(() => {
      throw defect;
    }, controller.signal),
  ).toThrow(defect);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
