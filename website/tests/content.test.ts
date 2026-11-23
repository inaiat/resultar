import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOC_LOADERS,
  DOC_SLUGS,
  NAV_SECTIONS,
  SEARCH_INDEX,
  SITE_META,
} from "../src/generated/site-data.js";
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
