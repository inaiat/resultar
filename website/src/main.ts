import "./styles.css";

import {
  DOC_LOADERS,
  DOC_TITLES,
  NAV_SECTIONS,
  SEARCH_INDEX,
  SITE_META,
  type DocPage,
} from "./generated/site-data.js";
import {
  highlightTs,
  renderBenchmarkShowcase,
  renderBottomCta,
  renderInteroperabilityShowcase,
  type BenchTab,
  type CompareTab,
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

const state = {
  installTab: "pnpm" as "pnpm" | "npm" | "jsr",
  benchTab: "ecosystem" as BenchTab,
  compareTab: "http" as CompareTab,
  theme: "dark" as "dark" | "light",
  sidebarOpen: false,
  searchOpen: false,
  searchQuery: "",
  searchSelected: 0,
  playgroundCode: PLAYGROUND_PRESETS[0]?.code ?? "",
  playgroundPresetId: PLAYGROUND_PRESETS[0]?.id ?? "result-errors",
  playgroundResult: undefined as PlaygroundRunResult | undefined,
  playgroundRunning: false,
  playgroundLoadedFromShare: false,
  playgroundRunSeq: 0,
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

const encodeBase64Utf8 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
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

const renderTopbar = (route: Route): string => {
  const isDocs = route.view === "docs";
  const isPlay = route.view === "playground";
  return `
    <header class="topbar">
      <div class="topbar-left">
        ${
          isDocs
            ? `<button class="icon-btn mobile-menu-btn" type="button" data-action="toggle-sidebar" aria-controls="docs-sidebar" aria-expanded="${String(state.sidebarOpen)}" aria-label="Toggle navigation">☰</button>`
            : ""
        }
        <a class="brand" href="#/">
          <span class="brand-mark">R</span>
          <span>Resultar</span>
          <span class="version-pill">v${escapeHtml(SITE_META.version)}</span>
        </a>
        <nav class="nav-links" aria-label="Main navigation">
          <a class="nav-link ${isDocs && !route.slug.startsWith("packages/") && route.slug !== "resultar-check" && route.slug !== "api-inventory" && route.slug !== "benchmarks" ? "active" : ""}" href="#/docs/quickstart">Docs</a>
          <a class="nav-link ${isDocs && route.slug.startsWith("packages/") ? "active" : ""}" href="#/docs/packages/di">Packages</a>
          <a class="nav-link ${isDocs && route.slug === "api-inventory" ? "active" : ""}" href="#/docs/api-inventory">API</a>
          <a class="nav-link ${isDocs && route.slug === "benchmarks" ? "active" : ""}" href="#/docs/benchmarks">Benchmarks</a>
          <a class="nav-link ${isDocs && route.slug === "resultar-check" ? "active" : ""}" href="#/docs/resultar-check">resultar-check</a>
          <a class="nav-link nav-link-play ${isPlay ? "active" : ""}" href="#/playground">▶ Playground</a>
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
  const heroSnippet = `import { ResultTask } from "resultar";

const checkOrder = ResultTask.fn(function* (quantity: number) {
  const stock = yield* ResultTask.ok(4);
  if (quantity > stock) {
    return yield* ResultTask.err("InsufficientStock" as const);
  }
  return quantity;
});

const order = await checkOrder(5).runResult();
console.log(order.match({
  ok: (quantity) => \`Ready: \${quantity}\`,
  err: (reason) => reason,
})); // InsufficientStock`;

  const encodedHero = encodeBase64Utf8(heroSnippet);
  const installCmd = INSTALL_COMMANDS[state.installTab];
  const installTabs = SITE_META.version.includes("-")
    ? (["pnpm", "npm"] as const)
    : (["pnpm", "npm", "jsr"] as const);

  return `
    <main class="home">
      <section class="hero">
        <div>
          <div class="hero-eyebrow">Resultar v${escapeHtml(SITE_META.version)} · Fastify · Hono · NestJS · Zod · TypeBox</div>
          <h1>Typed errors &amp; lazy tasks for the stack you already use.</h1>
          <p class="hero-sub">
            Start with a <code>~5.9 kB</code> <code>Result&lt;T, E&gt;</code>. Scale to lazy
            <code>ResultTask&lt;A, E, R&gt;</code>, CSP-safe scoped DI, your own schema library, and
            ${SITE_META.ruleCount} native TypeScript-Go checks — with standard <code>Promise</code> boundaries.
          </p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#/docs/quickstart">Get Started</a>
            <a class="btn" href="#/playground">▶ Interactive Playground</a>
            <a class="btn" href="#/docs/benchmarks">Benchmarks</a>
          </div>
          <div class="install-box">
            <div class="install-tabs">
              ${installTabs
                .map(
                  (tab) =>
                    `<button type="button" class="install-tab ${state.installTab === tab ? "active" : ""}" data-install-tab="${tab}">${tab}</button>`,
                )
                .join("")}
            </div>
            <span class="install-cmd">${escapeHtml(installCmd)}</span>
            <button type="button" class="code-btn" data-copy-raw="${escapeHtml(installCmd)}">Copy</button>
          </div>
        </div>
        <div class="code-block">
          <div class="code-header">
            <span>workflow.ts</span>
            <div class="code-actions">
              <button class="code-btn code-btn-play" type="button" data-play="${encodedHero}">▶ Try Live</button>
            </div>
          </div>
          <pre><code>${highlightTs(heroSnippet)}</code></pre>
        </div>
      </section>

      <section class="metrics-strip">
        <a class="metric-card" href="#/docs/core-guide">
          <div class="metric-val">~5.9 kB</div>
          <div class="metric-label"><code>resultar/result</code> gzipped · 0 deps · tree-shakeable</div>
        </a>
        <a class="metric-card" href="#/docs/packages/fastify">
          <div class="metric-val">95%+ raw</div>
          <div class="metric-label">Fastify, Hono &amp; NestJS DI · 100% CSP-safe plans</div>
        </a>
        <a class="metric-card" href="#/docs/benchmarks">
          <div class="metric-val">66.4k req/s</div>
          <div class="metric-label">Real HTTP + Mongo + Redis + BullMQ · <code>35.6k</code> redirects</div>
        </a>
        <a class="metric-card" href="#/docs/resultar-check">
          <div class="metric-val">140 ms</div>
          <div class="metric-label">${SITE_META.ruleCount} native Go rules · 120 files · <code>--fix</code> &amp; LSP</div>
        </a>
      </section>

      ${renderInteroperabilityShowcase(state.compareTab)}

      ${renderBenchmarkShowcase(state.benchTab)}

      <div class="home-section-label">Built for Day-One Simplicity &amp; Production Scale</div>
      <section class="feature-grid">
        <a class="feature-card" href="#/docs/core-guide">
          <span class="feature-tag">CORE ERGONOMICS</span>
          <h3>Result, ResultTask &amp; Tagged Errors</h3>
          <p>Real Error subclasses with <code>$var</code> interpolation, redaction, exhaustive <code>Match</code>, <code>runSync</code>, error-aware <code>Retry.policy</code>, and ~100% core mutation coverage.</p>
        </a>
        <a class="feature-card" href="#/docs/packages/di">
          <span class="feature-tag">INTEROPERABLE DI</span>
          <h3>One Module Across Any Framework</h3>
          <p>Register <code>value</code>, <code>singleton</code>, <code>scoped</code>, and <code>resource</code> services once and run them in Fastify, Hono, NestJS, workers, or scripts.</p>
        </a>
        <a class="feature-card" href="#/playground?preset=concurrency">
          <span class="feature-tag">CONCURRENCY</span>
          <h3>Ref, Deferred, Queue &amp; Fibers</h3>
          <p>Structured concurrency with bounded FIFO backpressure, interruption-safe waiters, lossless shutdown draining, and <code>task.forkChild().scoped()</code>.</p>
        </a>
        <a class="feature-card" href="#/playground?preset=observability">
          <span class="feature-tag">OBSERVABILITY</span>
          <h3>Zero-Overhead TaskLocal &amp; Tracer</h3>
          <p>Fiber-inherited ambient context, opt-in <code>TaskTracer</code> / <code>Tracer.memory()</code>, <code>withSpan</code>, named <code>ResultTask.fn</code>, and span traces on <code>Cause</code>.</p>
        </a>
        <a class="feature-card" href="#/docs/resultar-check">
          <span class="feature-tag">STATIC ANALYSIS &amp; LSP</span>
          <h3>Native TypeScript-Go Checker</h3>
          <p>Catch unhandled results, accidental <code>await task</code>, and leaked scopes in 140 ms — with <code>--fix</code> and live Zed, VS Code &amp; Cursor LSP support.</p>
        </a>
        <a class="feature-card" href="#/docs/agents/skill">
          <span class="feature-tag">CODING AGENTS</span>
          <h3>Version-Matched Agent Guides</h3>
          <p>Ships <code>dist/agent/SKILL.md</code> and <code>dist/llms.txt</code> directly inside <code>node_modules/resultar</code>, verified by executable agent evals.</p>
        </a>
      </section>

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
      <nav id="docs-sidebar" class="sidebar ${state.sidebarOpen ? "open" : ""}" aria-label="Documentation">
        ${NAV_SECTIONS.map(
          (section) => `
            <div class="sidebar-group">
              <div class="sidebar-group-title">${escapeHtml(section.group)}</div>
              ${section.items
                .map(
                  (item) =>
                    `<a class="sidebar-link ${item.slug === page.slug ? "active" : ""}" ${item.slug === page.slug ? 'aria-current="page"' : ""} href="#/docs/${escapeHtml(item.slug)}">${escapeHtml(item.title)}</a>`,
                )
                .join("")}
            </div>
          `,
        ).join("")}
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

      <div class="pg-presets" role="tablist" aria-label="Playground presets">
        ${PLAYGROUND_PRESETS.map(
          (preset) => `
            <button
              type="button"
              class="preset-btn ${state.playgroundPresetId === preset.id ? "active" : ""}"
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
            <span>Imports from "resultar" work directly</span>
          </div>
          <textarea
            id="pg-editor"
            class="pg-editor"
            spellcheck="false"
            aria-label="TypeScript playground editor"
          >${escapeHtml(state.playgroundCode)}</textarea>
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
  const results = searchDocs(SEARCH_INDEX, state.searchQuery, 16);
  const clampedIdx = Math.min(state.searchSelected, Math.max(0, results.length - 1));
  state.searchSelected = clampedIdx;

  return results.length === 0
    ? `<div style="padding:20px;text-align:center;color:var(--text-dim)">No results for "${escapeHtml(state.searchQuery)}"</div>`
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

const renderSearchModal = (): string => {
  if (!state.searchOpen) return "";
  return `
    <div class="modal-backdrop" data-action="close-search-backdrop">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Search documentation">
        <div class="modal-input-row">
          <span style="color:var(--text-dim)">⌕</span>
          <input
            id="search-input"
            class="modal-input"
            type="text"
            value="${escapeHtml(state.searchQuery)}"
            placeholder="Search guides, API symbols (Deferred, TaskLocal…), or ${SITE_META.ruleCount} rules…"
            autocomplete="off"
          />
          <span class="kbd">ESC</span>
        </div>
        <div class="modal-results">
          ${renderSearchResults()}
        </div>
      </div>
    </div>
  `;
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
    state.playgroundCode = route.code;
    state.playgroundPresetId = "custom";
    state.playgroundResult = undefined;
    state.playgroundLoadedFromShare = true;
    return;
  }
  state.playgroundLoadedFromShare = false;
  if (route.presetId !== undefined) {
    const preset = PLAYGROUND_PRESETS.find((item) => item.id === route.presetId);
    if (preset !== undefined) {
      state.playgroundPresetId = preset.id;
      state.playgroundCode = preset.code;
      state.playgroundResult = undefined;
    }
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
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
};

const render = (): void => {
  const root = document.querySelector("#app");
  if (root === null) return;
  const route = parseHashRoute();

  let mainContent = "";
  if (route.view === "home") {
    mainContent = renderHome();
  } else if (route.view === "playground") {
    mainContent = renderPlayground();
  } else {
    const page = pageCache.get(route.slug);
    if (page === undefined) {
      mainContent = `<main class="doc-main"><p style="color:var(--text-muted)">Loading documentation…</p></main>`;
      void loadDocPage(route.slug).then(() => {
        render();
        scrollToAnchor(route.anchor);
      });
    } else {
      mainContent = renderDocs(page);
    }
  }

  root.innerHTML = `${renderTopbar(route)}${mainContent}${renderSearchModal()}`;

  if (state.searchOpen) {
    const input = document.querySelector("#search-input");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  const editor = document.querySelector("#pg-editor");
  if (editor instanceof HTMLTextAreaElement) {
    editor.addEventListener("input", () => {
      state.playgroundCode = editor.value;
    });
    editor.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void executePlayground();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
        editor.selectionStart = start + 2;
        editor.selectionEnd = start + 2;
        state.playgroundCode = editor.value;
      }
    });
  }
};

const openSearch = (): void => {
  state.searchOpen = true;
  state.searchSelected = 0;
  render();
};

const closeSearch = (): void => {
  if (!state.searchOpen) return;
  state.searchOpen = false;
  render();
};

document.addEventListener("click", (event: MouseEvent) => {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return;

  const actionEl = target.closest<HTMLElement>("[data-action]");
  const action = actionEl?.dataset.action;

  if (action === "open-search") {
    openSearch();
    return;
  }
  if (action === "close-search-backdrop" && target === actionEl) {
    closeSearch();
    return;
  }
  if (action === "toggle-theme") {
    toggleTheme();
    return;
  }
  if (action === "toggle-sidebar") {
    state.sidebarOpen = !state.sidebarOpen;
    render();
    return;
  }
  if (action === "pg-run") {
    void executePlayground();
    return;
  }
  if (action === "pg-reset") {
    const preset =
      PLAYGROUND_PRESETS.find((item) => item.id === state.playgroundPresetId) ??
      PLAYGROUND_PRESETS[0];
    if (preset !== undefined) {
      state.playgroundRunSeq += 1;
      state.playgroundRunning = false;
      state.playgroundLoadedFromShare = false;
      state.playgroundCode = preset.code;
      state.playgroundResult = undefined;
      render();
    }
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
    }
    return;
  }

  const benchBtn = target.closest<HTMLElement>("[data-bench-tab]");
  if (benchBtn?.dataset.benchTab !== undefined) {
    const tab = benchBtn.dataset.benchTab;
    if (tab === "adapters" || tab === "core" || tab === "ecosystem") {
      state.benchTab = tab;
      render();
      document
        .querySelector<HTMLButtonElement>(`[data-bench-tab="${tab}"]`)
        ?.focus({ preventScroll: true });
    }
    return;
  }

  const compareBtn = target.closest<HTMLElement>("[data-compare-tab]");
  if (compareBtn?.dataset.compareTab !== undefined) {
    const tab = compareBtn.dataset.compareTab;
    if (tab === "http" || tab === "schemas" || tab === "progressive") {
      state.compareTab = tab;
      render();
    }
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
    state.searchOpen = false;
  }
  if (target.closest(".sidebar-link") !== null) {
    state.sidebarOpen = false;
  }
});

document.addEventListener("input", (event: Event) => {
  const { target } = event;
  if (target instanceof HTMLInputElement && target.id === "search-input") {
    state.searchQuery = target.value;
    state.searchSelected = 0;
    const results = document.querySelector(".modal-results");
    if (results !== null) results.innerHTML = renderSearchResults();
  }
});

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.searchOpen) closeSearch();
    else openSearch();
    return;
  }
  if (
    event.key === "/" &&
    !state.searchOpen &&
    !(document.activeElement instanceof HTMLInputElement) &&
    !(document.activeElement instanceof HTMLTextAreaElement)
  ) {
    event.preventDefault();
    openSearch();
    return;
  }
  if (!state.searchOpen) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    return;
  }
  const results = searchDocs(SEARCH_INDEX, state.searchQuery, 16);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.searchSelected = Math.min(results.length - 1, state.searchSelected + 1);
    render();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.searchSelected = Math.max(0, state.searchSelected - 1);
    render();
  } else if (event.key === "Enter" && results[state.searchSelected] !== undefined) {
    event.preventDefault();
    const chosen = results[state.searchSelected];
    state.searchOpen = false;
    if (chosen !== undefined) {
      globalThis.location.hash = chosen.entry.route;
    }
    render();
  }
});

globalThis.addEventListener("hashchange", () => {
  const route = parseHashRoute();
  state.sidebarOpen = false;
  syncPlaygroundFromRoute(route);
  render();
  if (route.view === "docs") {
    scrollToAnchor(route.anchor);
  }
});

initTheme();
const initialRoute = parseHashRoute();
syncPlaygroundFromRoute(initialRoute);
render();
if (initialRoute.view === "docs") {
  scrollToAnchor(initialRoute.anchor);
}
