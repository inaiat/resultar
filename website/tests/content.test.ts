import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import * as resultar from "../../packages/resultar/dist/index.js";
import { isPlaygroundCandidate, renderInline, renderMarkdown } from "../scripts/build-content.mjs";
import {
  type DocPage,
  DOC_LOADERS,
  DOC_SLUGS,
  NAV_SECTIONS,
  SITE_META,
} from "../src/generated/site-data.js";
import { SEARCH_INDEX } from "../src/generated/search-index.js";
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

  const aiHits = searchDocs(SEARCH_INDEX, "AI & Coding Agents");
  assert.ok(aiHits.length > 0);
  assert.equal(aiHits[0]?.entry.route, "#/docs/agents/setup");

  const llmsHits = searchDocs(SEARCH_INDEX, "llms.txt");
  assert.ok(llmsHits.some(({ entry }) => entry.route === "#/docs/agents/llms"));

  const asyncHits = searchDocs(SEARCH_INDEX, "async workflow");
  assert.equal(
    asyncHits[0]?.entry.route,
    "#/docs/full-reference#asynchronous-workflows-with-resulttask",
  );
  assert.equal(
    asyncHits
      .slice(0, 5)
      .some(
        ({ entry }) =>
          entry.route.startsWith("#/docs/v4-migration") ||
          entry.title.toLowerCase().includes("resultasync") ||
          entry.title.toLowerCase().includes("deprecated"),
      ),
    false,
  );
});

void test("getting-started and gradual-adoption guides stay free of deprecated ResultAsync", async () => {
  for (const slug of ["quickstart", "async-workflow", "failure-boundaries", "gradual-adoption"]) {
    // eslint-disable-next-line no-await-in-loop -- Inspect each onboarding page sequentially for clear diagnostics.
    const page = await DOC_LOADERS[slug]?.();
    assert.ok(page !== undefined, `Missing page ${slug}`);
    assert.equal(
      page.html.includes("ResultAsync"),
      false,
      `Expected onboarding page "${slug}" not to mention deprecated ResultAsync`,
    );
  }

  const adoptionNav = NAV_SECTIONS.find((section) => section.group === "Adoption & Migration");
  assert.ok(adoptionNav !== undefined);
  assert.equal(
    adoptionNav.items.some((item) => item.slug === "v4-migration"),
    false,
    "Historical v4 migration guide must not appear in primary Adoption & Migration nav",
  );

  const overview = await DOC_LOADERS.overview?.();
  assert.ok(overview !== undefined);
  assert.match(overview.html, /class="mermaid-flow"/u);
  assert.equal(overview.html.includes("lang-mermaid"), false);
});

void test("search opens each API export and checker rule at its unique table row", async () => {
  const entries = SEARCH_INDEX.filter(({ kind }) => kind === "api" || kind === "rule");
  assert.equal(new Set(entries.map((entry) => entry.route)).size, entries.length);
  const inventory = await DOC_LOADERS["api-inventory"]?.();
  const checker = await DOC_LOADERS["resultar-check"]?.();
  assert.ok(inventory && checker);
  for (const entry of entries) {
    const page: DocPage = entry.kind === "api" ? inventory : checker;
    const anchor = entry.route.split("#")[2];
    assert.ok(
      page.html.includes(`<tr id="${anchor}"><td><code>${entry.title}</code></td>`),
      entry.route,
    );
  }
  const migration = SEARCH_INDEX.find((entry) => entry.title.startsWith("1. runResult()"));
  assert.equal(migration?.title.includes("Promise<Result<T, E | ScopeError<R>>>"), true);
});

void test("AI coding agents guide and published llms.txt stay in sync", async () => {
  const setupPage = await DOC_LOADERS["agents/setup"]?.();
  assert.ok(setupPage !== undefined);
  assert.match(setupPage.html, /node_modules\/resultar-check\/dist\/agent\/SKILL\.md/u);
  assert.match(setupPage.html, /resultar-check init --editor cursor/u);
  assert.match(setupPage.html, /href="#\/docs\/agents\/llms"/u);

  const llmsPage = await DOC_LOADERS["agents/llms"]?.();
  assert.ok(llmsPage !== undefined);
  assert.match(llmsPage.html, /Installed version first/u);

  const rootLlms = readFileSync(resolve(import.meta.dirname, "../../llms.txt"), "utf8");
  const publicLlms = readFileSync(resolve(import.meta.dirname, "../public/llms.txt"), "utf8");
  assert.equal(publicLlms, rootLlms);
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

void test("published documentation links render as internal routes", () => {
  const sourceFile = resolve(import.meta.dirname, "../../README.md");

  assert.equal(
    renderInline("[Docs](https://inaiat.github.io/resultar/)", sourceFile),
    '<a href="#/">Docs</a>',
  );
  assert.equal(
    renderInline(
      "[Model](https://inaiat.github.io/resultar/#/docs/full-reference#the-model)",
      sourceFile,
    ),
    '<a href="#/docs/full-reference#the-model">Model</a>',
  );
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
      `import { ResultAsync } from "resultar/async";\nconst r = ResultAsync.ok(1);\nconsole.log(r);\n// line 4`,
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
  const tutorialOutputs: Readonly<Record<string, readonly (readonly string[])[]>> = {
    quickstart: [
      ["Reserve 3 items", "Enter a positive whole number", "Enter a positive whole number"],
      ["Ok(750)", 'Err("InvalidQuantity")'],
    ],
    "async-workflow": [
      ["0", "2"],
      ["InvalidQuantity", "InsufficientStock", "Ready: 2", "2"],
    ],
    "failure-boundaries": [
      ["0", "1"],
      ["true", "open → check → close"],
    ],
  };

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
      const expected = tutorialOutputs[slug]?.[idx - 1];
      if (expected !== undefined) {
        assert.deepEqual(
          result.logs.map((log) => log.text),
          expected,
          `${slug} example ${String(idx)}`,
        );
      }
    }
    if (slug in tutorialOutputs) assert.equal(idx, tutorialOutputs[slug]?.length, slug);
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
