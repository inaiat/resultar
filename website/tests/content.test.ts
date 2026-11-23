import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import * as resultar from "../../packages/resultar/dist/index.js";
import { isPlaygroundCandidate, renderInline, renderMarkdown } from "../scripts/build-content.mjs";
import {
  DOC_LOADERS,
  DOC_SLUGS,
  NAV_SECTIONS,
  SEARCH_INDEX,
  SITE_META,
} from "../src/generated/site-data.js";
import { executePlaygroundInContext } from "../src/playground-core.js";
import { searchDocs } from "../src/search.js";

void test("generated docs cover every nav item and all internal docs links resolve", async () => {
  assert.ok(SITE_META.pageCount >= 26);
  assert.equal(SITE_META.ruleCount, 43);

  const slugSet = new Set(DOC_SLUGS);

  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const loader = DOC_LOADERS[item.slug];
      assert.ok(loader !== undefined, `Missing DOC_LOADERS entry for ${item.slug}`);
      // eslint-disable-next-line no-await-in-loop -- Validate each generated page sequentially for clear diagnostics.
      const page = await loader();
      assert.ok(page.html.length > 100, `Expected non-empty HTML for ${item.slug}`);
      for (const anchor of page.html.matchAll(/class="heading-anchor" href="([^"]+)"/gu)) {
        assert.ok(
          anchor[1]?.startsWith(`#/docs/${item.slug}#`) === true,
          `Heading left ${item.slug}: ${anchor[1]}`,
        );
      }
      for (const match of page.html.matchAll(/href="#\/docs\/([^"#]+)(?:#[^"]*)?"/gu)) {
        const targetSlug = match[1];
        assert.ok(
          targetSlug !== undefined && slugSet.has(targetSlug),
          `Page "${item.slug}" contains broken internal link to "#/docs/${String(targetSlug)}"`,
        );
      }
    }
  }
});

void test("search index finds guides, public API symbols, and all 43 resultar-check rules", () => {
  const ruleEntries = SEARCH_INDEX.filter((entry) => entry.kind === "rule");
  assert.equal(ruleEntries.length, 43);

  const deferredHits = searchDocs(SEARCH_INDEX, "Deferred");
  assert.ok(deferredHits.length > 0);
  assert.equal(deferredHits[0]?.entry.title, "Deferred");

  const ruleHits = searchDocs(SEARCH_INDEX, "no-discard");
  assert.ok(ruleHits.length > 0);
  assert.equal(ruleHits[0]?.entry.kind, "rule");
  assert.equal(ruleHits[0]?.entry.title, "no-discard");

  const effectHits = searchDocs(SEARCH_INDEX, "Coming from Effect");
  assert.ok(effectHits.length > 0);
  assert.equal(effectHits[0]?.entry.route, "#/docs/coming-from-effect");
});

void test("benchmarks expose the full report in docs and search", async () => {
  const loader = DOC_LOADERS.benchmarks;
  assert.ok(loader);
  const page = await loader();
  assert.equal(page.toc.filter((item) => item.level === 2).length, 12);
  assert.match(page.html, /<th>v5 on<\/th>/u);
  assert.match(page.html, /<th>4\.1\.1 off<\/th>/u);
  assert.ok(
    searchDocs(SEARCH_INDEX, "benchmarks").some(({ entry }) => entry.route === "#/docs/benchmarks"),
  );
});

void test("generated docs contain zero double-escaped ampersands", async () => {
  for (const slug of DOC_SLUGS) {
    const loader = DOC_LOADERS[slug];
    assert.ok(loader !== undefined);
    // eslint-disable-next-line no-await-in-loop -- Inspect each generated page sequentially for clear diagnostics.
    const page = await loader();
    assert.equal(
      page.html.includes("&amp;amp;"),
      false,
      `Generated page "${slug}" contains double-escaped "&amp;amp;"`,
    );
  }

  const overview = await DOC_LOADERS.overview?.();
  assert.ok(overview !== undefined);
  assert.match(overview.html, /logo=nodedotjs&amp;logoColor=white/u);
});

void test("renderInline escapes HTML once and neutralizes unsafe URLs", () => {
  const sourceFile = resolve(import.meta.dirname, "../../README.md");

  const badge = renderInline(
    "[![Node & JS](https://img.shields.io/badge/node-24?logo=nodedotjs&logoColor=white)](https://example.com/?a=1&b=2)",
    sourceFile,
  );
  assert.equal(badge.includes("&amp;amp;"), false);
  assert.match(
    badge,
    /src="https:\/\/img\.shields\.io\/badge\/node-24\?logo=nodedotjs&amp;logoColor=white"/u,
  );
  assert.match(badge, /alt="Node &amp; JS"/u);
  assert.match(badge, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/u);

  const xssLink = renderInline(
    '[click <script>alert(1)</script>](javascript:alert%281%29) and [ok](https://example.com/"onclick="x&y=1<z>)',
    sourceFile,
  );
  assert.doesNotMatch(xssLink, /javascript:/iu);
  assert.match(xssLink, /<a href="#">click &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/u);
  assert.match(xssLink, /href="https:\/\/example\.com\/&quot;onclick=&quot;x&amp;y=1&lt;z&gt;"/u);

  const xssImg = renderInline(
    '![alt "x" <b>](JaVaScRiPt:alert(1)) ![data](data:image/svg+xml,<svg/>)',
    sourceFile,
  );
  assert.doesNotMatch(xssImg, /javascript:/iu);
  assert.doesNotMatch(xssImg, /data:image/iu);
  assert.match(xssImg, /<img src="" alt="alt &quot;x&quot; &lt;b&gt;" loading="lazy" \/>/u);
});

void test("renderMarkdown supports H5 and H6 headings cleanly", () => {
  const sourceFile = resolve(import.meta.dirname, "../../README.md");
  const md = [
    "Paragraph before heading.",
    "##### Level Five & Details",
    "- List item",
    "###### Level Six",
    "After level six.",
  ].join("\n");
  const rendered = renderMarkdown(md, sourceFile);
  assert.match(
    rendered.html,
    /<h5 id="level-five-details"><a class="heading-anchor" href="#\/docs\/overview#level-five-details" aria-label="Link to section">#<\/a>Level Five &amp; Details<\/h5>/u,
  );
  assert.match(
    rendered.html,
    /<h6 id="level-six"><a class="heading-anchor" href="#\/docs\/overview#level-six" aria-label="Link to section">#<\/a>Level Six<\/h6>/u,
  );
  assert.match(rendered.html, /<ul><li>List item<\/li><\/ul>\n<h6 id="level-six">/u);
  assert.match(rendered.html, /<p>Paragraph before heading\.<\/p>\n<h5 id="level-five-details">/u);
});

void test("isPlaygroundCandidate rejects non-runnable pseudocode and accepts self-contained snippets", () => {
  assert.equal(
    isPlaygroundCandidate(
      `import { matchError } from "resultar";\ndeclare const err: Error;\nconsole.log(matchError, err);\n// line 4`,
      "ts",
    ),
    false,
  );
  assert.equal(
    isPlaygroundCandidate(
      `import { ResultAsync } from "resultar";\nconst r = ResultAsync.ok(1);\nconsole.log(r);\n// line 4`,
      "ts",
    ),
    false,
  );
  assert.equal(
    isPlaygroundCandidate(
      `import { ok } from "resultar";\n// ...\nconst x = ok(1);\nconsole.log(x);`,
      "ts",
    ),
    false,
  );
  assert.equal(
    isPlaygroundCandidate(
      `import { ok } from "resultar";\nconst x = ok(1);\nexport default x;\n// line 4`,
      "ts",
    ),
    false,
  );
  assert.equal(
    isPlaygroundCandidate(
      `import { ResultTask, ResultTaskScope } from "resultar";\nconst make = (scope: ResultTaskScope) => ResultTask.ok(scope);\nconsole.log(typeof make);\n// line 4`,
      "ts",
    ),
    true,
  );
});

void test("every generated data-play snippet executes cleanly in the playground", async () => {
  let snippetCount = 0;
  let sawFindCauseDocSnippet = false;

  for (const slug of DOC_SLUGS) {
    const loader = DOC_LOADERS[slug];
    assert.ok(loader !== undefined);
    // eslint-disable-next-line no-await-in-loop -- Validate each page sequentially for deterministic diagnostics.
    const page = await loader();
    let idx = 0;
    for (const match of page.html.matchAll(/data-play="([^"]+)"/gu)) {
      idx += 1;
      snippetCount += 1;
      const encoded = match[1];
      assert.ok(encoded !== undefined);
      const code = Buffer.from(encoded, "base64").toString("utf8");
      if (slug === "full-reference" && code.includes("findCause(error, Error)")) {
        sawFindCauseDocSnippet = true;
      }
      // eslint-disable-next-line no-await-in-loop -- Execute each snippet sequentially for clean error attribution.
      const result = await executePlaygroundInContext(code, resultar);
      assert.equal(
        result.ok,
        true,
        `Generated playground snippet ${slug} #${String(idx)} failed: ${result.error ?? "unknown error"}\nCode:\n${code}`,
      );
    }
  }

  assert.ok(
    snippetCount >= 30,
    `Expected at least 30 runnable doc snippets, got ${String(snippetCount)}`,
  );
  assert.equal(
    sawFindCauseDocSnippet,
    true,
    "Expected DOCUMENTATION.md findCause snippet to be runnable in the playground",
  );
});
