import assert from "node:assert/strict";
import { test } from "node:test";

import * as resultar from "../../packages/resultar/dist/index.js";
import { executePlaygroundInContext, sanitizeSpan } from "../src/playground-core.js";
import { parseSpans } from "../src/playground-runner.js";
import { PLAYGROUND_PRESETS } from "../src/presets.js";
import { transpilePlaygroundTs } from "../src/ts-strip.js";

const runPlaygroundCode = async (source: string) => executePlaygroundInContext(source, resultar);

void test("transpilePlaygroundTs preserves strings and comments while stripping TypeScript syntax", () => {
  const source = `import { ok, type Result } from "resultar";
// Keep : string and <T> inside comments
interface User { readonly id: string }
type Alias = Result<User, Error>;
const label: string = "type: <not stripped>";
const makeUser = (id: string, active: boolean = true): User => ({ id });
console.log(label, makeUser("u-1"), ok(42));
`;
  const js = transpilePlaygroundTs(source);
  assert.match(js, /require\(['"]resultar['"]\)/u);
  assert.match(js, /"type: <not stripped>"/u);
  assert.match(js, /\/\/ Keep : string and <T> inside comments/u);
  assert.doesNotMatch(js, /interface User/u);
  assert.doesNotMatch(js, /type Alias/u);
});

void test("the playground rejects non-resultar imports clearly", async () => {
  const result = await runPlaygroundCode('import { readFileSync } from "node:fs";');
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Playground only supports imports from "resultar"/u);
});

void test("loads public subpaths with their actual exports", async () => {
  const result = await runPlaygroundCode(`
    import { Retry, type RetryPolicy } from "resultar/retry";
    import * as retry from "resultar/retry";
    import { ResultTask } from "resultar/task";
    import { ok } from "resultar/result";
    const policy: RetryPolicy = Retry.policy({ times: 2 });
    console.log(policy.times, Object.keys(retry).join(","), (await ResultTask.ok(ok(42)).runPromise()).value);
  `);
  assert.ok(result.ok, result.error ?? "Expected the public subpaths to load");
  assert.deepEqual(result.logs, [{ level: "log", text: "2 Retry 42" }]);
});

void test("rejects unknown subpaths and unavailable bindings before running the snippet", async () => {
  const wrongSubpath = await runPlaygroundCode('import { ok } from "resultar/typo";');
  assert.equal(wrongSubpath.ok, false);
  assert.match(wrongSubpath.error ?? "", /resultar\/typo/u);

  const wrongBinding = await runPlaygroundCode(
    'import { ok as success } from "resultar/retry"; console.log("started");',
  );
  assert.equal(wrongBinding.ok, false);
  assert.match(wrongBinding.error ?? "", /export named "ok"/u);
  assert.deepEqual(wrongBinding.logs, []);

  const wrongDefault = await runPlaygroundCode('import retry from "resultar/retry";');
  assert.equal(wrongDefault.ok, false);
  assert.match(wrongDefault.error ?? "", /export named "default"/u);

  const missingRuntime = await runPlaygroundCode(
    'import { NonExistent } from "resultar"; console.log(NonExistent);',
  );
  assert.equal(missingRuntime.ok, false);
  assert.match(missingRuntime.error ?? "", /export named "NonExistent"/u);
  assert.deepEqual(missingRuntime.logs, []);

  const typeUsedAsRuntime = await runPlaygroundCode(
    'import { ResultTaskScope } from "resultar"; console.log(ResultTaskScope);',
  );
  assert.equal(typeUsedAsRuntime.ok, false);
  assert.match(typeUsedAsRuntime.error ?? "", /export named "ResultTaskScope"/u);

  const wrongReExport = await runPlaygroundCode('export { DoesNotExist } from "resultar";');
  assert.equal(wrongReExport.ok, false);
  assert.match(wrongReExport.error ?? "", /export named "DoesNotExist"/u);

  const wrongAliasedReExport = await runPlaygroundCode(
    'export { DoesNotExist as alias } from "resultar";',
  );
  assert.equal(wrongAliasedReExport.ok, false);
  assert.match(wrongAliasedReExport.error ?? "", /export named "DoesNotExist"/u);

  const wrongExportAll = await runPlaygroundCode('export * from "resultar/typo";');
  assert.equal(wrongExportAll.ok, false);
  assert.match(wrongExportAll.error ?? "", /resultar\/typo/u);
});

void test("allows type-only imports without the type keyword, valid re-exports, and decorator syntax parsing", async () => {
  const typeImports = await runPlaygroundCode(`
    import {
      ResultTask,
      ResultTaskScope,
      ResultTaskScope as ScopeAlias,
      Exit,
      StrictResult,
      RetryPolicy,
      ServiceTag,
      ok,
    } from "resultar";

    type Bundle = {
      readonly exit: Exit<number, Error>;
      readonly result: StrictResult<number, Error>;
      readonly policy: RetryPolicy;
      readonly tag: ServiceTag<"Db", { readonly ping: () => string }>;
      readonly scope: ScopeAlias;
    };

    const describeScope = (scope: ResultTaskScope): ResultTask<string> =>
      ResultTask.ok(typeof scope);

    const sample: StrictResult<number, never> = ok(42);
    const marker: Bundle | null = null;
    console.log(sample.unwrapOr(0), typeof describeScope, marker);
  `);
  assert.ok(
    typeImports.ok,
    typeImports.error ?? "Expected type-only imports without `type` to run",
  );
  assert.deepEqual(typeImports.logs, [{ level: "log", text: "42 function null" }]);

  const validReExports = await runPlaygroundCode(`
    export { ok } from "resultar";
    export type { Exit, ResultTaskScope } from "resultar";
    export { type RetryPolicy } from "resultar/retry";
    console.log("re-exports ok");
  `);
  assert.ok(validReExports.ok, validReExports.error ?? "Expected valid re-exports to run");
  assert.deepEqual(validReExports.logs, [{ level: "log", text: "re-exports ok" }]);

  // Decorator syntax parses with Babel's "decorators" plugin so module import errors surface cleanly.
  const decoratedExternal = await runPlaygroundCode(`
    import { Injectable } from "@nestjs/common";
    @Injectable()
    export class UsersService {}
  `);
  assert.equal(decoratedExternal.ok, false);
  assert.match(decoratedExternal.error ?? "", /Playground only supports imports from "resultar"/u);
  assert.doesNotMatch(decoratedExternal.error ?? "", /experimental syntax/u);
});

void test("filters and sanitizes non-finite span timestamps in core and runner", async () => {
  const result = await runPlaygroundCode(`
    console.log([
      {
        name: "bad.nanStart",
        attributes: {},
        startTime: Number.NaN,
        endTime: 10,
        durationMs: 5,
      },
      {
        name: "bad.infStart",
        attributes: {},
        startTime: Number.POSITIVE_INFINITY,
        endTime: 10,
        durationMs: 5,
      },
    ]);
    console.log([
      {
        name: "ok.partial",
        attributes: { ok: true },
        startTime: 100,
        endTime: Number.NaN,
        durationMs: Number.POSITIVE_INFINITY,
      },
    ]);
  `);
  assert.ok(result.ok, result.error ?? "Expected snippet logging malformed spans to execute");
  assert.equal(result.spans.length, 1);
  assert.equal(result.spans[0]?.name, "ok.partial");
  assert.equal(result.spans[0]?.startTime, 100);
  assert.equal(result.spans[0]?.endTime, undefined);
  assert.equal(result.spans[0]?.durationMs, undefined);

  const sanitized = sanitizeSpan({
    name: "direct.bad",
    parentName: undefined,
    attributes: {},
    startTime: Number.NaN,
    endTime: Number.POSITIVE_INFINITY,
    durationMs: Number.NaN,
    exit: undefined,
  });
  assert.equal(Number.isFinite(sanitized.startTime), true);
  assert.equal(sanitized.endTime, undefined);
  assert.equal(sanitized.durationMs, undefined);

  const parsed = parseSpans([
    { name: "drop.nan", attributes: {}, startTime: Number.NaN, endTime: 10, durationMs: 5 },
    {
      name: "drop.inf",
      attributes: {},
      startTime: Number.NEGATIVE_INFINITY,
      endTime: 10,
      durationMs: 5,
    },
    {
      name: "keep.clean",
      attributes: { env: "test" },
      startTime: 25,
      endTime: Number.POSITIVE_INFINITY,
      durationMs: Number.NaN,
    },
    { name: "keep.valid", attributes: {}, startTime: 25, endTime: 40, durationMs: 15 },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.name, "keep.clean");
  assert.equal(parsed[0]?.startTime, 25);
  assert.equal(parsed[0]?.endTime, undefined);
  assert.equal(parsed[0]?.durationMs, undefined);
  assert.equal(parsed[1]?.name, "keep.valid");
  assert.equal(parsed[1]?.endTime, 40);
  assert.equal(parsed[1]?.durationMs, 15);
});

void test("runs compatibility imports and preserves JavaScript expressions inside templates", async () => {
  const result = await runPlaygroundCode(
    [
      'import { okAsync } from "resultar/async";',
      "const a = 1, b = 2, c = 3, d = 2;",
      // eslint-disable-next-line no-template-curly-in-string -- This is source code evaluated by the playground.
      'console.log(`${(await okAsync(42)).value as number}`, a<b && c>(d), /: string/.test(": string"));',
    ].join("\n"),
  );
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.logs), /42 true true/u);
});

void test("all curated playground presets execute cleanly against live resultar", async () => {
  assert.equal(PLAYGROUND_PRESETS.length, 6);

  for (const preset of PLAYGROUND_PRESETS) {
    // eslint-disable-next-line no-await-in-loop -- Run each preset deterministically for clear diagnostics.
    const result = await runPlaygroundCode(preset.code);
    assert.equal(
      result.ok,
      true,
      `Preset "${preset.id}" failed: ${result.error ?? "unknown error"}\nLogs: ${result.logs.map((l) => l.text).join("\n")}`,
    );
    assert.ok(result.logs.length > 0, `Preset "${preset.id}" produced no output logs`);

    if (preset.id === "result-errors") {
      assert.ok(result.logs.some((entry) => entry.text.includes("<redacted:apiKey>")));
    }
    if (preset.id === "retry-virtual-clock") {
      assert.ok(result.logs.some((entry) => entry.text.includes("Virtual elapsed ms: 1350")));
    }
    if (preset.id === "concurrency") {
      assert.ok(result.logs.some((entry) => entry.text.includes("DELTA")));
    }
    if (preset.id === "observability") {
      assert.equal(result.spans.length, 3);
      assert.equal(result.spans[0]?.name, "http.getProfile");
      assert.equal(result.spans[1]?.parentName, "http.getProfile");
      assert.ok(result.logs.some((entry) => entry.text.includes("Span trace:")));
    }
  }
});
