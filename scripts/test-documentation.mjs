import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("published lazy callback recipe repeats subscriptions and releases on interruption", async () => {
  const emitter = new EventEmitter();
  const task = recipes.waitForReadyTask(emitter);
  assert.equal(emitter.listenerCount("ready"), 0);
  for (const value of [1, 2]) {
    const pending = task.runPromise();
    emitter.emit("ready", value);
    assert.equal(await pending, value);
    assert.equal(emitter.listenerCount("ready"), 0);
    assert.equal(emitter.listenerCount("error"), 0);
  }
  const controller = new AbortController();
  const pending = task.runExit({ signal: controller.signal });
  controller.abort("stop");
  assert.deepEqual(await pending, { _tag: "Failure", cause: { _tag: "Interrupt", reason: "stop" } });
  assert.equal(emitter.listenerCount("ready"), 0);
  assert.equal(emitter.listenerCount("error"), 0);
});

test("published never recipe keeps resources alive until interruption", async () => {
  const events = [];
  const task = recipes.holdResource(events);
  assert.deepEqual(events, []);
  const controller = new AbortController();
  const running = task.runExit({ signal: controller.signal });
  assert.deepEqual(events, ["open"]);
  controller.abort("shutdown");
  assert.deepEqual(await running, { _tag: "Failure", cause: { _tag: "Interrupt", reason: "shutdown" } });
  assert.deepEqual(events, ["open", "close"]);
});

test("published Promise defect factory preserves rejection and lazy execution", async () => {
  let calls = 0;
  const task = recipes.promiseDefectBoundary(async () => ++calls);
  assert.equal(calls, 0);
  assert.equal(await task.runPromise(), 1);
  assert.equal(await task.runPromise(), 2);
  const defect = new Error("SDK defect");
  await assert.rejects(Promise.resolve(recipes.promiseDefectBoundary(() => Promise.reject(defect)).runResult()), error => error === defect);
});

test("no documentation file appends content after its License section", () => {
  const candidates = [
    "README.md",
    "DOCUMENTATION.md",
    ...readdirSync(join(root, "packages"))
      .map((dir) => join("packages", dir, "README.md"))
      .filter((rel) => existsSync(join(root, rel))),
  ];
  for (const rel of candidates) {
    const content = readFileSync(join(root, rel), "utf8");
    const marker = content.lastIndexOf("\n## License\n");
    if (marker === -1) continue;
    const afterLicense = content.slice(marker + "\n## License\n".length).trim();
    const nonEmptyLines = afterLicense.split("\n").filter((line) => line.trim().length > 0);
    assert.ok(
      nonEmptyLines.length <= 2 && !/^#{2,6}\s/m.test(afterLicense),
      `${rel} has unexpected content appended after ## License:\n${afterLicense.slice(0, 200)}`,
    );
  }
});

test("llms.txt keeps Freshness rule as its final section and covers every workspace package", () => {
  const llms = readFileSync(join(root, "llms.txt"), "utf8");
  const freshnessIndex = llms.lastIndexOf("\n## Freshness rule\n");
  assert.notEqual(freshnessIndex, -1, "llms.txt must contain a ## Freshness rule section");
  const tail = llms.slice(freshnessIndex + "\n## Freshness rule\n".length);
  assert.equal(/^##\s/m.test(tail), false, "llms.txt must not append headings after ## Freshness rule");

  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const dir of readdirSync(join(root, "packages"))) {
    const manifestPath = join(root, "packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private === true) continue;
    assert.ok(readme.includes(manifest.name), `README.md is missing package ${manifest.name}`);
    assert.ok(llms.includes(manifest.name), `llms.txt is missing package ${manifest.name}`);
  }
});

test("rule counts cited across docs and skill match packages/check/README.md", () => {
  const checkerReadme = readFileSync(join(root, "packages/check/README.md"), "utf8");
  const expectedRuleCount = [
    ...checkerReadme.matchAll(/^\| `([^`]+)`\s+\| `([^`]+)`\s+\| `([^`]+)`/gm),
  ].length;
  assert.ok(expectedRuleCount > 0, "expected at least one documented rule");

  const docsToCheck = [
    "README.md",
    "DOCUMENTATION.md",
    "llms.txt",
    "packages/resultar/README.md",
    "skills/resultar/references/anti-patterns.md",
  ];
  const ruleCountPattern =
    /\b(?:all\s+)?(\d+)\s+(?:native\s+)?(?:static analysis\s+)?(?:TypeScript-Go\s+)?(?:rules|diagnostics|diagnostic IDs)\b/gi;
  for (const rel of docsToCheck) {
    const content = readFileSync(join(root, rel), "utf8");
    for (const match of content.matchAll(ruleCountPattern)) {
      const cited = Number(match[1]);
      assert.equal(
        cited,
        expectedRuleCount,
        `${rel} cites "${match[0]}" but packages/check/README.md documents ${expectedRuleCount} rules`,
      );
    }
  }
});

test("coming-from-effect example compiles strictly and executes, and RFC 0010 links resolve", async () => {
  for (const rel of [
    "docs/coming-from-effect.md",
    "docs/rfcs/README.md",
    "docs/rfcs/rfc-0010-dx-observability-concurrency-and-tooling.md",
  ]) {
    const filePath = join(root, rel);
    const content = readFileSync(filePath, "utf8");
    for (const [, href] of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const target = resolve(dirname(filePath), href.split("#")[0]);
      assert.ok(existsSync(target), `Broken link in ${rel}: ${href}`);
    }
  }

  const guide = readFileSync(join(root, "docs/coming-from-effect.md"), "utf8");
  const codeBlockMatch = guide.match(/```ts\n([\s\S]*?)```/);
  assert.ok(codeBlockMatch, "expected a TypeScript example block in docs/coming-from-effect.md");

  const tempDir = mkdtempSync(join(tmpdir(), "resultar-effect-doc-"));
  try {
    const distUrl = pathToFileURL(join(root, "packages/resultar/dist/index.js")).href;
    const distTypes = join(root, "packages/resultar/dist/index.d.ts");
    writeFileSync(join(tempDir, "package.json"), '{"type":"module"}\n', "utf8");
    writeFileSync(
      join(tempDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            outDir: "./out",
            paths: { resultar: [distTypes] },
          },
          include: ["example.mts"],
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(tempDir, "example.mts"),
      `${codeBlockMatch[1]}\nexport { exit, autoExit, tracer };\n`,
      "utf8",
    );

    const requireFromCore = createRequire(join(root, "packages/resultar/package.json"));
    const tscBin = join(dirname(requireFromCore.resolve("typescript/package.json")), "bin/tsc");
    try {
      execFileSync(process.execPath, [tscBin, "--project", join(tempDir, "tsconfig.json")], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      assert.fail(`Failed to compile docs/coming-from-effect.md snippet:\n${error.stdout ?? error}`);
    }

    const compiledPath = join(tempDir, "out/example.mjs");
    const rewritten = readFileSync(compiledPath, "utf8").replace(
      /from\s+["']resultar["']/g,
      `from ${JSON.stringify(distUrl)}`,
    );
    writeFileSync(compiledPath, rewritten, "utf8");

    const mod = await import(pathToFileURL(compiledPath).href);
    assert.equal(mod.exit._tag, "Success");
    assert.deepEqual(mod.exit.value, { id: "u-1", name: "Ada" });
    assert.equal(mod.autoExit._tag, "Success");
    assert.equal(mod.tracer.spans.length, 2);
    assert.equal(mod.tracer.spans[0].name, "users.load");
    assert.equal(mod.tracer.spans[1].name, "users.repo.find");
    assert.equal(mod.tracer.spans[1].parentName, "users.load");
    assert.equal(mod.tracer.spans[1].attributes["request.id"], "req-42");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
