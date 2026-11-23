import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { build as viteBuild } from "vite-plus";

const scriptsDir = import.meta.dirname;
const websiteDir = resolve(scriptsDir, "..");
const repoRoot = resolve(websiteDir, "..");

const pkgManifest = JSON.parse(
  readFileSync(join(repoRoot, "packages/resultar/package.json"), "utf8"),
);
const version = pkgManifest.version ?? "4.0.0";

const SECTIONS = [
  {
    group: "Getting Started",
    pages: [
      { slug: "overview", title: "Overview & Quickstart", source: "README.md" },
      { slug: "core-guide", title: "Core Package Guide", source: "packages/resultar/README.md" },
      {
        slug: "coming-from-effect",
        title: "Coming from Effect",
        source: "docs/coming-from-effect.md",
      },
      { slug: "gradual-adoption", title: "Gradual Adoption", source: "docs/gradual-adoption.md" },
      { slug: "v5-migration", title: "v5 Migration Guide", source: "docs/migrations/v5.md" },
      { slug: "v4-migration", title: "v4 Migration Guide", source: "docs/migrations/v4.md" },
    ],
  },
  {
    group: "Reference",
    pages: [
      { slug: "full-reference", title: "Complete Guide", source: "DOCUMENTATION.md" },
      { slug: "recipes", title: "Executable Recipes", source: "docs/recipes.md" },
      { slug: "api-inventory", title: "Public API Inventory", source: "docs/api-inventory.md" },
      {
        slug: "benchmarks",
        title: "Benchmarks",
        source: "benchmarks/results/2026-11-22.md",
      },
    ],
  },
  {
    group: "Tooling & Editors",
    pages: [
      {
        slug: "resultar-check",
        title: "resultar-check CLI & LSP",
        source: "packages/check/README.md",
      },
      {
        slug: "vscode-extension",
        title: "VS Code & Cursor Extension",
        source: "editors/vscode/README.md",
      },
    ],
  },
  {
    group: "Ecosystem Packages",
    pages: [
      { slug: "packages/app", title: "resultar-app", source: "packages/app/README.md" },
      { slug: "packages/di", title: "resultar-di", source: "packages/di/README.md" },
      { slug: "packages/config", title: "resultar-config", source: "packages/config/README.md" },
      { slug: "packages/hono", title: "resultar-hono", source: "packages/hono/README.md" },
      { slug: "packages/fastify", title: "resultar-fastify", source: "packages/fastify/README.md" },
      { slug: "packages/nestjs", title: "resultar-nestjs", source: "packages/nestjs/README.md" },
      { slug: "packages/request", title: "resultar-request", source: "packages/request/README.md" },
      {
        slug: "packages/request-zod",
        title: "resultar-request-zod",
        source: "packages/request-zod/README.md",
      },
      {
        slug: "packages/request-typebox",
        title: "resultar-request-typebox",
        source: "packages/request-typebox/README.md",
      },
    ],
  },
  {
    group: "Coding Agents",
    pages: [
      { slug: "agents/skill", title: "Agent Skill (SKILL.md)", source: "skills/resultar/SKILL.md" },
      { slug: "agents/api", title: "API Semantics", source: "skills/resultar/references/api.md" },
      {
        slug: "agents/anti-patterns",
        title: "Anti-Patterns & Rules",
        source: "skills/resultar/references/anti-patterns.md",
      },
      {
        slug: "agents/patterns",
        title: "Production Patterns",
        source: "skills/resultar/references/patterns.md",
      },
      {
        slug: "agents/services",
        title: "Services & HTTP",
        source: "skills/resultar/references/services.md",
      },
      {
        slug: "agents/integrations",
        title: "Integrations",
        source: "skills/resultar/references/integrations.md",
      },
      {
        slug: "agents/review-checklist",
        title: "Review Checklist",
        source: "skills/resultar/references/review-checklist.md",
      },
    ],
  },
  {
    group: "Architecture & RFCs",
    pages: [
      { slug: "rfcs/index", title: "RFC Index", source: "docs/rfcs/README.md" },
      {
        slug: "rfcs/0010",
        title: "RFC 0010: DX, Concurrency & Tooling",
        source: "docs/rfcs/rfc-0010-dx-observability-concurrency-and-tooling.md",
      },
    ],
  },
];

const ALL_PAGES = SECTIONS.flatMap((section) =>
  section.pages.map((page) => ({ ...page, group: section.group })),
);

const slugByAbsPath = new Map(ALL_PAGES.map((page) => [resolve(repoRoot, page.source), page.slug]));

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const slugify = (text) =>
  text
    .toLowerCase()
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replaceAll(/\s+/g, "-");

const stripMarkdown = (text) =>
  text
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/`([^`]+)`/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/[*_~>#|]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const stripFrontmatter = (source) => {
  if (!source.startsWith("---\n")) return source;
  const end = source.indexOf("\n---\n", 4);
  return end === -1 ? source : source.slice(end + 5);
};

const highlightTs = (code) => {
  const tokens = [];
  const pattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:import|export|from|type|interface|class|extends|implements|const|let|var|function|return|if|else|for|while|switch|case|default|break|continue|async|await|yield|new|throw|try|catch|finally|readonly|as|satisfies|typeof|keyof|in|of|void|true|false|null|undefined)\b|\b(?:Result|ResultTask|ResultAsync|Match|Cause|Exit|Fiber|Semaphore|Ref|Deferred|Queue|TaskLocal|Tracer|Retry|Clock|Scheduler|Service|AbortError|Promise|Error|Map|Set|Array|Record|Readonly|string|number|boolean|never|unknown)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g;

  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push(escapeHtml(code.slice(last, index)));
    }
    const text = match[0];
    const escaped = escapeHtml(text);
    if (text.startsWith("//") || text.startsWith("/*")) {
      tokens.push(`<span class="tok-com">${escaped}</span>`);
    } else if (text.startsWith("'") || text.startsWith('"') || text.startsWith("`")) {
      tokens.push(`<span class="tok-str">${escaped}</span>`);
    } else if (/^\d/.test(text)) {
      tokens.push(`<span class="tok-num">${escaped}</span>`);
    } else if (/^[A-Z]/.test(text) || /^(?:string|number|boolean|never|unknown)$/.test(text)) {
      tokens.push(`<span class="tok-type">${escaped}</span>`);
    } else {
      tokens.push(`<span class="tok-kw">${escaped}</span>`);
    }
    last = index + text.length;
  }
  if (last < code.length) {
    tokens.push(escapeHtml(code.slice(last)));
  }
  return tokens.join("");
};

const highlightJson = (code) =>
  escapeHtml(code)
    .replaceAll(
      /(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)/g,
      '<span class="tok-type">$1</span>$2',
    )
    .replaceAll(
      /(:\s*)(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)/g,
      '$1<span class="tok-str">$2</span>',
    )
    .replaceAll(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>')
    .replaceAll(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');

const highlightCode = (code, lang) => {
  const normalized = (lang || "").toLowerCase();
  if (["ts", "tsx", "mts", "js", "jsx", "mjs", "typescript", "javascript"].includes(normalized)) {
    return highlightTs(code);
  }
  if (normalized === "json" || normalized === "jsonc") {
    return highlightJson(code);
  }
  return escapeHtml(code);
};

const isPlaygroundCandidate = (code, lang) => {
  const normalized = (lang || "").toLowerCase();
  if (!["ts", "tsx", "mts", "typescript"].includes(normalized)) return false;
  if (!/from\s+["']resultar(?:\/[a-z]+)?["']/.test(code)) return false;
  if (/from\s+["'](?:node:|resultar-|hono|fastify|@nestjs|zod|typebox|\.)/.test(code)) return false;
  return code.split("\n").length >= 4 && code.split("\n").length <= 90;
};

const resolveLink = (href, sourceFileAbs) => {
  if (/^(?:https?:|mailto:)/i.test(href)) {
    // Rewrite GitHub main links back to internal docs routes when they point to an indexed page.
    const ghPrefix = "https://github.com/inaiat/resultar/blob/main/";
    if (href.startsWith(ghPrefix)) {
      const rest = href.slice(ghPrefix.length);
      const [filePart, anchor] = rest.split("#");
      const abs = resolve(repoRoot, filePart);
      const targetSlug = slugByAbsPath.get(abs);
      if (targetSlug !== undefined) {
        return `#/docs/${targetSlug}${anchor ? `#${anchor}` : ""}`;
      }
    }
    return href;
  }
  if (href.startsWith("#")) {
    const slug = slugByAbsPath.get(sourceFileAbs);
    return slug === undefined || href.startsWith("#/") ? href : `#/docs/${slug}${href}`;
  }
  const [pathPart, anchor] = href.split("#");
  const abs = resolve(dirname(sourceFileAbs), pathPart);
  const targetSlug = slugByAbsPath.get(abs);
  if (targetSlug !== undefined) {
    return `#/docs/${targetSlug}${anchor ? `#${anchor}` : ""}`;
  }
  if (!existsSync(abs)) {
    throw new Error(
      `Broken relative documentation link in ${relative(repoRoot, sourceFileAbs)}: ${href}`,
    );
  }
  const rel = relative(repoRoot, abs).split(sep).join("/");
  return `https://github.com/inaiat/resultar/blob/main/${rel}${anchor ? `#${anchor}` : ""}`;
};

const renderInline = (text, sourceFileAbs) => {
  const codeSpans = [];
  let output = text.replaceAll(/`([^`]+)`/g, (_match, inner) => {
    const id = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(inner)}</code>`);
    return `\u0000CODE${id}\u0000`;
  });

  // Escape raw HTML except explicit <br> tags used inside tables.
  output = output
    .replaceAll("<br>", "\u0000BR\u0000")
    .replaceAll("<br/>", "\u0000BR\u0000")
    .replaceAll("<br />", "\u0000BR\u0000");
  output = escapeHtml(output).replaceAll("\u0000BR\u0000", "<br>");

  // Images: ![alt](src)
  output = output.replaceAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    const safeSrc = escapeHtml(src);
    return `<img src="${safeSrc}" alt="${escapeHtml(alt)}" loading="lazy" />`;
  });

  // Links: [label](href)
  output = output.replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    const resolved = resolveLink(href, sourceFileAbs);
    const isExternal = /^https?:/i.test(resolved);
    const extra = isExternal ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(resolved)}"${extra}>${label}</a>`;
  });

  // Bold, italic, strikethrough
  output = output.replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replaceAll(/~~([^~]+)~~/g, "<del>$1</del>");
  output = output.replaceAll(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");

  output = output.replaceAll(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? "");
  return output;
};

const splitTableRow = (line) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
};

const renderMarkdown = (rawMarkdown, sourceFileAbs) => {
  const markdown = stripFrontmatter(rawMarkdown).replaceAll("\r\n", "\n");
  const lines = markdown.split("\n");
  const html = [];
  const toc = [];
  const sections = [];
  const usedIds = new Map();

  let currentSection = { heading: "", anchor: "", text: [] };
  const flushSection = () => {
    if (currentSection.heading || currentSection.text.length > 0) {
      sections.push({
        heading: currentSection.heading,
        anchor: currentSection.anchor,
        excerpt: stripMarkdown(currentSection.text.join(" ")).slice(0, 260),
      });
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code blocks
    const fenceMatch = /^(`{3,})([a-zA-Z0-9_-]*)/.exec(line.trim());
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || "text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const codeText = codeLines.join("\n");
      const highlighted = highlightCode(codeText, lang);
      const encoded = Buffer.from(codeText, "utf8").toString("base64");
      const playgroundBtn = isPlaygroundCandidate(codeText, lang)
        ? `<button class="code-btn code-btn-play" type="button" data-play="${encoded}" title="Run in Playground">▶ Playground</button>`
        : "";
      html.push(
        `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(lang)}</span><div class="code-actions">${playgroundBtn}<button class="code-btn code-btn-copy" type="button" data-copy="${encoded}">Copy</button></div></div><pre><code class="lang-${escapeHtml(lang)}">${highlighted}</code></pre></div>`,
      );
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawHeading = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
      const baseSlug = slugify(rawHeading) || `section-${toc.length + 1}`;
      const seen = usedIds.get(baseSlug) ?? 0;
      usedIds.set(baseSlug, seen + 1);
      const id = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;

      if (level === 2 || level === 3) {
        flushSection();
        const plainTitle = stripMarkdown(rawHeading);
        toc.push({ level, id, text: plainTitle });
        currentSection = { heading: plainTitle, anchor: id, text: [] };
      }

      html.push(
        `<h${level} id="${escapeHtml(id)}"><a class="heading-anchor" href="${escapeHtml(resolveLink(`#${id}`, sourceFileAbs))}" aria-label="Link to section">#</a>${renderInline(rawHeading, sourceFileAbs)}</h${level}>`,
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      html.push("<hr />");
      i++;
      continue;
    }

    // Blockquote / callout
    if (line.trimStart().startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      currentSection.text.push(quoteLines.join(" "));
      html.push(
        `<blockquote class="callout">${renderInline(quoteLines.join(" "), sourceFileAbs)}</blockquote>`,
      );
      continue;
    }

    // GFM Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().length > 0 && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInline(h, sourceFileAbs)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (row) =>
            `<tr>${headers.map((_, col) => `<td>${renderInline(row[col] ?? "", sourceFileAbs)}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody>`;
      html.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // Unordered or ordered lists
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
        let itemText = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
        i++;
        while (
          i < lines.length &&
          lines[i].trim().length > 0 &&
          !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i]) &&
          !/^(?:#{1,4}\s|```|>|---|\*{3})/.test(lines[i].trim())
        ) {
          itemText += ` ${lines[i].trim()}`;
          i++;
        }
        currentSection.text.push(itemText);
        items.push(`<li>${renderInline(itemText, sourceFileAbs)}</li>`);
      }
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !/^(?:#{1,4}\s|```|>|---|\*{3}|\s*(?:[-*+]|\d+\.)\s+)/.test(lines[i])
    ) {
      if (
        lines[i].includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        break;
      }
      paraLines.push(lines[i].trim());
      i++;
    }
    const paraText = paraLines.join(" ");
    currentSection.text.push(paraText);
    html.push(`<p>${renderInline(paraText, sourceFileAbs)}</p>`);
  }

  flushSection();
  return { html: html.join("\n"), toc, sections };
};

// Build docs pages and unified search index.
const docsPages = {};
const searchIndex = [];

for (const page of ALL_PAGES) {
  const absPath = resolve(repoRoot, page.source);
  const raw = readFileSync(absPath, "utf8");
  const { html, toc, sections } = renderMarkdown(raw, absPath);

  docsPages[page.slug] = {
    slug: page.slug,
    title: page.title,
    group: page.group,
    source: page.source,
    html,
    toc,
  };

  searchIndex.push({
    kind: "guide",
    title: page.title,
    subtitle: page.group,
    route: `#/docs/${page.slug}`,
    keywords: `${page.title} ${page.group} ${page.source}`,
    excerpt: sections[0]?.excerpt ?? page.title,
  });

  for (const section of sections) {
    if (!section.heading) continue;
    searchIndex.push({
      kind: "section",
      title: section.heading,
      subtitle: `${page.group} · ${page.title}`,
      route: `#/docs/${page.slug}#${section.anchor}`,
      keywords: `${section.heading} ${page.title} ${section.excerpt}`,
      excerpt: section.excerpt || section.heading,
    });
  }
}

// Parse public API symbols from docs/api-inventory.md into search index.
const inventoryRaw = readFileSync(join(repoRoot, "docs/api-inventory.md"), "utf8");
let currentPkg = "resultar";
const seenSymbols = new Set();
for (const line of inventoryRaw.split("\n")) {
  const pkgMatch = /^##\s+(.+)$/.exec(line);
  if (pkgMatch) {
    currentPkg = pkgMatch[1].trim();
    continue;
  }
  const rowMatch = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line);
  if (!rowMatch) continue;
  const symbol = rowMatch[1].trim();
  const kind = rowMatch[2].trim();
  const members = stripMarkdown(rowMatch[3]).slice(0, 180);
  const key = `${currentPkg}:${symbol}`;
  if (seenSymbols.has(key)) continue;
  seenSymbols.add(key);
  const pkgAnchor = slugify(currentPkg);
  searchIndex.push({
    kind: "api",
    title: symbol,
    subtitle: `${currentPkg} · ${kind}`,
    route: `#/docs/api-inventory#${pkgAnchor}`,
    keywords: `${symbol} ${currentPkg} ${kind} ${members}`,
    excerpt: members === "—" ? `${kind} exported by ${currentPkg}` : members,
  });
}

// Parse all 43 resultar-check rules from packages/check/README.md into search index.
const checkReadme = readFileSync(join(repoRoot, "packages/check/README.md"), "utf8");
let ruleCount = 0;
for (const match of checkReadme.matchAll(
  /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/gm,
)) {
  ruleCount++;
  const [, ruleId, optionName, severity, meaning] = match;
  searchIndex.push({
    kind: "rule",
    title: ruleId,
    subtitle: `resultar-check · default: ${severity}`,
    route: "#/docs/resultar-check#diagnostics",
    keywords: `${ruleId} ${optionName} ${severity} ${meaning}`,
    excerpt: `${optionName} (${severity}): ${stripMarkdown(meaning)}`,
  });
}

const navSections = SECTIONS.map((section) => ({
  group: section.group,
  items: section.pages.map((p) => ({ slug: p.slug, title: p.title })),
}));

const outDir = join(websiteDir, "src/generated");
const pagesDir = join(outDir, "pages");
mkdirSync(pagesDir, { recursive: true });

const safeModuleName = (slug) => slug.replaceAll("/", "__");
const loaderEntries = [];
for (const [slug, page] of Object.entries(docsPages)) {
  const fileName = `${safeModuleName(slug)}.ts`;
  writeFileSync(
    join(pagesDir, fileName),
    `/* eslint-disable */\nimport type { DocPage } from "../site-data.js";\nexport const page: DocPage = ${JSON.stringify(page)};\n`,
    "utf8",
  );
  loaderEntries.push(
    `  ${JSON.stringify(slug)}: async () => (await import("./pages/${safeModuleName(slug)}.js")).page,`,
  );
}

const outputContent = `/* eslint-disable */
// Auto-generated by website/scripts/build-content.mjs — do not edit by hand.

export interface TocItem {
  readonly level: number;
  readonly id: string;
  readonly text: string;
}

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly group: string;
  readonly source: string;
  readonly html: string;
  readonly toc: readonly TocItem[];
}

export interface NavSection {
  readonly group: string;
  readonly items: readonly { readonly slug: string; readonly title: string }[];
}

export interface SearchEntry {
  readonly kind: "guide" | "section" | "api" | "rule";
  readonly title: string;
  readonly subtitle: string;
  readonly route: string;
  readonly keywords: string;
  readonly excerpt: string;
}

export const SITE_META = ${JSON.stringify({ version, ruleCount, pageCount: ALL_PAGES.length })} as const;
export const NAV_SECTIONS: readonly NavSection[] = ${JSON.stringify(navSections)};
export const DOC_SLUGS: readonly string[] = ${JSON.stringify(Object.keys(docsPages))};
export const DOC_TITLES: Readonly<Record<string, string>> = ${JSON.stringify(
  Object.fromEntries(Object.entries(docsPages).map(([slug, p]) => [slug, p.title])),
)};
export const DOC_LOADERS: Readonly<Record<string, () => Promise<DocPage>>> = {
${loaderEntries.join("\n")}
};
export const SEARCH_INDEX: readonly SearchEntry[] = ${JSON.stringify(searchIndex)};
`;

writeFileSync(join(outDir, "site-data.ts"), outputContent, "utf8");

// Bundle the opaque-origin playground sandbox runtime as a self-contained IIFE string
// so sandboxed iframes need zero network or CORS access to the portal origin.
const sandboxBuild = await viteBuild({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: true,
    sourcemap: false,
    lib: {
      entry: resolve(websiteDir, "src/playground-sandbox.ts"),
      formats: ["iife"],
      name: "ResultarPlaygroundSandbox",
      fileName: () => "sandbox.js",
    },
  },
});

const sandboxOutputs = Array.isArray(sandboxBuild) ? sandboxBuild : [sandboxBuild];
let sandboxCode = "";
for (const result of sandboxOutputs) {
  if (result && typeof result === "object" && "output" in result && Array.isArray(result.output)) {
    const chunk = result.output.find((item) => item.type === "chunk");
    if (chunk && typeof chunk.code === "string") {
      sandboxCode = chunk.code;
      break;
    }
  }
}
if (sandboxCode.length === 0) {
  throw new Error("Failed to bundle website/src/playground-sandbox.ts");
}
const sandboxGzip = gzipSync(sandboxCode, { level: 9 });
writeFileSync(
  join(outDir, "sandbox-bundle.ts"),
  `/* eslint-disable */\n// Auto-generated by website/scripts/build-content.mjs — do not edit by hand.\nexport const PLAYGROUND_SANDBOX_GZIP_BASE64: string = "${sandboxGzip.toString("base64")}";\n`,
  "utf8",
);

console.log(
  `Built website docs content: ${ALL_PAGES.length} pages, ${ruleCount} rules, ${searchIndex.length} search entries, sandbox gzip bundle ${(sandboxGzip.length / 1024).toFixed(1)} KiB.`,
);
