import assert from "node:assert/strict";
import { test } from "node:test";

import { runPlaygroundCode } from "../src/playground-runner.js";
import { PLAYGROUND_PRESETS } from "../src/presets.js";
import { transpilePlaygroundTs } from "../src/ts-strip.js";

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
  assert.match(js, /const \{ ok \} = __resultar;/u);
  assert.match(js, /"type: <not stripped>"/u);
  assert.match(js, /\/\/ Keep : string and <T> inside comments/u);
  assert.doesNotMatch(js, /interface User/u);
  assert.doesNotMatch(js, /type Alias/u);
});

void test("transpilePlaygroundTs rejects non-resultar imports clearly", () => {
  assert.throws(
    () => transpilePlaygroundTs('import { readFileSync } from "node:fs";'),
    /Playground only supports imports from "resultar"/u,
  );
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
