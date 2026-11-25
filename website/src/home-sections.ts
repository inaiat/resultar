export type BenchTab = "adapters" | "core" | "ecosystem";
export type CompareTab = "http" | "schemas" | "progressive";

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
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:import|export|from|type|interface|class|extends|implements|const|let|var|function|return|if|else|for|while|switch|case|default|break|continue|async|await|yield|new|throw|try|catch|finally|readonly|as|satisfies|typeof|keyof|in|of|void|true|false|null|undefined)\b|\b(?:Result|ResultTask|ResultAsync|Hono|Type|Match|Cause|Exit|Fiber|Semaphore|Ref|Deferred|Queue|TaskLocal|Tracer|Retry|Clock|Scheduler|Service|AbortError|Promise|Error|Map|Set|Array|Record|Readonly|string|number|boolean|never|unknown)\b|\b\d+(?:_\d+)*(?:\.\d+)?\b)/g;

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

const BENCH_DATASETS: Readonly<Record<BenchTab, BenchDataset>> = {
  ecosystem: {
    title: "Cached URL redirects",
    takeaway: "the redirect throughput of the Effect stack",
    description:
      "Both URL shorteners read from Redis, return a 302 and enqueue a BullMQ job. The Fastify + Resultar stack recorded a p99 of 2.83 ms, compared with 3.66 ms for Effect.",
    setup: "50 keep-alive connections · 1.5 s warmup · 5 s sample · 0 errors",
    source:
      "#/docs/coming-from-effect#real-world-http-service-url-shortener-mongodb-7-redis-8-bullmq",
    unit: "Requests per second",
    axisMax: 40_000,
    result: { label: "Fastify 5 + Resultar", value: 35_630 },
    baseline: { label: "Effect HTTP", value: 18_551 },
  },
  adapters: {
    title: "Eight services on a Fastify route",
    takeaway: "of raw Fastify throughput with scoped DI",
    description:
      "Resultar resolved an eight-service dependency graph for each request. The route served 43,554 requests per second, compared with 45,919 for the bare handler.",
    setup: "Fastify 5.12.8 · 16 keep-alive connections · 10,000 requests per round · JIT on",
    source: "#/docs/benchmarks#fastify-http-fastify-5128",
    unit: "Requests per second",
    axisMax: 50_000,
    result: { label: "Fastify + eight-service scope", value: 43_554 },
    baseline: { label: "Fastify without DI", value: 45_919 },
  },
  core: {
    title: "JSON response validation",
    takeaway: "the throughput with a compiled TypeBox schema",
    description:
      "Each operation creates a Response, reads its JSON and validates the payload. Both runs use the same requestJsonTypeBox client.",
    setup: "Node.js 26.13.1 · Apple M4 · 25,000 operations per round",
    source: "#/docs/benchmarks#typebox-direct-validation-and-json-request",
    unit: "Operations per second",
    axisMax: 400_000,
    result: { label: "Compiled schema (JIT on)", value: 360_620 },
    baseline: { label: "Fallback validation (JIT off)", value: 98_243 },
  },
};

interface CompareExample {
  readonly leftTitle: string;
  readonly leftBadge: string;
  readonly leftCode: string;
  readonly rightTitle: string;
  readonly rightBadge: string;
  readonly rightCode: string;
  readonly takeaway: string;
  readonly playgroundPresetId?: string;
  readonly docsHref: string;
  readonly docsLabel: string;
}

const COMPARE_EXAMPLES: Readonly<Record<CompareTab, CompareExample>> = {
  http: {
    leftTitle: "Fastify 5 · resultar-fastify",
    leftBadge: "95%+ of raw Fastify · CSP-safe DI",
    leftCode: `import { createFastifyApp, createModule, service } from "resultar-fastify";

// Define services once — framework-agnostic module
const services = createModule()
  .singleton("repo", [], () => makeUserRepo(db))
  .scoped(service("useCase", { repo }, ({ repo }) => makeUseCase(repo)));

const app = createFastifyApp({ services, bindings: ["useCase"] }, (app) => {
  // Skip request scope on high-QPS probes (66.4k req/s)
  app.get("/health", { config: { resultar: { requestScope: false } } }, () => ({
    ok: true,
  }));

  // Automatic Tier 0/1 sync DI — zero TaskScope per request
  app.get("/users/:id", async (req) => {
    const res = await req.services.useCase.find(req.params.id).runResult();
    return res.matchTags(
      (user) => ({ user }),
      { UserNotFound: (e) => ({ status: 404, error: e.message }) },
    );
  });
});`,
    rightTitle: "Hono & NestJS · same DI module",
    rightBadge: "Zero HTTP framework lock-in",
    rightCode: `import { Hono } from "hono";
import { createHonoServices } from "resultar-hono";

// Plug the exact same resultar-di module into Hono (Edge / Node)
const di = createHonoServices(services);
const app = new Hono();

app.get("/users/:id", di.middleware(["useCase"]), async (c) => {
  const res = await c.var.services.useCase
    .find(c.req.param("id"))
    .runResult();
  return res.matchTags(
    (user) => c.json(user),
    { UserNotFound: (e) => c.json({ error: e.message }, 404) },
  );
});

// Or plug into NestJS 12 with decorators & Fastify/Express adapters:
// createNestApp({ services, bindings: ["useCase"], controllers: [UsersCtrl] })`,
    takeaway:
      "Write services and domain workflows once. Plug them natively into Fastify 5, Hono, NestJS 12, or plain Fetch/Node handlers with graceful shutdown and automatic Tier 0/1/2 scoping.",
    docsHref: "#/docs/packages/fastify",
    docsLabel: "Explore Fastify, Hono & NestJS adapters →",
  },
  schemas: {
    leftTitle: "Zod · resultar-request-zod",
    leftBadge: "Bring your own schema library",
    leftCode: `import { z } from "zod";
import { requestJsonZod } from "resultar-request-zod";
import { Retry } from "resultar";

const UserSchema = z.object({
  id: z.string(),
  email: z.email(),
  role: z.enum(["admin", "member"]),
});

// Typed HTTP + Zod decode + AbortSignal + retries in one ResultTask
const fetchUser = (id: string) =>
  requestJsonZod(\`https://api.example.com/users/\${id}\`, {
    schema: UserSchema,
    timeoutMs: 2_000,
  }).retry(Retry.policy({ times: 2, delayMs: 50 }));

const res = await fetchUser("u-1").runResult();`,
    rightTitle: "TypeBox, Valibot, ArkType or any validator",
    rightBadge: "Zero proprietary schema lock-in",
    rightCode: `import { Type } from "typebox";
import { requestJsonTypeBox } from "resultar-request-typebox";
import { Result } from "resultar";

const UserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
});

// Compiled TypeBox validator (749× faster than uncompiled check)
const fetchFast = (id: string) =>
  requestJsonTypeBox(\`https://api.example.com/users/\${id}\`, {
    schema: UserSchema,
  });

// Or wrap Valibot / ArkType / Standard Schema into Result<T, E>
const decode = <T>(parse: (raw: unknown) => T, raw: unknown) =>
  Result.fromThrowable(
    () => parse(raw),
    (cause) => new DecodeError({ cause }),
  )();`,
    takeaway:
      "Use Zod, TypeBox, Valibot, ArkType, or Standard Schema at your boundaries. Resultar never forces you to learn or migrate to a proprietary schema DSL.",
    docsHref: "#/docs/packages/request-zod",
    docsLabel: "Explore Zod & TypeBox request packages →",
  },
  progressive: {
    leftTitle: "Stage 1 · Pure sync Result<T, E>",
    leftBadge: "~5.9 kB gzip · zero async overhead",
    leftCode: `import { createTaggedError, ok, redact, Result } from "resultar";

class InvalidTokenError extends createTaggedError({
  name: "InvalidTokenError",
  message: "Rejected token $token for $tenantId",
}) {}

const authorize = (
  token: string,
  tenantId: string,
): Result<string, InvalidTokenError> =>
  token.startsWith("live_")
    ? ok(tenantId)
    : InvalidTokenError.err({
        token: redact(token, "apiKey"),
        tenantId,
      });

// Real Error subclass + $var interpolation + safe secret redaction
// Zero Promises, zero fibers, zero runtime setup`,
    rightTitle: "Stage 2–3 · Lazy ResultTask<A, E, R>",
    rightBadge: "Native Promise<Result> at the boundary",
    rightCode: `import { ResultTask, Retry, serviceTag } from "resultar";

const BillingApi = serviceTag<{
  readonly charge: (tenant: string, amount: number) => ResultTask<Receipt, BillingError>;
}>("BillingApi");

const checkout = ResultTask.fn(
  "billing.checkout",
  function* (token: string, tenantId: string, amount: number) {
    const tenant = yield* authorize(token, tenantId);
    const api = yield* BillingApi;
    return yield* api.charge(tenant, amount);
  },
  ResultTask.retry(Retry.policy({ times: 2, delayMs: 50 })),
);

// Standard Promise<Result<Receipt, InvalidTokenError | BillingError>>
const res = await checkout(token, "acme", 100)
  .provideService(BillingApi, impl)
  .runResult();`,
    takeaway:
      "Adopt Resultar one function at a time. Start with pure sync Result, add lazy ResultTask when you need retries, cancellation, or DI, and cross any boundary with standard Promise<Result>.",
    playgroundPresetId: "task-di",
    docsHref: "#/docs/gradual-adoption",
    docsLabel: "Read the Gradual Adoption guide →",
  },
};

export const renderInteroperabilityShowcase = (activeTab: CompareTab): string => {
  const item = COMPARE_EXAMPLES[activeTab];
  return `
    <section class="compare-section" aria-labelledby="compare-heading">
      <div class="section-head">
        <div>
          <span class="section-eyebrow">FRAMEWORK &amp; SCHEMA INTEROPERABILITY</span>
          <h2 id="compare-heading">Keep your stack. Bring your own schemas.</h2>
          <p class="section-sub">Write domain logic once with <code>Result</code> and <code>ResultTask</code>. Plug into Fastify, Hono, or NestJS and validate with Zod, TypeBox, Valibot, or ArkType — no framework rewrite.</p>
        </div>
        <div class="seg-tabs" role="tablist" aria-label="Interoperability views">
          <button type="button" role="tab" aria-selected="${String(activeTab === "http")}" class="seg-tab ${activeTab === "http" ? "active" : ""}" data-compare-tab="http">Fastify · Hono · NestJS</button>
          <button type="button" role="tab" aria-selected="${String(activeTab === "schemas")}" class="seg-tab ${activeTab === "schemas" ? "active" : ""}" data-compare-tab="schemas">Zod · TypeBox · Any Schema</button>
          <button type="button" role="tab" aria-selected="${String(activeTab === "progressive")}" class="seg-tab ${activeTab === "progressive" ? "active" : ""}" data-compare-tab="progressive">Result → Task → DI</button>
        </div>
      </div>

      <div class="compare-grid">
        <div class="code-block compare-code">
          <div class="code-header">
            <span>${escapeHtml(item.leftTitle)}</span>
            <span class="compare-badge">${escapeHtml(item.leftBadge)}</span>
          </div>
          <pre><code>${highlightTs(item.leftCode)}</code></pre>
        </div>
        <div class="code-block compare-code compare-code-accent">
          <div class="code-header">
            <span>${escapeHtml(item.rightTitle)}</span>
            <div class="code-actions">
              <span class="compare-badge compare-badge-accent">${escapeHtml(item.rightBadge)}</span>
              ${
                item.playgroundPresetId === undefined
                  ? ""
                  : `<a class="code-btn code-btn-play" href="#/playground?preset=${escapeHtml(item.playgroundPresetId)}">▶ Playground</a>`
              }
            </div>
          </div>
          <pre><code>${highlightTs(item.rightCode)}</code></pre>
        </div>
      </div>

      <div class="compare-takeaway">
        <p>${escapeHtml(item.takeaway)}</p>
        <a href="${escapeHtml(item.docsHref)}">${escapeHtml(item.docsLabel)}</a>
      </div>

      <div class="pillar-grid">
        <div class="pillar-card">
          <h3>Any HTTP framework</h3>
          <p>First-class adapters for <strong>Fastify 5</strong>, <strong>Hono</strong>, and <strong>NestJS 12</strong> — plus Fetch, Workers, and Express via standard <code>Promise&lt;Result&gt;</code>.</p>
        </div>
        <div class="pillar-card">
          <h3>Any schema &amp; driver</h3>
          <p>First-class <strong>Zod</strong> and <strong>TypeBox</strong> integrations, or wrap Valibot, ArkType, MongoDB, PostgreSQL, Redis, and OpenTelemetry directly.</p>
        </div>
        <div class="pillar-card">
          <h3>Native JS &amp; strict CSP</h3>
          <p>Real <code>Error</code> subclasses, native <code>AbortSignal</code>, pure-JS DI plans (<code>0</code> <code>new Function</code> calls), and 43 native TypeScript-Go rules.</p>
        </div>
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
        <h2 id="bench-heading">Resultar in benchmarks</h2>
        <div class="seg-tabs" role="group" aria-label="Benchmark workload">
          ${(
            [
              ["ecosystem", "HTTP redirects"],
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
          <a href="${data.source}">View measurements →</a>
        </footer>
      </div>
    </section>
  `;
};

export const renderBottomCta = (): string => `
  <section class="home-cta">
    <div>
      <h2>Try Resultar v5 in your browser in 10 seconds</h2>
      <p>Run real tagged errors, typed DI, virtual clocks, bounded queues, and span waterfalls locally — no install needed.</p>
    </div>
    <div class="home-cta-actions">
      <a class="btn btn-primary" href="#/playground">▶ Open Interactive Playground</a>
      <a class="btn" href="#/docs/quickstart">Read Quickstart</a>
      <a class="btn" href="#/docs/packages/fastify">HTTP &amp; Schema Packages</a>
    </div>
  </section>
`;
