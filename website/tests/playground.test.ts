import assert from "node:assert/strict";
import { test } from "node:test";

import * as resultar from "../../packages/resultar/dist/index.js";
import { executePlaygroundInContext } from "../src/playground-core.js";
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
