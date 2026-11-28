import "./styles.css";

import {
  DOC_LOADERS,
  DOC_TITLES,
  NAV_SECTIONS,
  type SearchEntry,
  SITE_META,
  type DocPage,
} from "./generated/site-data.js";
import {
  encodeBase64Utf8,
  HERO_RESULTAR_SNIPPET,
  highlightTs,
  renderAiShowcase,
  renderBenchmarkShowcase,
  renderBottomCta,
  renderHeroShowcase,
  renderInteroperabilityShowcase,
  type AiTab,
  type BenchTab,
  type Framework,
  type HeroTab,
  type Schema,
} from "./home-sections.js";
import type { PlaygroundRunResult } from "./playground-runner.js";
import { PLAYGROUND_PRESETS } from "./presets.js";
import { searchDocs } from "./search.js";

type Route =
  | { readonly view: "home" }
  | { readonly view: "docs"; readonly slug: string; readonly anchor?: string }
  | { readonly view: "playground"; readonly presetId?: string; readonly code?: string };

const ALL_ORDERED_SLUGS: readonly string[] = NAV_SECTIONS.flatMap((section) =>
  section.items.map((item) => item.slug),
);

const INSTALL_COMMANDS: Readonly<Record<"pnpm" | "npm" | "jsr", string>> = {
  pnpm: `pnpm add resultar@${SITE_META.version}`,
  npm: `npm install resultar@${SITE_META.version}`,
  jsr: `npx jsr add @inaiat/resultar@${SITE_META.version}`,
};

const homeTitle = document.title;
const searchDialog = document.querySelector<HTMLDialogElement>("#doc-search");
if (!searchDialog) throw new Error("Missing search dialog");
let searchIndex: readonly SearchEntry[] | undefined = undefined;

const state = {
  installTab: "pnpm" as "pnpm" | "npm" | "jsr",
  heroTab: "resultar" as HeroTab,
  heroRunning: false,
  heroResult: undefined as PlaygroundRunResult | undefined,
  aiTab: "agents-md" as AiTab,
  benchTab: "ecosystem" as BenchTab,
  framework: "Fastify" as Framework,
  schema: "TypeBox" as Schema,
  theme: "dark" as "dark" | "light",
  sidebarOpen: false,
  searchQuery: "",
  searchSelected: 0,
  playgroundCode: PLAYGROUND_PRESETS[0]?.code ?? "",
  playgroundPresetId: PLAYGROUND_PRESETS[0]?.id ?? "result-errors",
  playgroundResult: undefined as PlaygroundRunResult | undefined,
  playgroundRunning: false,
  playgroundLoadedFromShare: false,
  playgroundRunSeq: 0,
  playgroundOriginalCode: PLAYGROUND_PRESETS[0]?.code ?? "",
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const decodeBase64Utf8 = (encoded: string): string => {
  const bytes = Uint8Array.from(atob(encoded), (char) => char.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
};

const pageCache = new Map<string, DocPage>();

const loadDocPage = async (slug: string): Promise<DocPage | undefined> => {
  const cached = pageCache.get(slug);
  if (cached !== undefined) return cached;
  const loader = DOC_LOADERS[slug] ?? DOC_LOADERS.overview;
  if (loader === undefined) return undefined;
  const loaded = await loader();
  pageCache.set(loaded.slug, loaded);
  return loaded;
};

const parseHashRoute = (): Route => {
  const raw = globalThis.location.hash.replace(/^#\/?/u, "");
  if (raw.length === 0) {
    return { view: "home" };
  }
  if (raw.startsWith("playground")) {
    const queryIdx = raw.indexOf("?");
    if (queryIdx !== -1) {
      const params = new URLSearchParams(raw.slice(queryIdx + 1));
      const encoded = params.get("code");
      if (encoded !== null) {
        try {
          return { view: "playground", code: decodeBase64Utf8(encoded) };
        } catch {
          // Fall back to default preset when hash payload is malformed.
        }
      }
      const preset = params.get("preset") ?? undefined;
      return preset === undefined
        ? { view: "playground" }
        : { view: "playground", presetId: preset };
    }
    return { view: "playground" };
  }
  if (raw.startsWith("docs/")) {
    const rest = raw.slice("docs/".length);
    const hashIdx = rest.indexOf("#");
    const slug = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
    const anchor = hashIdx === -1 ? undefined : rest.slice(hashIdx + 1);
    const resolvedSlug = DOC_LOADERS[slug] === undefined ? "overview" : slug;
    return anchor === undefined
      ? { view: "docs", slug: resolvedSlug }
      : { view: "docs", slug: resolvedSlug, anchor };
  }
  return { view: "home" };
};

const initTheme = (): void => {
  const stored = globalThis.localStorage.getItem("resultar-theme");
  if (stored === "light" || stored === "dark") {
    state.theme = stored;
  } else if (globalThis.matchMedia("(prefers-color-scheme: light)").matches) {
    state.theme = "light";
  }
  document.documentElement.dataset.theme = state.theme;
};

const toggleTheme = (): void => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  globalThis.localStorage.setItem("resultar-theme", state.theme);
  render();
};

const renderDocLinks = (slug: string): string =>
  NAV_SECTIONS.map(
    (section) => `
            <div class="sidebar-group">
              <div class="sidebar-group-title">${escapeHtml(section.group)}</div>
              ${section.items
                .map(
                  (item) =>
                    `<a class="sidebar-link ${item.slug === slug ? "active" : ""}" ${item.slug === slug ? 'aria-current="page"' : ""} href="#/docs/${escapeHtml(item.slug)}">${escapeHtml(item.title)}</a>`,
                )
                .join("")}
            </div>
          `,
  ).join("");

const renderTopbar = (route: Route): string => {
  const isDocs = route.view === "docs";
  const isPlay = route.view === "playground";
  return `
    <header class="topbar">
      <div class="topbar-left">
        <button class="icon-btn mobile-menu-btn" type="button" data-action="toggle-sidebar" aria-controls="site-menu" aria-expanded="${String(state.sidebarOpen)}" aria-label="Toggle navigation">☰</button>
        <a class="brand" href="#/">
          <span class="brand-mark">R</span>
          <span>Resultar</span>
          <span class="version-pill">v${escapeHtml(SITE_META.version)}</span>
        </a>
        <nav id="site-menu" class="nav-links ${state.sidebarOpen ? "open" : ""}" aria-label="Main navigation">
          <a class="nav-link ${isDocs && !route.slug.startsWith("packages/") && !route.slug.startsWith("agents/") && route.slug !== "resultar-check" && route.slug !== "api-inventory" && !route.slug.startsWith("benchmarks") ? "active" : ""}" href="#/docs/quickstart">Docs</a>
          <a class="nav-link ${isDocs && route.slug.startsWith("packages/") ? "active" : ""}" href="#/docs/packages/di">Packages</a>
          <a class="nav-link ${isDocs && route.slug === "api-inventory" ? "active" : ""}" href="#/docs/api-inventory">API</a>
          <a class="nav-link ${isDocs && route.slug.startsWith("benchmarks") ? "active" : ""}" href="#/docs/benchmarks/url-shortener">Benchmarks</a>
          <a class="nav-link ${isDocs && route.slug === "resultar-check" ? "active" : ""}" href="#/docs/resultar-check">resultar-check</a>
          <a class="nav-link ${isDocs && route.slug.startsWith("agents/") ? "active" : ""}" href="#/docs/agents/setup" title="AI &amp; Coding Agents">AI</a>
          <a class="nav-link nav-link-play ${isPlay ? "active" : ""}" href="#/playground">▶ Playground</a>
          ${isDocs && state.sidebarOpen ? `<div class="mobile-doc-links">${renderDocLinks(route.slug)}</div>` : ""}
        </nav>
      </div>
      <div class="topbar-right">
        <button class="search-trigger" type="button" data-action="open-search">
          <span>Search<span class="search-detail"> docs, API &amp; rules…</span></span>
          <span class="kbd">⌘K</span>
        </button>
        <button class="icon-btn" type="button" data-action="toggle-theme" title="Toggle theme" aria-label="Toggle theme">
          ${state.theme === "dark" ? "☀" : "☾"}
        </button>
        <a class="icon-btn" href="https://github.com/inaiat/resultar" target="_blank" rel="noopener noreferrer" title="GitHub" aria-label="GitHub">GH</a>
      </div>
    </header>
  `;
};

const renderHome = (): string => {
  const resultSnippet = `import { ok, err, type Result } from "resultar";

type Stock = Result<number, "OutOfStock">;

const reserveOne = (left: number): Stock =>
  left > 0 ? ok(left - 1) : err("OutOfStock");

const reservePair = (left: number) =>
  reserveOne(left).andThen(reserveOne);

console.log(reservePair(2));
console.log(reservePair(1));`;

  const installCmd = INSTALL_COMMANDS[state.installTab];
  const installTabs = SITE_META.version.includes("-")
    ? (["pnpm", "npm"] as const)
    : (["pnpm", "npm", "jsr"] as const);
  let heroRunPreview: {
    readonly running: boolean;
    readonly ok?: boolean;
    readonly durationMs?: number;
    readonly output?: string;
  } = { running: false };
  if (state.heroRunning) {
    heroRunPreview = { running: true };
  } else if (state.heroResult !== undefined) {
    const joinedLogs = state.heroResult.logs.map((entry) => entry.text).join(" · ");
    heroRunPreview = {
      running: false,
      ok: state.heroResult.ok,
      durationMs: state.heroResult.durationMs,
      output: joinedLogs.length > 0 ? joinedLogs : (state.heroResult.error ?? "Completed"),
    };
  }

  return `
    <main class="home">
      <section class="hero" aria-labelledby="home-title">
        <div class="hero-grid">
          <div class="hero-intro">
            <div class="hero-eyebrow">
              <span>Resultar v${escapeHtml(SITE_META.version)}</span>
              <span aria-hidden="true">·</span>
              <span>Sync <code>Result</code> + Lazy <code>ResultTask</code></span>
            </div>
            <h1 id="home-title">Stop guessing what throws. <em>Put every failure in the return type.</em></h1>
            <p class="hero-sub">
              TypeScript signatures hide <code>throw</code> and rejected promises. Start with a
              <code>~5.9 kB</code> <code>Result&lt;T, E&gt;</code>, compose lazy
              <code>ResultTask</code> workflows with <code>yield*</code>, and handle every failure
              exhaustively at your native <code>Promise</code> boundary.
            </p>
            <div class="hero-tools">
              <div class="hero-actions">
                <a class="btn btn-primary" href="#/docs/quickstart">Start in 2 minutes →</a>
                <a class="btn" href="#/playground">▶ Open Playground</a>
                <a class="home-text-link" href="#/docs/gradual-adoption">Gradual adoption</a>
              </div>
              <div class="install-box" role="group" aria-label="Install the core package">
                <div class="install-tabs">
                  ${installTabs
                    .map(
                      (tab) =>
                        `<button type="button" class="install-tab ${state.installTab === tab ? "active" : ""}" aria-pressed="${String(state.installTab === tab)}" data-install-tab="${tab}">${tab}</button>`,
                    )
                    .join("")}
                </div>
                <span class="install-cmd">${escapeHtml(installCmd)}</span>
                <button type="button" class="code-btn" data-copy-raw="${escapeHtml(installCmd)}">Copy</button>
              </div>
            </div>
            <ul class="hero-proof" aria-label="Key highlights">
              <li><strong>~5.9 kB</strong> 0-dep core</li>
              <li><strong>Native Promise</strong> <code>.runResult()</code></li>
              <li><strong>${String(SITE_META.ruleCount)}</strong> TypeScript-Go rules</li>
              <li><strong>1.25×</strong> Effect HTTP req/s</li>
            </ul>
          </div>
          ${renderHeroShowcase(state.heroTab, heroRunPreview)}
        </div>
      </section>

      <section class="adoption-section" aria-labelledby="adoption-heading">
        <header class="section-head">
          <div>
            <h2 id="adoption-heading">Adopt one function at a time</h2>
            <p class="section-sub">Two core primitives, zero global runtime lock-in. Stop at whichever stage solves your problem.</p>
          </div>
        </header>
        <div class="adoption-grid">
          <article>
            <code>Stage 1 · Result&lt;T, E&gt;</code>
            <h3>One synchronous function</h3>
            <p>Replace hidden throws or <code>null</code> checks in parsers and domain rules. Chain steps with <code>andThen</code> or <code>Result.gen</code> with zero async overhead.</p>
            <a href="#/playground?code=${encodeURIComponent(encodeBase64Utf8(resultSnippet))}">Try this in Playground →</a>
          </article>
          <article>
            <code>Stage 2 · ResultTask&lt;T, E&gt;</code>
            <h3>Lazy async workflows</h3>
            <p>Combine sync <code>Result</code> and async <code>tryPromise</code> with <code>yield*</code>, retries, and timeouts. Run at the edge with <code>await task.runResult()</code> for a native <code>Promise&lt;Result&gt;</code>.</p>
            <a href="#/docs/async-workflow">Compose a workflow →</a>
          </article>
          <article>
            <code>Stage 3 · ResultTask&lt;T, E, R&gt;</code>
            <h3>Typed services &amp; scopes</h3>
            <p>Track required dependencies and LIFO resource cleanup in <code>R</code>. Supply real drivers in Fastify, Hono, or NestJS and swap test fakes at the boundary.</p>
            <a href="#/docs/packages/di#testing-with-overrides">Provide and test services →</a>
          </article>
        </div>
      </section>

      ${renderInteroperabilityShowcase(state.framework, state.schema)}

      ${renderAiShowcase(state.aiTab, SITE_META.ruleCount)}

      ${renderBenchmarkShowcase(state.benchTab)}

      ${renderBottomCta()}
    </main>
  `;
};

const renderDocs = (page: DocPage): string => {
  const index = ALL_ORDERED_SLUGS.indexOf(page.slug);
  const prevSlug = index > 0 ? ALL_ORDERED_SLUGS[index - 1] : undefined;
  const nextSlug =
    index !== -1 && index + 1 < ALL_ORDERED_SLUGS.length ? ALL_ORDERED_SLUGS[index + 1] : undefined;
  const prevTitle = prevSlug === undefined ? undefined : DOC_TITLES[prevSlug];
  const nextTitle = nextSlug === undefined ? undefined : DOC_TITLES[nextSlug];
  const sectionLinks = page.toc
    .map(
      (item) =>
        `<a class="toc-link depth-${item.level}" href="#/docs/${escapeHtml(page.slug)}#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`,
    )
    .join("");

  return `
    <div class="docs-layout">
      <nav id="docs-sidebar" class="sidebar" aria-label="Documentation">
        ${renderDocLinks(page.slug)}
      </nav>
      <main class="doc-main">
        <div class="doc-meta">
          <span>${escapeHtml(page.group)} / ${escapeHtml(page.title)}</span>
          <a href="https://github.com/inaiat/resultar/blob/main/${escapeHtml(page.source)}" target="_blank" rel="noopener noreferrer">Source: ${escapeHtml(page.source)}</a>
        </div>
        ${sectionLinks && `<details class="compact-toc"><summary>On this page</summary><nav aria-label="Sections">${sectionLinks}</nav></details>`}
        <article class="doc-prose">${page.html}</article>
        <nav class="doc-pager" aria-label="Pagination">
          ${
            prevSlug !== undefined && prevTitle !== undefined
              ? `<a class="pager-card" href="#/docs/${escapeHtml(prevSlug)}"><span class="pager-label">← Previous</span><span class="pager-title">${escapeHtml(prevTitle)}</span></a>`
              : "<div></div>"
          }
          ${
            nextSlug !== undefined && nextTitle !== undefined
              ? `<a class="pager-card next" href="#/docs/${escapeHtml(nextSlug)}"><span class="pager-label">Next →</span><span class="pager-title">${escapeHtml(nextTitle)}</span></a>`
              : "<div></div>"
          }
        </nav>
      </main>
      <aside class="toc" aria-label="On this page">
        <div class="toc-title">On This Page</div>
        ${sectionLinks || '<span class="toc-link">Top of page</span>'}
      </aside>
    </div>
  `;
};

const renderWaterfall = (result: PlaygroundRunResult): string => {
  const validSpans = result.spans.filter((span) => Number.isFinite(span.startTime));
  if (validSpans.length === 0) return "";
  const minStart = Math.min(...validSpans.map((span) => span.startTime));
  const maxEnd = Math.max(
    ...validSpans.map((span) => {
      if (span.endTime !== undefined && Number.isFinite(span.endTime)) return span.endTime;
      const fallbackDur =
        span.durationMs !== undefined && Number.isFinite(span.durationMs)
          ? Math.max(0, span.durationMs)
          : 1;
      return span.startTime + fallbackDur;
    }),
  );
  const rawRange = maxEnd - minStart;
  const totalRange = Number.isFinite(rawRange) && rawRange > 0 ? Math.max(1, rawRange) : 1;

  return `
    <div class="waterfall">
      <div class="waterfall-title">Span Waterfall (${validSpans.length} spans)</div>
      ${validSpans
        .map((span) => {
          const rawLeftPct = ((span.startTime - minStart) / totalRange) * 100;
          const leftPct = Number.isFinite(rawLeftPct) ? Math.min(100, Math.max(0, rawLeftPct)) : 0;
          const computedDur =
            span.durationMs !== undefined && Number.isFinite(span.durationMs)
              ? span.durationMs
              : (span.endTime !== undefined && Number.isFinite(span.endTime)
                  ? span.endTime
                  : span.startTime) - span.startTime;
          const dur = Number.isFinite(computedDur) ? Math.max(0, computedDur) : 0;
          const rawWidthPct = (dur / totalRange) * 100;
          const widthPct = Number.isFinite(rawWidthPct) ? Math.max(3, rawWidthPct) : 3;
          const failed = span.exit?._tag === "Failure";
          const attrs = Object.entries(span.attributes)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ");
          return `
            <div class="span-row" title="${escapeHtml(attrs || span.name)}">
              <div class="span-name ${span.parentName === undefined ? "" : "span-child"}">
                ${span.parentName === undefined ? "" : "↳ "}${escapeHtml(span.name)}
              </div>
              <div class="span-track">
                <div class="span-bar ${failed ? "failed" : ""}" style="left:${leftPct.toFixed(1)}%;width:${Math.min(100 - leftPct, widthPct).toFixed(1)}%"></div>
              </div>
              <div class="span-dur">${dur.toFixed(1)}ms</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
};

const logClassForLevel = (level: "log" | "info" | "warn" | "error"): string => {
  if (level === "error") return "pg-log-error";
  if (level === "warn") return "pg-log-warn";
  return "";
};

const renderPlaygroundHighlight = (code: string): string =>
  highlightTs(code.endsWith("\n") ? `${code} ` : code);

const renderPlayground = (): string => {
  const result = state.playgroundResult;
  let outputBody = state.playgroundLoadedFromShare
    ? `<div class="pg-log">Shared snippet loaded from URL. Review the code and click <strong>Run</strong> (or press <code>⌘/Ctrl+Enter</code>) to execute it in an isolated sandbox.</div>`
    : `<div class="pg-log">Click <strong>Run</strong> (or press <code>⌘/Ctrl+Enter</code>) to execute live Resultar code in an isolated browser sandbox.</div>`;

  if (state.playgroundRunning) {
    outputBody = `<div class="pg-log">Executing…</div>`;
  } else if (result !== undefined) {
    const logLines = result.logs
      .map(
        (entry) =>
          `<div class="pg-log ${logClassForLevel(entry.level)}">${escapeHtml(entry.text)}</div>`,
      )
      .join("");
    const errLine =
      result.error === undefined
        ? ""
        : `<div class="pg-log pg-log-error">${escapeHtml(result.error)}</div>`;
    outputBody =
      (logLines || (errLine ? "" : `<div class="pg-log">Completed with no console output.</div>`)) +
      errLine +
      renderWaterfall(result);
  }

  let statusClass = "";
  let statusText = "Ready";
  if (result !== undefined) {
    statusClass = result.ok ? "pg-status-ok" : "pg-status-err";
    statusText = result.ok
      ? `✓ Passed in ${result.durationMs.toFixed(1)}ms`
      : `✗ Error (${result.durationMs.toFixed(1)}ms)`;
  }

  return `
    <main class="playground">
      <div class="pg-header">
        <div>
          <h1 style="margin:0;font-size:22px">Resultar Interactive Playground</h1>
          <div style="font-size:13px;color:var(--text-muted)">Runs the real bundled <code>resultar</code> v${escapeHtml(SITE_META.version)} runtime locally in your browser.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" type="button" data-action="pg-run">▶ Run (⌘↵)</button>
          <button class="btn" type="button" data-action="pg-share">Share URL</button>
          <button class="btn" type="button" data-action="pg-reset">Reset</button>
        </div>
      </div>

      <div class="pg-presets" role="group" aria-label="Playground presets">
        ${PLAYGROUND_PRESETS.map(
          (preset) => `
            <button
              type="button"
              class="preset-btn ${state.playgroundPresetId === preset.id ? "active" : ""}"
              aria-pressed="${String(state.playgroundPresetId === preset.id)}"
              data-preset="${escapeHtml(preset.id)}"
              title="${escapeHtml(preset.description)}"
            >
              <span>${escapeHtml(preset.title)}</span>
              <span class="preset-badge">${escapeHtml(preset.badge)}</span>
            </button>
          `,
        ).join("")}
      </div>

      <div class="pg-grid">
        <div class="pg-pane">
          <div class="pg-pane-head">
            <span>playground.ts</span>
            <span id="pg-editor-help">Tab indents · Esc focuses Run</span>
          </div>
          <div class="pg-editor-wrap">
            <pre id="pg-highlight" class="pg-highlight" aria-hidden="true"><code>${renderPlaygroundHighlight(state.playgroundCode)}</code></pre>
            <textarea
              id="pg-editor"
              class="pg-editor"
              spellcheck="false"
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
              wrap="off"
              aria-describedby="pg-editor-help"
              aria-label="TypeScript playground editor"
            >${escapeHtml(state.playgroundCode)}</textarea>
          </div>
        </div>
        <div class="pg-pane">
          <div class="pg-pane-head">
            <span>Output</span>
            <span class="${statusClass}">${statusText}</span>
          </div>
          <div class="pg-output">${outputBody}</div>
        </div>
      </div>
    </main>
  `;
};

const renderSearchResults = (): string => {
  if (!searchIndex) return '<p class="search-message" role="status">Loading search…</p>';
  const results = searchDocs(searchIndex ?? [], state.searchQuery, 16);
  const clampedIdx = Math.min(state.searchSelected, Math.max(0, results.length - 1));
  state.searchSelected = clampedIdx;

  return results.length === 0
    ? `<div class="search-message" role="status">No results for "${escapeHtml(state.searchQuery)}"</div>`
    : results
        .map(
          ({ entry }, idx) => `
                      <a
                        class="search-item ${idx === clampedIdx ? "selected" : ""}"
                        href="${escapeHtml(entry.route)}"
                        data-search-idx="${idx}"
                      >
                        <div class="search-item-head">
                          <span class="search-badge ${entry.kind}">${entry.kind}</span>
                          <strong>${escapeHtml(entry.title)}</strong>
                        </div>
                        <div class="search-item-sub">${escapeHtml(entry.subtitle)}</div>
                        <div class="search-item-excerpt">${escapeHtml(entry.excerpt)}</div>
                      </a>
                    `,
        )
        .join("");
};

const executePlayground = async (): Promise<void> => {
  const editor = document.querySelector("#pg-editor");
  const code = editor instanceof HTMLTextAreaElement ? editor.value : state.playgroundCode;
  state.playgroundCode = code;
  const seq = state.playgroundRunSeq + 1;
  state.playgroundRunSeq = seq;
  state.playgroundRunning = true;
  state.playgroundLoadedFromShare = false;
  render();
  const { runPlaygroundCode } = await import("./playground-runner.js");
  if (state.playgroundRunSeq !== seq) return;
  const result = await runPlaygroundCode(code);
  if (state.playgroundRunSeq !== seq) return;
  state.playgroundResult = result;
  state.playgroundRunning = false;
  render();
};

const syncPlaygroundFromRoute = (route: Route): void => {
  if (route.view !== "playground") return;
  state.playgroundRunSeq += 1;
  state.playgroundRunning = false;
  if (route.code !== undefined) {
    state.playgroundOriginalCode = route.code;
    state.playgroundCode = route.code;
    state.playgroundPresetId = "custom";
    state.playgroundResult = undefined;
    state.playgroundLoadedFromShare = true;
    return;
  }
  state.playgroundLoadedFromShare = false;
  const preset = PLAYGROUND_PRESETS.find((item) => item.id === route.presetId);
  if (preset) {
    state.playgroundPresetId = preset.id;
    state.playgroundOriginalCode = preset.code;
    state.playgroundCode = preset.code;
    state.playgroundResult = undefined;
  }
};

const scrollToAnchor = (anchor: string | undefined): void => {
  if (anchor === undefined || anchor.length === 0) {
    globalThis.scrollTo({ top: 0 });
    return;
  }
  globalThis.requestAnimationFrame(() => {
    const target = document.querySelector(`#${CSS.escape(anchor)}`);
    if (target !== null) {
      target.classList.add("anchor-target");
      target.scrollIntoView({ block: "start" });
    }
  });
};

const render = (): void => {
  const root = document.querySelector("#app");
  if (root === null) return;
  const route = parseHashRoute();

  let mainContent = "";
  if (route.view === "home") {
    document.title = homeTitle;
    mainContent = renderHome();
  } else if (route.view === "playground") {
    document.title = "Playground · Resultar";
    mainContent = renderPlayground();
  } else {
    document.title = `${DOC_TITLES[route.slug]} · Resultar`;
    const page = pageCache.get(route.slug);
    if (page === undefined) {
      mainContent = `<main class="doc-main"><p style="color:var(--text-muted)">Loading documentation…</p></main>`;
      void loadDocPage(route.slug).then(() => {
        const current = parseHashRoute();
        if (current.view === "docs" && current.slug === route.slug) {
          render();
          scrollToAnchor(current.anchor);
        }
      });
    } else {
      mainContent = renderDocs(page);
    }
  }

  root.innerHTML = `${renderTopbar(route)}${mainContent}`;

  const editor = document.querySelector("#pg-editor");
  const highlight = document.querySelector("#pg-highlight");
  const highlightCode = highlight?.querySelector("code");
  if (editor instanceof HTMLTextAreaElement) {
    const syncHighlightScroll = (): void => {
      if (highlight instanceof HTMLElement) {
        highlight.scrollTop = editor.scrollTop;
        highlight.scrollLeft = editor.scrollLeft;
      }
    };
    const syncHighlight = (): void => {
      if (highlightCode instanceof HTMLElement) {
        highlightCode.innerHTML = renderPlaygroundHighlight(editor.value);
      }
      syncHighlightScroll();
    };
    editor.addEventListener("scroll", syncHighlightScroll);
    editor.addEventListener("input", () => {
      state.playgroundCode = editor.value;
      syncHighlight();
    });
    editor.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void executePlayground();
        return;
      }
      if (event.key === "Escape") {
        document.querySelector<HTMLButtonElement>('[data-action="pg-run"]')?.focus();
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
        editor.selectionStart = start + 2;
        editor.selectionEnd = start + 2;
        state.playgroundCode = editor.value;
        syncHighlight();
      }
    });
    syncHighlightScroll();
  }
};

const updateSearchResults = (): void => {
  const results = searchDialog.querySelector(".modal-results");
  if (results) results.innerHTML = renderSearchResults();
};

const openSearch = async (): Promise<void> => {
  state.searchSelected = 0;
  updateSearchResults();
  searchDialog.showModal();
  searchDialog.querySelector<HTMLInputElement>("input")?.focus();
  if (!searchIndex) {
    try {
      const { SEARCH_INDEX } = await import("./generated/search-index.js");
      searchIndex = SEARCH_INDEX;
      if (searchDialog.open) updateSearchResults();
    } catch {
      const results = searchDialog.querySelector(".modal-results");
      if (results) results.textContent = "Search could not load. Reopen it to try again.";
    }
  }
};

const toggleMenu = (): void => {
  state.sidebarOpen = !state.sidebarOpen;
  render();
  document.querySelector<HTMLButtonElement>(".mobile-menu-btn")?.focus({ preventScroll: true });
};

document.addEventListener("click", (event: MouseEvent) => {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return;

  const actionEl = target.closest<HTMLElement>("[data-action]");
  const action = actionEl?.dataset.action;

  if (action === "open-search") {
    void openSearch();
    return;
  }
  if (target === searchDialog || action === "close-search") {
    searchDialog.close();
    return;
  }
  if (action === "toggle-theme") {
    toggleTheme();
    return;
  }
  if (action === "toggle-sidebar") {
    toggleMenu();
    return;
  }
  if (action === "pg-run") {
    void executePlayground();
    return;
  }
  if (action === "hero-run") {
    if (state.heroRunning) return;
    state.heroTab = "resultar";
    state.heroRunning = true;
    render();
    void import("./playground-runner.js").then(async ({ runPlaygroundCode }) => {
      state.heroResult = await runPlaygroundCode(HERO_RESULTAR_SNIPPET);
      state.heroRunning = false;
      render();
      document
        .querySelector<HTMLButtonElement>('[data-action="hero-run"]')
        ?.focus({ preventScroll: true });
    });
    return;
  }
  if (action === "pg-reset") {
    state.playgroundRunSeq += 1;
    state.playgroundRunning = false;
    state.playgroundResult = undefined;
    state.playgroundLoadedFromShare = state.playgroundPresetId === "custom";
    state.playgroundCode = state.playgroundOriginalCode;
    render();
    document
      .querySelector<HTMLButtonElement>('[data-action="pg-reset"]')
      ?.focus({ preventScroll: true });
    return;
  }
  if (action === "pg-share") {
    const encoded = encodeURIComponent(encodeBase64Utf8(state.playgroundCode));
    const shareUrl = `${globalThis.location.origin}${globalThis.location.pathname}#/playground?code=${encoded}`;
    void navigator.clipboard?.writeText(shareUrl);
    if (actionEl !== null) {
      actionEl.textContent = "Copied link!";
      setTimeout(() => {
        actionEl.textContent = "Share URL";
      }, 1500);
    }
    return;
  }

  const installBtn = target.closest<HTMLElement>("[data-install-tab]");
  if (installBtn?.dataset.installTab !== undefined) {
    const tab = installBtn.dataset.installTab;
    if (tab === "pnpm" || tab === "npm" || tab === "jsr") {
      state.installTab = tab;
      render();
      document
        .querySelector<HTMLButtonElement>(`[data-install-tab="${tab}"]`)
        ?.focus({ preventScroll: true });
    }
    return;
  }

  const heroBtn = target.closest<HTMLElement>("[data-hero-tab]");
  if (heroBtn?.dataset.heroTab !== undefined) {
    const tab = heroBtn.dataset.heroTab;
    if (tab === "resultar" || tab === "throw") {
      state.heroTab = tab;
      render();
      document
        .querySelector<HTMLButtonElement>(`[data-hero-tab="${tab}"]`)
        ?.focus({ preventScroll: true });
    }
    return;
  }

  const aiBtn = target.closest<HTMLElement>("[data-ai-tab]");
  if (aiBtn?.dataset.aiTab !== undefined) {
    const tab = aiBtn.dataset.aiTab;
    if (tab === "agents-md" || tab === "cursor" || tab === "cli") {
      state.aiTab = tab;
      render();
      document
        .querySelector<HTMLButtonElement>(`[data-ai-tab="${tab}"]`)
        ?.focus({ preventScroll: true });
    }
    return;
  }

  const benchBtn = target.closest<HTMLElement>("[data-bench-tab]");
  if (benchBtn?.dataset.benchTab !== undefined) {
    const tab = benchBtn.dataset.benchTab;
    if (tab === "adapters" || tab === "core" || tab === "ecosystem" || tab === "create") {
      state.benchTab = tab;
      render();
      document
        .querySelector<HTMLButtonElement>(`[data-bench-tab="${tab}"]`)
        ?.focus({ preventScroll: true });
    }
    return;
  }

  const framework = target.closest<HTMLElement>("[data-framework]")?.dataset.framework;
  const schema = target.closest<HTMLElement>("[data-schema]")?.dataset.schema;
  if (schema === "Zod" || schema === "TypeBox" || schema === "Type guard") {
    state.schema = schema;
  } else if (framework === "Fastify" || framework === "Hono" || framework === "NestJS") {
    state.framework = framework;
  }
  const stack = target.closest<HTMLElement>(".service-showcase");
  if (stack && (schema !== undefined || framework !== undefined)) {
    const expanded = stack.querySelector("details")?.open ?? false;
    stack.outerHTML = renderInteroperabilityShowcase(state.framework, state.schema, expanded);
    document
      .querySelector<HTMLButtonElement>(
        schema === undefined
          ? `[data-framework="${state.framework}"]`
          : `[data-schema="${state.schema}"]`,
      )
      ?.focus({ preventScroll: true });
    return;
  }

  const presetBtn = target.closest<HTMLElement>("[data-preset]");
  if (presetBtn?.dataset.preset !== undefined) {
    const preset = PLAYGROUND_PRESETS.find((item) => item.id === presetBtn.dataset.preset);
    if (preset !== undefined) {
      state.playgroundRunSeq += 1;
      state.playgroundRunning = false;
      state.playgroundLoadedFromShare = false;
      state.playgroundPresetId = preset.id;
      state.playgroundCode = preset.code;
      state.playgroundResult = undefined;
      const targetHash = `#/playground?preset=${preset.id}`;
      if (globalThis.location.hash === targetHash) {
        render();
      } else {
        globalThis.location.hash = targetHash;
      }
    }
    return;
  }

  const copyBtn = target.closest<HTMLElement>("[data-copy], [data-copy-raw]");
  if (copyBtn !== null) {
    const raw =
      copyBtn.dataset.copyRaw ??
      (copyBtn.dataset.copy === undefined ? "" : decodeBase64Utf8(copyBtn.dataset.copy));
    void navigator.clipboard?.writeText(raw);
    const prev = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.textContent = prev;
    }, 1400);
    return;
  }

  const playBtn = target.closest<HTMLElement>("[data-play]");
  if (playBtn?.dataset.play !== undefined) {
    const targetHash = `#/playground?code=${encodeURIComponent(playBtn.dataset.play)}`;
    if (globalThis.location.hash === targetHash) {
      syncPlaygroundFromRoute(parseHashRoute());
      render();
    } else {
      globalThis.location.hash = targetHash;
    }
    return;
  }

  if (target.closest(".search-item") !== null) {
    searchDialog.close();
  }
  if (state.sidebarOpen && target.closest("#site-menu a") !== null) {
    toggleMenu();
  }
});

document.addEventListener("input", (event: Event) => {
  const { target } = event;
  if (target instanceof HTMLInputElement && target.id === "search-input") {
    state.searchQuery = target.value;
    state.searchSelected = 0;
    updateSearchResults();
  }
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (searchDialog.open) searchDialog.close();
    else void openSearch();
    return;
  }
  if (
    event.key === "/" &&
    !searchDialog.open &&
    !(document.activeElement instanceof HTMLInputElement) &&
    !(document.activeElement instanceof HTMLTextAreaElement)
  ) {
    event.preventDefault();
    void openSearch();
    return;
  }
  if (!searchDialog.open) {
    if (event.key === "Escape" && state.sidebarOpen) toggleMenu();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    searchDialog.close();
    return;
  }
  if (event.key === "Tab") {
    const controls = [...searchDialog.querySelectorAll<HTMLElement>("input, button, a[href]")];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }
  if (!(event.target instanceof HTMLInputElement)) return;
  const links = searchDialog.querySelectorAll<HTMLAnchorElement>(".search-item");
  if (links.length === 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    links[state.searchSelected]?.classList.remove("selected");
    const delta = event.key === "ArrowDown" ? 1 : -1;
    state.searchSelected = Math.max(0, Math.min(links.length - 1, state.searchSelected + delta));
    const selected = links[state.searchSelected];
    selected?.classList.add("selected");
    selected?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    links[state.searchSelected]?.click();
  }
});

globalThis.addEventListener("hashchange", () => {
  const route = parseHashRoute();
  state.sidebarOpen = false;
  if (searchDialog.open) searchDialog.close();
  syncPlaygroundFromRoute(route);
  render();
  scrollToAnchor(route.view === "docs" ? route.anchor : undefined);
});

initTheme();
const initialRoute = parseHashRoute();
syncPlaygroundFromRoute(initialRoute);
render();
if (initialRoute.view === "docs") {
  scrollToAnchor(initialRoute.anchor);
}
