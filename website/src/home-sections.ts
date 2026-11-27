export type BenchTab = "adapters" | "core" | "ecosystem";
export type Framework = "Fastify" | "Hono" | "NestJS";

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

const inventoryService = `import { createModule } from "resultar-app";
import { RequestError, requestJsonTypeBox, t } from "resultar-request-typebox";

const endpoint = "https://inventory.example.com/stock";
const stock = t.Object({ quantity: t.Integer({ minimum: 0 }) });

const unavailable = () => new RequestError("Inventory unavailable", 502);

export function findStock(sku: string) {
  const url = \`\${endpoint}?item=\${sku}\`;
  return requestJsonTypeBox({
    request: (signal) => fetch(url, { signal }),
    schema: stock,
    mapError: {
      404: () => new RequestError("Unknown SKU", 404),
      http: unavailable,
      request: unavailable,
      invalidJson: unavailable,
      validation: unavailable,
    },
  }).map(({ quantity }) => ({ sku, quantity }));
}

export const services = createModule().value("findStock", findStock);`;

const frameworkRoutes: Readonly<Record<Framework, string>> = {
  Fastify: `import { createFastifyApp, type InferRequestServices } from "resultar-fastify";
import { services } from "./inventory.js";

export const app = createFastifyApp({ services }, (server) => {
  server.get<{ Params: { sku: string } }>("/stock/:sku", async (req, reply) => {
    const result = await req.services.findStock(req.params.sku)
      .runResult({ signal: req.signal });
    if (result.isErr()) {
      return reply.code(result.error.statusCode).send({ error: result.error.message });
    }
    return reply.send(result.value);
  });
});

declare module "fastify" {
  interface FastifyRequest {
    services: InferRequestServices<typeof app>;
  }
}`,
  Hono: `import { createHonoApp } from "resultar-hono";
import { services } from "./inventory.js";

export const app = createHonoApp({ services }, (router) => {
  router.get("/stock/:sku", async (c) => {
    const result = await c.env.findStock(c.req.param("sku"))
      .runResult({ signal: c.req.raw.signal });
    if (result.isErr()) {
      const status = result.error.statusCode === 404 ? 404 : 502;
      return c.json({ error: result.error.message }, status);
    }
    return c.json(result.value);
  });
});`,
  NestJS: `import { Controller, Get, HttpException, Param, Req } from "@nestjs/common";
import { createNestApp, Services, type NestRequest } from "resultar-nestjs";
import { services, type findStock } from "./inventory.js";

@Controller("stock")
class StockController {
  @Get(":sku")
  async get(
    @Param("sku") sku: string,
    @Services("findStock") lookup: typeof findStock,
    @Req() req: NestRequest,
  ) {
    const result = await lookup(sku).runResult({ signal: req.signal });
    if (result.isErr()) {
      throw new HttpException({ error: result.error.message }, result.error.statusCode);
    }
    return result.value;
  }
}

export const app = createNestApp({ services, controllers: [StockController] });`,
};

export const renderInteroperabilityShowcase = (framework: Framework): string => `
  <section class="service-showcase" aria-labelledby="service-heading">
    <header class="section-head">
      <div>
        <h2 id="service-heading">One inventory service, three HTTP frameworks</h2>
        <p class="section-sub">The service fetches a quantity from an inventory API and validates its JSON. Each framework runs the same task when a request arrives.</p>
      </div>
    </header>
    <div class="code-block service-source">
      <div class="code-header"><span>inventory.ts</span></div>
      <pre><code>${highlightTs(inventoryService)}</code></pre>
    </div>
    <div class="route-header">
      <h3>Serve the lookup over HTTP</h3>
      <div class="seg-tabs" role="group" aria-label="HTTP framework">
        ${(["Fastify", "Hono", "NestJS"] as const)
          .map(
            (name) =>
              `<button type="button" class="seg-tab ${name === framework ? "active" : ""}" aria-pressed="${String(name === framework)}" data-framework="${name}">${name}</button>`,
          )
          .join("")}
      </div>
    </div>
    <div class="code-block route-source">
      <div class="code-header">
        <span>${framework.toLowerCase()}.ts</span>
        <a href="#/docs/packages/${framework.toLowerCase()}">${framework} adapter guide →</a>
      </div>
      <pre><code>${highlightTs(frameworkRoutes[framework])}</code></pre>
    </div>
    <div class="route-responses" aria-label="Example responses">
      <div><code>GET /stock/pen</code><samp>200 · {"sku":"pen","quantity":0}</samp></div>
      <div><code>GET /stock/marker</code><samp>404 · {"error":"Unknown SKU"}</samp></div>
      <div><span>Inventory API fails</span><samp>502 · {"error":"Inventory unavailable"}</samp></div>
    </div>
    <p class="service-links"><a href="#/docs/gradual-adoption">Gradual adoption</a> · <a href="#/docs/packages/request-zod">Zod validation</a> · <a href="#/docs/packages/request-typebox">TypeBox validation</a></p>
  </section>
`;

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
