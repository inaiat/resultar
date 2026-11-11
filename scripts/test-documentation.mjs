import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as recipes from "../packages/resultar/dist/agent/examples/contracts.mjs";
import { Cause, Fiber, ResultAsync, ResultTask } from "../packages/resultar/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("published recipes preserve lazy repetition, typed validation, retry and clock behavior", async () => {
  let calls = 0;
  const task = recipes.lazyLoad(async (signal) => {
    assert.equal(signal.aborted, false);
    return ++calls;
  });
  assert.equal(calls, 0);
  assert.equal(await task.runPromise(), 1);
  assert.equal(await task.runPromise(), 2);
  assert.equal(await recipes.normalize(3).runPromise(), 6);
  assert.equal((await recipes.normalize(0).runResult()).isErr(), true);
  const clock = recipes.virtualClock();
  const delays = [];
  let attempts = 0;
  // Observe requested delays without wall-clock sleeps; backoff must be numeric.
  const retry = await recipes
    .retryLoad(async () => {
      if (++attempts < 3) throw new Error("transient");
      return 42;
    })
    .runPromise({
      clock: {
        ...clock,
        now: () => clock.now(),
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
          await clock.advanceBy(ms);
        },
      },
    });
  assert.equal(retry, 42);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("published scopes release on success and retain cleanup failures", async () => {
  const events = [];
  const task = recipes.scopedRead(events);
  assert.deepEqual(events, []);
  assert.equal(await task.runPromise(), 7);
  assert.deepEqual(events, ["acquire", "read", "release"]);
  const exit = await recipes.scopedRead([], true).runExit();
  assert.equal(exit._tag, "Failure");
  assert.ok(Cause.failures(exit.cause).some((error) => error.operation === "release"));
  const disposal = [];
  assert.equal(await recipes.disposableRead(disposal).runPromise(), 9);
  assert.deepEqual(disposal, ["dispose"]);
  assert.deepEqual(await recipes.limited([1, 2, 3]).runPromise(), [2, 4, 6]);
});

test("driver adapters capture raw failures while typed bridges preserve their error channel", async () => {
  const failure = new Error("driver failed");
  for (const driver of [
    () => {
      throw failure;
    },
    () => Promise.reject(failure),
  ]) {
    const result = await recipes.lazyLoad(() => driver()).runResult();
    assert.equal(result.isErr(), true);
    assert.ok(result.error instanceof recipes.LoadError);
    assert.equal(result.error.operation, "load");
    assert.equal(result.error.cause, failure);
  }
  let calls = 0;
  const existingError = new recipes.LoadError({ operation: "existing", retryable: false });
  const task = recipes.bridgeExistingLoad((signal) => {
    assert.equal(signal.aborted, false);
    calls++;
    return ResultAsync.err(existingError);
  });
  assert.equal(calls, 0);
  for (let run = 0; run < 2; run++) {
    const result = await task.runResult();
    assert.equal(result.error, existingError);
  }
  assert.equal(calls, 2);
});

test("direct Promise adapter forwards interruption to the driver", async () => {
  const controller = new AbortController();
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  let interrupted = false;
  const task = recipes.lazyLoad(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            interrupted = true;
            reject(new Error("driver cancelled"));
          },
          { once: true },
        );
        notifyStarted();
      }),
  );
  const pending = task.runExit({ signal: controller.signal });
  await started;
  controller.abort();
  const exit = await pending;
  assert.equal(interrupted, true);
  assert.equal(exit._tag, "Failure");
  assert.equal(Cause.hasInterrupts(exit.cause), true);
});

test("published callback bridge cleans up on completion and interruption", async () => {
  const emitter = new EventEmitter();
  const ready = recipes.waitForReady(emitter);
  emitter.emit("ready", 8);
  assert.equal((await ready).unwrapOr(0), 8);
  assert.equal(emitter.listenerCount("ready"), 0);
  assert.equal(emitter.listenerCount("error"), 0);
  const controller = new AbortController();
  const cancelled = recipes.waitForReady(emitter, controller.signal);
  controller.abort();
  const result = await cancelled;
  assert.equal(result.isErr(), true);
  assert.equal(result.error.name, "AbortError");
  assert.equal(emitter.listenerCount("ready"), 0);
  assert.equal(emitter.listenerCount("error"), 0);
});

test("published matching, redaction, fallbacks, races and causes use real APIs", async () => {
  assert.equal(recipes.stateValue(recipes.State.Idle()), 0);
  assert.equal(recipes.stateValue(recipes.State.Ready({ value: 8 })), 8);
  assert.equal(await recipes.status(recipes.normalize(4)).runPromise(), 8);
  assert.equal(recipes.redactedToken(), "<redacted:token>");
  assert.equal(recipes.syncFallback().unwrapOr(0), 42);
  assert.equal(await recipes.raceSuccess().runPromise(), 42);
  assert.equal((await recipes.raceCompletion().runResult()).isErr(), true);
  assert.equal(await recipes.runDefectInspection(), true);
});

test("runResult rejects interruption while runExit retains it and awaits release", async () => {
  const events = [];
  let acquired;
  const ready = new Promise((resolve) => {
    acquired = resolve;
  });
  const task = ResultTask.scoped(
    ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        acquired();
        return 1;
      }),
      release: () =>
        ResultTask.sync(() => {
          events.push("release");
        }),
    }).andThen(() => ResultTask.sleep(60_000)),
  );
  const handle = task.runFork();
  await ready;
  await Fiber.interrupt(handle).runExit();
  const exit = await Fiber.await(handle).runPromise();
  assert.equal(exit._tag, "Failure");
  assert.equal(Cause.hasInterrupts(exit.cause), true);
  assert.deepEqual(events, ["release"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Promise.resolve(ResultTask.sleep(1).runResult({ signal: controller.signal })),
  );
});

test("every documented native rule severity agrees with the implementation", () => {
  const source = readFileSync(
    join(root, "packages/check/native/internal/config/config.go"),
    "utf8",
  );
  const defaults = source.slice(source.indexOf("func Defaults()"), source.indexOf("func Load("));
  const options = new Map(
    [...defaults.matchAll(/(\w+):\s+Severity(\w+)/g)]
      .filter(([, name]) => name !== "FailOn")
      .map(([, name, severity]) => [name[0].toLowerCase() + name.slice(1), severity.toLowerCase()]),
  );
  const manual = readFileSync(join(root, "packages/check/README.md"), "utf8");
  const rows = [...manual.matchAll(/^\| `([^`]+)`\s+\| `([^`]+)`\s+\| `([^`]+)`/gm)];
  assert.equal(rows.length, options.size);
  for (const [, rule, option, severity] of rows) assert.equal(severity, options.get(option), rule);
});

test("bundled guide links resolve locally, including companion manuals", () => {
  const bundle = join(root, "packages/resultar/dist/agent");
  let localLinks = 0;
  for (const entry of readdirSync(bundle, { recursive: true }).filter((name) =>
    name.endsWith(".md"),
  )) {
    const path = join(bundle, entry);
    for (const [, href] of readFileSync(path, "utf8").matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      localLinks++;
      assert.ok(existsSync(resolve(dirname(path), href.split("#")[0])), `${entry}: ${href}`);
    }
  }
  assert.ok(localLinks > 100);
});
