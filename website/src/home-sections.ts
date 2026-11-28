export type BenchTab = "create" | "adapters" | "core" | "ecosystem";
export type Framework = "Fastify" | "Hono" | "NestJS";
export type Schema = "Zod" | "TypeBox" | "Type guard";
export type AiTab = "agents-md" | "cursor" | "cli";
export type HeroTab = "resultar" | "throw";

export const HERO_RESULTAR_SNIPPET = `import { createTaggedError, ok, ResultTask } from "resultar";
import type { Result } from "resultar";

class InvalidAmount extends createTaggedError({
  name: "InvalidAmount",
  message: "Amount $amount must be positive",
}) {}

class CardDeclined extends createTaggedError({
  name: "CardDeclined",
  message: "Card declined ($reason)",
}) {}

const checkAmount = (cents: number): Result<number, InvalidAmount> =>
  cents > 0 ? ok(cents) : InvalidAmount.err({ amount: cents });

const charge = (cents: number, token: string) =>
  ResultTask.gen(function* () {
    const valid = yield* checkAmount(cents);
    if (token === "tok_declined") {
      return yield* CardDeclined.err({ reason: "insufficient_funds" });
    }
    return { charged: valid, status: "paid" as const };
  });

const res = await charge(2500, "tok_declined").runResult();
console.log(
  res.matchTags((receipt) => ({ http: 200, body: receipt }), {
    InvalidAmount: (e) => ({ http: 400, error: e.message }),
    CardDeclined: (e) => ({ http: 402, error: e.message }),
  }),
);`;

const HERO_THROW_SNIPPET = `// Standard TypeScript: the return type promises a receipt,
// while two failure modes hide inside the implementation.

const checkAmount = (cents: number): number => {
  if (cents <= 0) {
    throw new Error(\`Amount \${cents} must be positive\`);
  }
  return cents;
};

const charge = async (cents: number, token: string) => {
  const valid = checkAmount(cents);
  if (token === "tok_declined") {
    throw new Error("Card declined (insufficient_funds)");
  }
  return { charged: valid, status: "paid" as const };
};

// Compiles cleanly with zero error handling — then rejects at runtime:
const receipt = await charge(2500, "tok_declined");
console.log({ http: 200, body: receipt });`;

export const encodeBase64Utf8 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

interface BenchDataset {
  readonly title: string;
  readonly takeaway: string;
  readonly description: string;
  readonly setup: string;
  readonly source: string;
  readonly unit: string;
  readonly axisMax: number;
  readonly result: { readonly label: string; readonly value: number };
  readonly baseline: { readonly label: string; readonly value: number };
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const TS_TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:import|export|from|type|interface|class|extends|implements|const|let|var|function|return|if|else|for|while|switch|case|default|break|continue|async|await|yield|new|throw|try|catch|finally|readonly|as|satisfies|typeof|keyof|in|of|void|true|false|null|undefined)\b|\b(?:Result|StrictResult|ResultTask|StrictResultTask|Hono|Type|Match|Cause|Exit|Fiber|Semaphore|Ref|Deferred|Queue|TaskLocal|Tracer|Retry|Clock|VirtualClock|Scheduler|Service|AbortError|AbortSignal|AbortController|RequestError|TaggedEnum|Redacted|Promise|Error|Map|Set|Array|Record|Readonly|Number|String|Date|Response|Request|URL|string|number|boolean|never|unknown)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g;

export const highlightTs = (code: string): string => {
  const tokens: string[] = [];
  let last = 0;
  for (const match of code.matchAll(TS_TOKEN_RE)) {
    const index = match.index;
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

const shortenerReport = "#/docs/benchmarks/url-shortener#abba-averages-2-rounds-per-stack";
const shortenerSetup =
  "Nov 27, 2026 · 50 connections · 2 s warmup · 8 s sample · ABBA mean · 0 errors";

const BENCH_DATASETS: Readonly<Record<BenchTab, BenchDataset>> = {
  ecosystem: {
    title: "Cached URL redirects",
    takeaway: "the redirect throughput of the Effect stack",
    description:
      "Both URL shorteners read from Redis, return a 302 and enqueue a BullMQ job. In the equalized ABBA run, Fastify + Resultar reached 22,407 req/s (p50 2.08 ms, p99 4.06 ms), compared with 17,964 req/s (p50 2.64 ms, p99 4.74 ms) for Effect.",
    setup: shortenerSetup,
    source: shortenerReport,
    unit: "Requests per second",
    axisMax: 30_000,
    result: { label: "Fastify 5 + Resultar", value: 22_407 },
    baseline: { label: "Effect HTTP", value: 17_964 },
  },
  create: {
    title: "Create a short URL",
    takeaway: "the write throughput of the Effect stack",
    description:
      "Both services insert a short URL into MongoDB and update Redis. Fastify + Resultar handled 14,351 writes/s against 12,008 for Effect. Effect had the lower p99 latency on this endpoint (7.35 ms vs 8.65 ms).",
    setup: shortenerSetup,
    source: shortenerReport,
    unit: "Requests per second",
    axisMax: 20_000,
    result: { label: "Fastify 5 + Resultar", value: 14_351 },
    baseline: { label: "Effect HTTP", value: 12_008 },
  },
  adapters: {
    title: "Eight services on a Fastify route",
    takeaway: "of raw Fastify throughput with scoped DI",
    description:
      "Resultar resolved an eight-service dependency graph for each request. The route served 39,267 requests per second, compared with 46,778 for the bare handler.",
    setup: "Nov 27, 2026 · Apple M4 · Node.js 26.13.1 · eight-service Tier 1",
    source: "#/docs/benchmarks/url-shortener#core-http-adapter-microbenchmark-snapshot-9dd623e",
    unit: "Requests per second",
    axisMax: 50_000,
    result: { label: "Fastify + eight-service scope", value: 39_267 },
    baseline: { label: "Fastify without DI", value: 46_778 },
  },
  core: {
    title: "JSON response validation",
    takeaway: "the throughput with a compiled TypeBox schema",
    description:
      "Each operation creates a Response, reads its JSON and validates the payload. Both runs use the same requestJsonTypeBox client.",
    setup: "Nov 22, 2026 · Node.js 26.13.1 · Apple M4 · 25,000 operations per round",
    source: "#/docs/benchmarks#typebox-direct-validation-and-json-request",
    unit: "Operations per second",
    axisMax: 400_000,
    result: { label: "Compiled schema (JIT on)", value: 360_620 },
    baseline: { label: "Fallback validation (JIT off)", value: 98_243 },
  },
};

const stockSchemas = {
  Zod: {
    imports: 'import { requestJsonZod, RequestError, z } from "resultar-request-zod";',
    definition: `const stock = z.object({
  quantity: z.number().int().nonnegative(),
});`,
    request: "requestJsonZod",
    option: "schema: stock",
    guide: "packages/request-zod",
  },
  TypeBox: {
    imports: 'import { requestJsonTypeBox, RequestError, t } from "resultar-request-typebox";',
    definition: `const stock = t.Object({
  quantity: t.Integer({ minimum: 0 }),
});`,
    request: "requestJsonTypeBox",
    option: "schema: stock",
    guide: "packages/request-typebox",
  },
  "Type guard": {
    imports: 'import { requestJson, RequestError } from "resultar-request";',
    definition: `type Stock = { quantity: number };

function isStock(value: unknown): value is Stock {
  return typeof value === "object" && value !== null
    && "quantity" in value
    && typeof value.quantity === "number"
    && Number.isInteger(value.quantity) && value.quantity >= 0;
}`,
    request: "requestJson",
    option: "validator: isStock",
    guide: "packages/request",
  },
} as const;

const inventoryService = (schema: Schema): string => {
  const { imports, definition, request, option } = stockSchemas[schema];
  return `import { createModule, service } from "resultar-di";
${imports}

${definition}

const FindStock = service("findStock", {
  make: () => (sku: string) => {
    const url = \`https://inventory.example.com/stock?item=\${encodeURIComponent(sku)}\`;
    return ${request}({
      request: (signal) => fetch(url, { signal }),
      ${option},
      mapError: {
        404: () => new RequestError("Unknown SKU", 404),
        orElse: () =>
          new RequestError("Inventory unavailable", 502),
      },
    }).map(({ quantity }) => ({ sku, quantity }));
  },
});

export const services = createModule().singleton(FindStock);`;
};

const existingApps = {
  Fastify: {
    anchor: "existing-fastify-applications",
    label: "Register a plugin in your existing Fastify app",
  },
  Hono: {
    anchor: "add-services-to-an-existing-hono-router",
    label: "Add middleware to one Hono route",
  },
  NestJS: {
    anchor: "existing-nestjs-applications",
    label: "Import a module into your existing NestJS app",
  },
} as const;

const routeApplications: Readonly<Record<Framework, string>> = {
  Fastify: `import { services } from "./inventory.js";

export const app = createFastifyApp({ services }, (server) => {
  server.get<{ Params: { sku: string } }>(
    "/stock/:sku", async (req, reply) => {
      const result = await req.services
        .findStock(req.params.sku)
        .runResult({ signal: req.signal });

      if (result.isErr()) {
        const { statusCode, message } = result.error;
        return reply.code(statusCode).send({ error: message });
      }
      return reply.send(result.value);
    },
  );
});`,
  Hono: `import { services } from "./inventory.js";

export const app = createHonoApp({ services }, (router) => {
  router.get("/stock/:sku", async (c) => {
    const result = await c.env
      .findStock(c.req.param("sku"))
      .runResult({ signal: c.req.raw.signal });

    if (result.isErr()) {
      const { statusCode, message } = result.error;
      const status = statusCode === 404 ? 404 : 502;
      return c.json({ error: message }, status);
    }
    return c.json(result.value);
  });
});`,
  NestJS: `import { services } from "./inventory.js";

type RequestServices = InferRequestServices<typeof app>;

@Controller("stock")
class StockController {
  @Get(":sku")
  async get(
    @Param("sku") sku: string,
    @Services("findStock") lookup: RequestServices["findStock"],
    @Req() req: NestRequest,
  ) {
    const result = await lookup(sku)
      .runResult({ signal: req.signal });
    if (result.isErr()) {
      const { statusCode, message } = result.error;
      throw new HttpException({ error: message }, statusCode);
    }
    return result.value;
  }
}

export const app = createNestApp({
  services, controllers: [StockController],
});`,
};

const frameworkRoutes: Readonly<Record<Framework, string>> = {
  Fastify: `import { createFastifyApp, type InferRequestServices } from "resultar-fastify";
${routeApplications.Fastify}

declare module "fastify" {
  interface FastifyRequest {
    services: InferRequestServices<typeof app>;
  }
}`,
  Hono: `import { createHonoApp } from "resultar-hono";
${routeApplications.Hono}`,
  NestJS: `import { Controller, Get, HttpException, Param, Req } from "@nestjs/common";
import { createNestApp, Services, type InferRequestServices, type NestRequest } from "resultar-nestjs";
${routeApplications.NestJS}`,
};

export interface HeroRunPreview {
  readonly running: boolean;
  readonly ok?: boolean;
  readonly durationMs?: number;
  readonly output?: string;
}

export const renderHeroShowcase = (activeTab: HeroTab, runState: HeroRunPreview): string => {
  const isResultar = activeTab === "resultar";
  const snippet = isResultar ? HERO_RESULTAR_SNIPPET : HERO_THROW_SNIPPET;
  const encodedPlay = encodeURIComponent(encodeBase64Utf8(HERO_RESULTAR_SNIPPET));

  let runDrawer = "";
  if (isResultar && runState.running) {
    runDrawer = `<div class="hero-run-output" role="status">Running in browser sandbox…</div>`;
  } else if (isResultar && runState.output !== undefined) {
    const statusCls = runState.ok === true ? "pg-status-ok" : "pg-status-err";
    const statusLabel =
      runState.ok === true
        ? `✓ Live output (${(runState.durationMs ?? 0).toFixed(1)} ms)`
        : "✗ Runtime error";
    runDrawer = `
      <div class="hero-run-output" role="status">
        <span class="${statusCls}">${escapeHtml(statusLabel)}</span>
        <code>${escapeHtml(runState.output)}</code>
      </div>
    `;
  }

  return `
    <div class="hero-code-card">
      <div class="hero-code-head">
        <div class="seg-tabs hero-tabs" role="group" aria-label="Compare error handling">
          <button
            type="button"
            class="seg-tab ${isResultar ? "active" : ""}"
            aria-pressed="${String(isResultar)}"
            data-hero-tab="resultar"
          >With Resultar</button>
          <button
            type="button"
            class="seg-tab ${isResultar ? "" : "active"}"
            aria-pressed="${String(!isResultar)}"
            data-hero-tab="throw"
          >Standard throw</button>
        </div>
        <div class="code-actions">
          ${
            isResultar
              ? `<button class="code-btn code-btn-play" type="button" data-action="hero-run">▶ Run live</button>
                 <a class="code-btn" href="#/playground?code=${encodedPlay}">Playground ↗</a>`
              : `<a class="code-btn code-btn-play" href="#/playground?code=${encodedPlay}">Fix in Playground →</a>`
          }
        </div>
      </div>
      <pre class="hero-pre"><code>${highlightTs(snippet)}</code></pre>
      <div class="hero-type-bar ${isResultar ? "typed" : "untyped"}">
        <span class="hero-type-badge">${isResultar ? "Inferred signature" : "What TypeScript sees"}</span>
        <code>${
          isResultar
            ? 'charge → ResultTask&lt;{ charged: number; status: "paid" }, InvalidAmount | CardDeclined&gt;'
            : 'charge → Promise&lt;{ charged: number; status: "paid" }&gt;  // 2 throws hidden from callers'
        }</code>
      </div>
      ${runDrawer}
    </div>
  `;
};

export const renderInteroperabilityShowcase = (
  framework: Framework,
  schema: Schema,
  expanded = false,
): string => {
  const service = inventoryService(schema);

  return `
  <section class="service-showcase" aria-labelledby="service-heading">
    <header class="section-head">
      <div>
        <h2 id="service-heading">Keep your stack. Bring your own schemas.</h2>
        <p class="section-sub">Register one stock lookup and use it in Fastify, Hono, or NestJS.
          Validate the supplier’s response with TypeBox or Zod, or connect Valibot or ArkType through a custom decoder.</p>
      </div>
    </header>
    <div class="stack-workbench">
      <div class="stack-panes">
        <div class="stack-pane">
          <h3>Create the stock service</h3>
          <div class="seg-tabs" role="group" aria-label="Response validation">
            ${(["TypeBox", "Zod", "Type guard"] as const)
              .map(
                (name) =>
                  `<button type="button" class="seg-tab ${name === schema ? "active" : ""}" aria-pressed="${String(name === schema)}" data-schema="${name}">${name}</button>`,
              )
              .join("")}
          </div>
          <pre><code>${highlightTs(service)}</code></pre>
          <a href="#/docs/${stockSchemas[schema].guide}">Response validation guide</a>
        </div>
        <div class="stack-pane">
          <h3>Serve <code>GET /stock/:sku</code></h3>
          <div class="seg-tabs" role="group" aria-label="HTTP framework">
            ${(["Fastify", "Hono", "NestJS"] as const)
              .map(
                (name) =>
                  `<button type="button" class="seg-tab ${name === framework ? "active" : ""}" aria-pressed="${String(name === framework)}" data-framework="${name}">${name}</button>`,
              )
              .join("")}
          </div>
          <pre><code>${highlightTs(routeApplications[framework])}</code></pre>
          <a href="#/docs/packages/${framework.toLowerCase()}#${existingApps[framework].anchor}">${existingApps[framework].label}</a>
        </div>
      </div>
      <dl class="route-responses" aria-label="Example HTTP responses">
        <div><dt>Known SKU</dt><dd><samp>200 · {"sku":"pen","quantity":4}</samp></dd></div>
        <div><dt>Unknown SKU</dt><dd><samp>404 · {"error":"Unknown SKU"}</samp></dd></div>
        <div><dt>Supplier unavailable</dt><dd><samp>502 · {"error":"Inventory unavailable"}</samp></dd></div>
      </dl>
      <details class="stack-source" ${expanded ? "open" : ""}>
        <summary>Full ${schema} and ${framework} example</summary>
        <div class="code-block service-source">
          <div class="code-header">inventory.ts</div>
          <pre><code>${highlightTs(service)}</code></pre>
        </div>
        <div class="code-block route-source">
          <div class="code-header">${framework.toLowerCase()}.ts</div>
          <pre><code>${highlightTs(frameworkRoutes[framework])}</code></pre>
        </div>
      </details>
    </div>
  </section>
`;
};

export const renderBenchmarkShowcase = (activeTab: BenchTab): string => {
  const data = BENCH_DATASETS[activeTab];
  const ratio = data.result.value / data.baseline.value;
  const metric = activeTab === "adapters" ? `${(ratio * 100).toFixed(1)}%` : `${ratio.toFixed(2)}×`;
  return `
    <section class="bench-section" aria-labelledby="bench-heading">
      <header class="section-head">
        <h2 id="bench-heading">What does it cost at runtime?</h2>
        <div class="seg-tabs" role="group" aria-label="Benchmark workload">
          ${(
            [
              ["ecosystem", "HTTP redirects"],
              ["create", "Create a URL"],
              ["adapters", "Request-scoped DI"],
              ["core", "JSON validation"],
            ] as const
          )
            .map(
              ([key, label]) =>
                `<button type="button" aria-pressed="${String(key === activeTab)}" class="seg-tab ${key === activeTab ? "active" : ""}" data-bench-tab="${key}">${label}</button>`,
            )
            .join("")}
        </div>
      </header>
      <div class="bench-card">
        <div class="bench-comparison">
          <div class="bench-story">
            <h3><strong>${metric}</strong>${escapeHtml(data.takeaway)}</h3>
            <p>${escapeHtml(data.description)}</p>
          </div>
          <figure class="bench-plot">
            <figcaption>${escapeHtml(data.title)}<small>${escapeHtml(data.unit)}</small></figcaption>
            ${[data.result, data.baseline]
              .map(
                (row) => `
              <div class="bench-series">
                <span>${escapeHtml(row.label)}</span><b>${row.value.toLocaleString("en-US")}</b>
                <div class="bench-track" aria-hidden="true"><i style="width:${(100 * row.value) / data.axisMax}%"></i></div>
              </div>`,
              )
              .join("")}
            <div class="bench-axis" aria-hidden="true"><span>0</span><span>${data.axisMax / 2000}k</span><span>${data.axisMax / 1000}k</span></div>
          </figure>
        </div>
        <footer class="bench-footer">
          <span>${escapeHtml(data.setup)}</span>
          <a href="${data.source}">View measurements</a>
        </footer>
      </div>
    </section>
  `;
};

interface AiSnippet {
  readonly fileLabel: string;
  readonly code: string;
}

const AI_SNIPPETS: Readonly<Record<AiTab, AiSnippet>> = {
  "agents-md": {
    fileLabel: "AGENTS.md / CLAUDE.md",
    code: `## Resultar
- Read node_modules/resultar-check/dist/agent/SKILL.md first.
- Check signatures against the installed package declarations.
- Use Result<T, E> for sync work and lazy ResultTask<T, E, R> for async
  (call await task.runResult() at the application boundary).
- After edits, run: pnpm exec resultar-check --project tsconfig.json`,
  },
  cursor: {
    fileLabel: "Cursor, VS Code & Zed scaffold",
    code: `# Generates .cursor/rules/resultar-check.mdc, .vscode/tasks.json,
# extension recommendation (inaiat.resultar-check), and LSP setup
pnpm add -D resultar-check
pnpm exec resultar-check init --editor cursor --project tsconfig.json
pnpm exec resultar-check doctor --editor cursor`,
  },
  cli: {
    fileLabel: "Agent verification loop",
    code: `# Map exported Result/ResultTask APIs, tagged errors, and DI services
pnpm exec resultar-check overview --project tsconfig.json --json

# Stream machine-readable TypeScript + Resultar diagnostics (JSONL)
pnpm exec resultar-check --project tsconfig.json --json

# Preview supported corrections before applying them
pnpm exec resultar-check --fix-dry-run --project tsconfig.json`,
  },
};

export const renderAiShowcase = (activeTab: AiTab, ruleCount: number): string => {
  const snippet = AI_SNIPPETS[activeTab];
  const encoded = encodeBase64Utf8(snippet.code);
  return `
    <section class="ai-section" aria-labelledby="ai-heading">
      <header class="section-head">
        <div>
          <h2 id="ai-heading">Give your coding agent the same types you see</h2>
          <p class="section-sub">Install <code>resultar-check</code> as a dev dependency. Its offline guide gives an agent the API and recipes. Its CLI lets the agent inspect a function’s contract before an edit and run your CI checks afterward.</p>
        </div>
        <div class="seg-tabs" role="group" aria-label="AI agent setup">
          ${(
            [
              ["agents-md", "AGENTS.md"],
              ["cursor", "Cursor"],
              ["cli", "CLI loop"],
            ] as const
          )
            .map(
              ([key, label]) =>
                `<button type="button" aria-pressed="${String(key === activeTab)}" class="seg-tab ${key === activeTab ? "active" : ""}" data-ai-tab="${key}">${label}</button>`,
            )
            .join("")}
        </div>
      </header>
      <div class="ai-grid">
        <div class="code-block ai-code">
          <div class="code-header">
            <span>${escapeHtml(snippet.fileLabel)}</span>
            <div class="code-actions">
              <button class="code-btn code-btn-copy" type="button" data-copy="${encoded}">Copy</button>
            </div>
          </div>
          <pre><code>${escapeHtml(snippet.code)}</code></pre>
        </div>
        <div class="ai-card">
          <h3>A contract the agent can read</h3>
          <dl class="contract-fields">
            <div><dt>Function</dt><dd><code>createUser</code></dd></div>
            <div><dt>Success</dt><dd><code>User</code></dd></div>
            <div><dt>Error</dt><dd><code>InvalidEmailError | UserAlreadyExistsError</code></dd></div>
          </dl>
          <p>The checker extracts this contract from the example project. Its ${String(ruleCount)} configurable rules can flag a <a href="#/docs/resultar-check#rule-no-discard">discarded result</a> or a <a href="#/docs/resultar-check#rule-no-await-result-task">task left idle</a>, with the file and line to fix.</p>
          <div class="ai-actions">
            <a href="#/docs/agents/setup">Set up your agent</a>
            <a href="./llms.txt">llms.txt</a>
          </div>
        </div>
      </div>
    </section>
  `;
};

export const renderBottomCta = (): string => `
  <section class="home-cta">
    <div>
      <h2>Which failure does your caller need to handle?</h2>
      <p>Try it in the Playground, or follow the quickstart to give one function in your project a typed result.</p>
    </div>
    <div class="home-cta-actions">
      <a class="btn btn-primary" href="#/playground">Open Playground</a>
      <a class="home-text-link" href="#/docs/quickstart">Read the quickstart</a>
    </div>
  </section>
`;
