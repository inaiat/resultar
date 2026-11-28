import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { DOC_LOADERS } from "../src/generated/site-data.js";
import { PLAYGROUND_PRESETS } from "../src/presets.js";

const websiteDir = resolve(import.meta.dirname, "..");
const distDir = join(websiteDir, "dist");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const findPlaywrightChrome = (cacheDir: string): string | undefined => {
  if (!existsSync(cacheDir)) return undefined;
  const entries = readdirSync(cacheDir).toSorted().toReversed();
  for (const dir of entries) {
    if (!dir.startsWith("chromium")) continue;
    const base = join(cacheDir, dir);
    const candidates = [
      join(
        base,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ),
      join(
        base,
        "chrome-mac-x64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      ),
      join(base, "chrome-linux", "chrome"),
      join(base, "chrome-linux64", "chrome"),
      join(base, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      join(base, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

const findBrowserExecutable = (): string => {
  const fromEnv = process.env.CHROME_PATH ?? process.env.CHROMIUM_PATH;
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) {
    return fromEnv;
  }
  const directCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  const home = process.env.HOME ?? "";
  if (home.length > 0) {
    const macCache = findPlaywrightChrome(join(home, "Library", "Caches", "ms-playwright"));
    if (macCache !== undefined) return macCache;
    const linuxCache = findPlaywrightChrome(join(home, ".cache", "ms-playwright"));
    if (linuxCache !== undefined) return linuxCache;
  }
  throw new Error(
    "Could not locate Chrome/Chromium executable for real-browser playground tests. Set CHROME_PATH.",
  );
};

interface StaticServerHooks {
  readonly beforeServe?: (relPath: string) => Promise<void> | void;
  readonly afterServe?: (relPath: string) => void;
}

const startStaticServer = async (
  context: TestContext,
  rootDir: string,
  hooks?: StaticServerHooks,
): Promise<string> => {
  if (!existsSync(join(rootDir, "index.html"))) {
    throw new Error(
      `Missing production build at ${rootDir}. Run "pnpm --dir website run build" first.`,
    );
  }
  const server = createServer((req, res) => {
    const rawUrl = (req.url ?? "/").split("?")[0] ?? "/";
    const relPath = rawUrl === "/" ? "index.html" : rawUrl.replace(/^\/+/u, "");
    const absPath = resolve(rootDir, relPath);
    const sendResponse = async (): Promise<void> => {
      if (hooks?.beforeServe !== undefined) {
        await hooks.beforeServe(relPath);
      }
      if (!absPath.startsWith(rootDir) || !existsSync(absPath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        hooks?.afterServe?.(relPath);
        return;
      }
      const contentType = MIME_TYPES[extname(absPath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(readFileSync(absPath));
      hooks?.afterServe?.(relPath);
    };
    void sendResponse();
  });
  context.after(async () => {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
      server.closeAllConnections();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind static test server");
  }
  return `http://127.0.0.1:${String(address.port)}`;
};

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

const stopChrome = async (
  proc: ChildProcess,
  userDataDir: string,
  ws?: WebSocket,
): Promise<void> => {
  try {
    ws?.close();
  } catch {
    // The process and profile still need cleanup if the connection cannot be closed.
  }
  if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolveExit) => {
      proc.once("exit", () => {
        resolveExit();
      });
    });
    proc.kill("SIGKILL");
    await exited;
  }
  // A Chrome subprocess can still hold the inherited pipe after the browser exits.
  proc.stderr?.destroy();
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
};

const chromeStartupTimeoutCode = "ERR_CHROME_STARTUP_TIMEOUT";

class HeadlessBrowser {
  private readonly proc: ChildProcess;
  private readonly userDataDir: string;
  private readonly ws: WebSocket;
  private readonly sessionId: string;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (val: Record<string, unknown>) => void;
      readonly reject: (err: Error) => void;
    }
  >();
  public readonly uncaughtExceptions: string[] = [];

  private constructor(proc: ChildProcess, userDataDir: string, ws: WebSocket, sessionId: string) {
    this.proc = proc;
    this.userDataDir = userDataDir;
    this.ws = ws;
    this.sessionId = sessionId;
  }

  public static async launch(
    executable = findBrowserExecutable(),
    startupTimeoutMs = 30_000,
  ): Promise<HeadlessBrowser> {
    try {
      return await HeadlessBrowser.launchOnce(executable, startupTimeoutMs);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === chromeStartupTimeoutCode)) {
        throw error;
      }
      console.warn("Chrome did not announce its DevTools URL in time. Retrying startup once.");
      return HeadlessBrowser.launchOnce(executable, startupTimeoutMs);
    }
  }

  private static async launchOnce(
    executable: string,
    startupTimeoutMs: number,
  ): Promise<HeadlessBrowser> {
    const userDataDir = mkdtempSync(join(tmpdir(), "resultar-pg-chrome-"));
    const proc = spawn(
      executable,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let ws: WebSocket | undefined = undefined;
    try {
      const wsUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
        let stderrBuf = "";
        const timer = setTimeout(() => {
          rejectUrl(
            Object.assign(
              new Error(`Timed out waiting for Chrome DevTools URL. Stderr:\n${stderrBuf}`),
              { code: chromeStartupTimeoutCode },
            ),
          );
        }, startupTimeoutMs);

        proc.once("error", (error) => {
          clearTimeout(timer);
          rejectUrl(error);
        });

        proc.once("exit", (code) => {
          clearTimeout(timer);
          rejectUrl(new Error(`Chrome exited early (${String(code)}). Stderr:\n${stderrBuf}`));
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString("utf8");
          const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderrBuf);
          if (match?.[1] !== undefined) {
            clearTimeout(timer);
            resolveUrl(match[1]);
          }
        });
      });

      const socket = new WebSocket(wsUrl);
      ws = socket;
      await withDeadline(
        new Promise<void>((resolveOpen, rejectOpen) => {
          socket.addEventListener(
            "open",
            () => {
              resolveOpen();
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            () => {
              rejectOpen(new Error(`Failed to open CDP WebSocket at ${wsUrl}`));
            },
            { once: true },
          );
        }),
        startupTimeoutMs,
        "Chrome DevTools WebSocket",
      );

      const browser = new HeadlessBrowser(proc, userDataDir, socket, "");
      socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        const msg = JSON.parse(text) as CdpMessage;
        if (msg.id !== undefined) {
          const entry = browser.pending.get(msg.id);
          if (entry !== undefined) {
            browser.pending.delete(msg.id);
            if (msg.error === undefined) {
              entry.resolve(msg.result ?? {});
            } else {
              entry.reject(new Error(msg.error.message ?? "CDP command failed"));
            }
          }
          return;
        }
        if (msg.method === "Runtime.exceptionThrown") {
          const details = msg.params?.exceptionDetails as
            | { readonly text?: string; readonly exception?: { readonly description?: string } }
            | undefined;
          browser.uncaughtExceptions.push(
            details?.exception?.description ?? details?.text ?? "Unknown page exception",
          );
        }
      });

      const target = await browser.sendRaw("Target.createTarget", { url: "about:blank" });
      const targetId = String(target.targetId);
      const attached = await browser.sendRaw("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = String(attached.sessionId);

      const attachedBrowser = Object.assign(browser, { sessionId }) as HeadlessBrowser;
      await attachedBrowser.send("Page.enable");
      await attachedBrowser.send("Runtime.enable");
      return attachedBrowser;
    } catch (error) {
      await stopChrome(proc, userDataDir, ws);
      throw error;
    }
  }

  private async sendRaw(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.nextId += 1;
    const id = this.nextId;
    const response = new Promise<Record<string, unknown>>((resolveCmd, rejectCmd) => {
      this.pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
      const payload =
        sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
      this.ws.send(JSON.stringify(payload));
    });
    try {
      return await withDeadline(response, 10_000, `Chrome DevTools command ${method}`);
    } finally {
      this.pending.delete(id);
    }
  }

  public async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.sendRaw(method, params, this.sessionId);
  }

  public async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitFor(
      `document.readyState === "complete" && document.querySelector("#app")?.innerHTML.length > 0`,
    );
  }

  public async evalJs<T = unknown>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails !== undefined) {
      const details = res.exceptionDetails as {
        readonly text?: string;
        readonly exception?: { readonly description?: string };
      };
      throw new Error(
        `Browser eval failed: ${details.exception?.description ?? details.text ?? "unknown"}`,
      );
    }
    const remote = res.result as { readonly value?: T } | undefined;
    return remote?.value as T;
  }

  public async waitFor(predicateJs: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- Poll browser DOM state cleanly until condition holds.
      const matched = await this.evalJs<boolean>(`Boolean(${predicateJs})`);
      if (matched) return;
      // eslint-disable-next-line no-await-in-loop -- Short sleep between DOM state checks.
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 25);
      });
    }
    throw new Error(`Timed out waiting for browser predicate: ${predicateJs}`);
  }

  public async close(): Promise<void> {
    await stopChrome(this.proc, this.userDataDir, this.ws);
  }
}

const encodeShareCode = (code: string): string =>
  encodeURIComponent(Buffer.from(code, "utf8").toString("base64"));

void test(
  "a Chrome startup timeout retries once and cleans up both attempts",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "resultar-fake-chrome-"));
    const executable = join(fixtureDir, "chrome.mjs");
    const startupInfo = `${executable}.startup`;
    const readAttempts = (): { pid: number; profile: string }[] =>
      existsSync(startupInfo)
        ? readFileSync(startupInfo, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as { pid: number; profile: string })
        : [];
    context.after(() => {
      for (const { profile } of readAttempts()) {
        rmSync(profile, { recursive: true, force: true });
      }
      rmSync(fixtureDir, { recursive: true, force: true });
    });
    writeFileSync(
      executable,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const prefix = "--user-data-dir=";
const profile = process.argv.find((arg) => arg.startsWith(prefix)).slice(prefix.length);
appendFileSync(process.argv[1] + ".startup", JSON.stringify({ pid: process.pid, profile }) + "\\n");
setTimeout(() => {}, 10_000);
`,
      { mode: 0o755 },
    );

    await assert.rejects(
      HeadlessBrowser.launch(executable, 2000),
      /Timed out waiting for Chrome DevTools URL/u,
    );
    const attempts = readAttempts();
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]?.profile, attempts[1]?.profile);
    for (const { pid, profile } of attempts) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(existsSync(profile), false);
    }
  },
);

void test("readers can run the single-function example and navigate the tutorial on mobile", async (context) => {
  const url = await startStaticServer(context, distDir);
  const browser = await HeadlessBrowser.launch();
  context.after(async () => {
    await browser.close();
  });
  await browser.navigate(url);
  await browser.evalJs('document.querySelector(".adoption-grid a[href*=playground]").click()');
  await browser.waitFor('document.querySelector("#pg-editor")');
  const displayed = await browser.evalJs<string>('document.querySelector("#pg-editor").value');
  assert.ok(displayed.includes("reserveOne(left).andThen(reserveOne)"));
  const highlightState = await browser.evalJs<{
    readonly hasTokens: boolean;
    readonly text: string;
  }>(`({
    hasTokens: document.querySelectorAll("#pg-highlight .tok-kw, #pg-highlight .tok-str, #pg-highlight .tok-type").length > 0,
    text: document.querySelector("#pg-highlight code")?.textContent ?? "",
  })`);
  assert.equal(highlightState.hasTokens, true);
  assert.equal(highlightState.text.trimEnd(), displayed.trimEnd());
  const liveEdit = await browser.evalJs<{
    readonly hasNum: boolean;
    readonly text: string;
  }>(`(() => {
    const editor = document.querySelector("#pg-editor");
    editor.value = 'const answer = 42;\\n';
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return {
      hasNum: document.querySelector("#pg-highlight .tok-num")?.textContent === "42",
      text: document.querySelector("#pg-highlight code")?.textContent ?? "",
    };
  })()`);
  assert.equal(liveEdit.hasNum, true);
  assert.equal(liveEdit.text, "const answer = 42;\n ");
  await browser.evalJs(`document.querySelector('[data-action="pg-reset"]').click()`);
  assert.equal(await browser.evalJs('document.querySelector("#pg-editor").value'), displayed);
  await browser.evalJs('document.querySelector("#pg-editor").focus()');
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  assert.equal(await browser.evalJs("document.activeElement.dataset.action"), "pg-run");
  await browser.evalJs(`document.querySelector('[data-action="pg-run"]').click()`);
  await browser.waitFor('document.querySelector(".pg-status-ok")');
  assert.deepEqual(
    await browser.evalJs(
      'Array.from(document.querySelectorAll(".pg-output .pg-log"), el => el.textContent.trim())',
    ),
    ["Ok(0)", 'Err("OutOfStock")'],
  );

  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await browser.navigate(url);
  await browser.evalJs(`document.querySelector('[data-install-tab="jsr"]').click()`);
  assert.equal(
    await browser.evalJs(
      "document.documentElement.scrollWidth === document.documentElement.clientWidth",
    ),
    true,
  );
  await browser.evalJs(
    `scrollTo(0, document.body.scrollHeight); document.querySelector('.home-cta a[href="#/playground"]').click()`,
  );
  await browser.waitFor('document.title === "Playground · Resultar" && scrollY === 0');
  await browser.evalJs(
    `document.querySelector(".mobile-menu-btn").click(); document.querySelector('#site-menu a[href="#/docs/api-inventory"]').click()`,
  );
  await browser.waitFor('document.title === "Public API Inventory · Resultar"');
  await browser.navigate(url);
  await browser.evalJs('document.querySelector(".hero-actions a[href*=quickstart]").click()');
  await browser.waitFor('document.querySelector(".doc-prose #your-first-result")');
  assert.equal(
    await browser.evalJs(
      "document.documentElement.scrollWidth <= window.innerWidth && window.innerWidth === 320",
    ),
    true,
  );
  await browser.evalJs('document.querySelector(".compact-toc summary").click()');
  await browser.evalJs(
    "document.querySelector('.compact-toc a[href$=\"#transform-a-successful-value\"]').click()",
  );
  await browser.waitFor('location.hash.endsWith("#transform-a-successful-value")');
  await browser.evalJs('document.querySelector(".doc-pager .next").click()');
  await browser.waitFor('document.querySelector(".doc-prose #compose-a-lazy-workflow")');
  await browser.evalJs('document.querySelector(".mobile-menu-btn").click()');
  assert.equal(
    await browser.evalJs(`document.querySelector('#site-menu [aria-current="page"]').textContent`),
    "Compose a lazy workflow",
  );
  assert.deepEqual(browser.uncaughtExceptions, []);
});

void test("the home page links to the full benchmark report", async (context) => {
  const url = await startStaticServer(context, distDir);
  const browser = await HeadlessBrowser.launch();
  context.after(async () => {
    await browser.close();
  });

  await browser.navigate(url);
  await browser.evalJs(`document.querySelector('[data-action="open-search"]').click()`);
  await browser.waitFor('document.querySelector(".search-item")');
  await browser.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    modifiers: 8,
  });
  assert.equal(
    await browser.evalJs("document.activeElement.matches('.search-item:last-child')"),
    true,
  );
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab" });
  assert.equal(await browser.evalJs("document.activeElement.id"), "search-input");
  const composing = await browser.evalJs<boolean>(`(() => {
    const input = document.querySelector("#search-input");
    input.value = "ResultTask";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    return document.querySelector("#search-input") === input;
  })()`);
  assert.equal(composing, true);
  await browser.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);

  const layoutOverflow = await browser.evalJs<boolean>(
    `document.documentElement.scrollWidth > window.innerWidth`,
  );
  assert.equal(layoutOverflow, false, "Home page must not overflow horizontally");

  const homeHero = await browser.evalJs<{
    readonly h1: string;
    readonly typeBar: string;
    readonly hasResultAsync: boolean;
  }>(`({
    h1: document.querySelector(".hero h1")?.textContent ?? "",
    typeBar: document.querySelector(".hero-type-bar")?.textContent ?? "",
    hasResultAsync: (document.body.textContent ?? "").includes("ResultAsync"),
  })`);
  assert.match(homeHero.h1, /Stop guessing what throws\./u);
  assert.match(homeHero.typeBar, /InvalidAmount \| CardDeclined/u);
  assert.equal(homeHero.hasResultAsync, false);

  await browser.evalJs(`document.querySelector('[data-hero-tab="throw"]').click()`);
  assert.match(
    await browser.evalJs<string>('document.querySelector(".hero-type-bar")?.textContent ?? ""'),
    /2 throws hidden from callers/u,
  );
  await browser.evalJs(`document.querySelector('[data-hero-tab="resultar"]').click()`);
  await browser.evalJs(`document.querySelector('[data-action="hero-run"]').click()`);
  await browser.waitFor('document.querySelector(".hero-run-output .pg-status-ok") !== null');
  assert.match(
    await browser.evalJs<string>('document.querySelector(".hero-run-output")?.textContent ?? ""'),
    /Card declined \(insufficient_funds\)/u,
  );

  const firstExample = await browser.evalJs<string>(
    'document.querySelector(".service-showcase .stack-pane pre").textContent',
  );
  assert.ok(firstExample.includes('service("findStock", {'));
  assert.ok(firstExample.includes("make: () => (sku: string) => {"));
  assert.ok(firstExample.includes("createModule().singleton(FindStock)"));
  assert.ok(firstExample.includes("requestJsonTypeBox({"));
  assert.match(firstExample, /stock\?item=\$\{encodeURIComponent\(sku\)\}/u);
  assert.ok(firstExample.includes('404: () => new RequestError("Unknown SKU", 404)'));
  assert.match(
    firstExample,
    /orElse:\s*\(\) =>\s*new RequestError\("Inventory unavailable", 502\)/u,
  );
  await browser.evalJs('document.querySelector(".stack-source summary").click()');
  for (const [schema, call] of [
    ["TypeBox", "requestJsonTypeBox"],
    ["Type guard", "requestJson"],
    ["Zod", "requestJsonZod"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- Check the independent schema selector in the same session.
    const selected = await browser.evalJs<{
      code: string;
      preview: string;
      framework: string;
      open: boolean;
    }>(`(() => {
      document.querySelector('[data-schema="${schema}"]').click();
      return {
        code: document.querySelector(".service-source code").textContent,
        preview: document.querySelector(".service-showcase .stack-pane pre").textContent,
        framework: document.querySelector('[data-framework][aria-pressed="true"]').textContent,
        open: document.querySelector(".stack-source").open,
      };
    })()`);
    assert.equal(selected.preview, selected.code);
    assert.ok(selected.preview.includes(`import { ${call}, RequestError`));
    assert.ok(selected.code.includes(`return ${call}({`));
    assert.equal(selected.framework, "Fastify");
    assert.ok(selected.open);
  }
  const serviceCode = await browser.evalJs<string>(
    'document.querySelector(".service-source code").textContent',
  );
  assert.ok(serviceCode.includes("make: () => (sku: string) => {"));
  assert.ok(serviceCode.includes("fetch(url, { signal })"));
  for (const [framework, binding, factory] of [
    ["Fastify", "req.services", "createFastifyApp"],
    ["Hono", "c.env", "createHonoApp"],
    ["NestJS", '@Services("findStock")', "createNestApp"],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- Inspect the selected adapter and shared service together.
    const view = await browser.evalJs<{
      service: string;
      route: string;
      preview: string;
      guide: string;
      pressed: string;
    }>(`(() => {
      const selector = '[data-framework="${framework}"]';
      document.querySelector(selector).click();
      return {
        service: document.querySelector(".service-source code").textContent,
        route: document.querySelector(".route-source code").textContent,
        preview: document.querySelector(".service-showcase .stack-pane:last-child pre").textContent,
        guide: document.querySelector(".stack-pane:last-child a").hash,
        pressed: document.querySelector(selector).getAttribute("aria-pressed")
      };
    })()`);
    assert.equal(view.service, serviceCode);
    assert.ok(view.preview.includes('from "./inventory.js"'));
    assert.ok(view.preview.includes(`${factory}({`));
    assert.match(view.preview, /App\(\{\s*services\b/u);
    assert.ok(view.preview.includes(binding));
    assert.ok(view.preview.includes("result.isErr()"));
    assert.ok(view.route.includes(view.preview));
    assert.ok(view.route.includes(".runResult({ signal:"));
    const [packageRoute, anchor] = view.guide.slice("#/docs/".length).split("#");
    assert.equal(packageRoute, `packages/${framework.toLowerCase()}`);
    // eslint-disable-next-line no-await-in-loop -- Verify the existing-app integration guide for the selected framework.
    const adapterPage = await DOC_LOADERS[packageRoute]?.();
    assert.equal(
      adapterPage?.toc.some((heading) => heading.id === anchor),
      true,
      view.guide,
    );
    assert.equal(view.pressed, "true");
  }

  for (const [tab, metric, values] of [
    ["ecosystem", "1.25×", ["22,407", "17,964"]],
    ["create", "1.20×", ["14,351", "12,008"]],
    ["adapters", "83.9%", ["39,267", "46,778"]],
    ["core", "3.67×", ["360,620", "98,243"]],
  ] as const) {
    if (tab !== "ecosystem") {
      // eslint-disable-next-line no-await-in-loop -- Switch workloads in the same browser session.
      await browser.evalJs(`document.querySelector('[data-bench-tab="${tab}"]').click()`);
    }
    // eslint-disable-next-line no-await-in-loop -- Inspect the comparison after each switch.
    const chart = await browser.evalJs<{ metric: string; values: string[]; source: string }>(`({
      metric: document.querySelector(".bench-story strong").textContent,
      values: Array.from(document.querySelectorAll(".bench-series b"), el => el.textContent),
      source: document.querySelector(".bench-footer a").hash
    })`);
    assert.equal(chart.metric, metric);
    assert.deepEqual(chart.values, values);
    const [route, anchor] = chart.source.slice("#/docs/".length).split("#");
    assert.ok(route !== undefined && anchor !== undefined);
    // eslint-disable-next-line no-await-in-loop -- Verify that each source link reaches the measurement.
    const page = await DOC_LOADERS[route]?.();
    assert.ok(page?.toc.some((heading) => heading.id === anchor) === true, chart.source);
  }

  const llmsResponse = await fetch(`${url}/llms.txt`);
  assert.equal(llmsResponse.status, 200);
  assert.match(llmsResponse.headers.get("content-type") ?? "", /text\/plain/u);
  const rootLlms = readFileSync(resolve(websiteDir, "../llms.txt"), "utf8");
  assert.equal(await llmsResponse.text(), rootLlms);

  const llmsAlternate = await browser.evalJs<string | null>(
    `document.querySelector('link[rel="alternate"][type="text/plain"]')?.getAttribute("href") ?? null`,
  );
  assert.equal(llmsAlternate, "./llms.txt");

  for (const [aiTab, expectedText] of [
    ["agents-md", "node_modules/resultar-check/dist/agent/SKILL.md"],
    ["cursor", "resultar-check init --editor cursor"],
    ["cli", "resultar-check overview --project tsconfig.json --json"],
  ] as const) {
    if (aiTab !== "agents-md") {
      // eslint-disable-next-line no-await-in-loop -- Switch AI setup tabs in the same browser session.
      await browser.evalJs(`document.querySelector('[data-ai-tab="${aiTab}"]').click()`);
    }
    // eslint-disable-next-line no-await-in-loop -- Inspect the rendered AI snippet after each switch.
    const aiView = await browser.evalJs<{ readonly code: string; readonly pressed: string | null }>(
      `({
        code: document.querySelector(".ai-code code")?.textContent ?? "",
        pressed: document.querySelector('[data-ai-tab="${aiTab}"]')?.getAttribute("aria-pressed") ?? null,
      })`,
    );
    assert.ok(aiView.code.includes(expectedText), `${aiTab}: ${aiView.code}`);
    assert.equal(aiView.pressed, "true");
  }

  await browser.evalJs(
    `document.querySelector('.nav-links a[href="#/docs/agents/setup"]').click()`,
  );
  await browser.waitFor(`document.querySelector(".doc-prose #ai-coding-agents") !== null`);
  const activeNavLabels = await browser.evalJs<string[]>(
    `Array.from(document.querySelectorAll(".nav-link.active"), (el) => el.textContent?.trim() ?? "")`,
  );
  assert.deepEqual(activeNavLabels, ["AI"]);

  await browser.navigate(url);
  await browser.evalJs(
    `document.querySelector('.nav-links a[href="#/docs/benchmarks/url-shortener"]').click()`,
  );
  await browser.waitFor(`document.querySelector("#abba-averages-2-rounds-per-stack")`);
  const report = await browser.evalJs<string>('document.querySelector(".doc-prose").textContent');
  assert.ok(report.includes("22,407 req/s"));
  assert.deepEqual(browser.uncaughtExceptions, []);
});

void test(
  "real browser verifies shared-link manual run, opaque iframe sandbox isolation, and all production presets",
  { timeout: 90_000 },
  async (context) => {
    const url = await startStaticServer(context, distDir);
    const browser = await HeadlessBrowser.launch();

    try {
      // 1. Direct navigation to a shared link loads editor without auto-executing; Run displays output & spans
      const sharedSnippet = `import { ResultTask, Tracer } from "resultar";
const tracer = Tracer.memory();
await ResultTask.ok("ok").withSpan("shared.op", { origin: "link" }).runExit({ tracer });
console.log("SHARED_DIRECT_RAN", tracer.spans);
`;
      await browser.navigate(`${url}/#/playground?code=${encodeShareCode(sharedSnippet)}`);
      await browser.waitFor(`document.querySelector("#pg-editor") !== null`);

      // Wait briefly to confirm code does NOT auto-execute on page load
      await new Promise<void>((r) => {
        setTimeout(r, 350);
      });
      const directBefore = await browser.evalJs<{
        readonly editor: string;
        readonly output: string;
        readonly hasStatus: boolean;
        readonly waterfallCount: number;
      }>(`({
        editor: document.querySelector("#pg-editor")?.value ?? "",
        output: document.querySelector(".pg-output")?.textContent ?? "",
        hasStatus: document.querySelector(".pg-status-ok, .pg-status-err") !== null,
        waterfallCount: document.querySelectorAll(".span-row").length,
      })`);
      assert.equal(directBefore.editor, sharedSnippet);
      assert.equal(
        directBefore.hasStatus,
        false,
        "Shared link must not auto-execute on direct load",
      );
      assert.equal(directBefore.output.includes("SHARED_DIRECT_RAN"), false);
      assert.equal(directBefore.waterfallCount, 0);

      // Click Run and verify output + span waterfall
      await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
      await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") !== null`);
      const directAfter = await browser.evalJs<{
        readonly passed: boolean;
        readonly output: string;
        readonly spans: readonly string[];
      }>(`({
        passed: document.querySelector(".pg-status-ok") !== null,
        output: document.querySelector(".pg-output")?.textContent ?? "",
        spans: [...document.querySelectorAll(".span-name")].map((el) => el.textContent?.trim() ?? ""),
      })`);
      assert.equal(directAfter.passed, true, `Shared snippet failed: ${directAfter.output}`);
      assert.ok(directAfter.output.includes("SHARED_DIRECT_RAN"));
      assert.deepEqual(directAfter.spans, ["shared.op"]);

      // 2. Hashchange navigation to a shared link ALSO must not auto-execute until Run is clicked
      const hashSnippet = `import { ok } from "resultar";
console.log("HASH_NAV_RAN", ok(777));
`;
      await browser.navigate(`${url}/#/`);
      await browser.waitFor(`document.querySelector(".hero") !== null`);
      await browser.evalJs(
        `globalThis.location.hash = ${JSON.stringify(`#/playground?code=${encodeShareCode(hashSnippet)}`)}`,
      );
      await browser.waitFor(`document.querySelector("#pg-editor") !== null`);
      await new Promise<void>((r) => {
        setTimeout(r, 350);
      });
      const hashBefore = await browser.evalJs<{
        readonly editor: string;
        readonly output: string;
        readonly hasStatus: boolean;
      }>(`({
        editor: document.querySelector("#pg-editor")?.value ?? "",
        output: document.querySelector(".pg-output")?.textContent ?? "",
        hasStatus: document.querySelector(".pg-status-ok, .pg-status-err") !== null,
      })`);
      assert.equal(hashBefore.editor, hashSnippet);
      assert.equal(hashBefore.hasStatus, false, "Shared link must not auto-execute on hashchange");
      assert.equal(hashBefore.output.includes("HASH_NAV_RAN"), false);

      await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
      await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") !== null`);
      const hashAfter = await browser.evalJs<{
        readonly passed: boolean;
        readonly output: string;
      }>(`({
        passed: document.querySelector(".pg-status-ok") !== null,
        output: document.querySelector(".pg-output")?.textContent ?? "",
      })`);
      assert.equal(hashAfter.passed, true, `Hash snippet failed: ${hashAfter.output}`);
      assert.ok(hashAfter.output.includes("HASH_NAV_RAN"));
      assert.ok(hashAfter.output.includes("Ok(777)"));

      // 3. Sandbox isolation: opaque origin blocks portal DOM, storage, and cookie access
      await browser.evalJs(`(() => {
        localStorage.setItem("portal-secret", "do-not-leak");
        sessionStorage.setItem("portal-session", "secret-session");
        document.body.dataset.portalGuard = "intact";
      })()`);
      const isolationSnippet = `const probe = (fn: () => unknown): string => {
  try {
    const val = fn();
    return "LEAKED:" + String(val);
  } catch (e) {
    return "BLOCKED:" + (e instanceof Error ? e.name : String(e));
  }
};
const report = {
  origin: globalThis.origin,
  parentDoc: probe(() => {
    const doc = globalThis.parent.document;
    doc.body.dataset.portalGuard = "mutated";
    return doc.title;
  }),
  topDoc: probe(() => globalThis.top?.document.title),
  localStorage: probe(() => globalThis.localStorage.getItem("portal-secret")),
  sessionStorage: probe(() => globalThis.sessionStorage.getItem("portal-session")),
  cookie: probe(() => document.cookie),
};
console.log("ISOLATION_REPORT=" + JSON.stringify(report));
`;
      await browser.evalJs(
        `globalThis.location.hash = ${JSON.stringify(`#/playground?code=${encodeShareCode(isolationSnippet)}`)}`,
      );
      await browser.waitFor(
        `document.querySelector("#pg-editor")?.value?.includes("ISOLATION_REPORT")`,
      );
      await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
      await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") !== null`);

      const isolationCheck = await browser.evalJs<{
        readonly passed: boolean;
        readonly output: string;
        readonly portalSecret: string | null;
        readonly portalSession: string | null;
        readonly portalGuard: string | undefined;
        readonly remainingIframes: number;
      }>(`({
        passed: document.querySelector(".pg-status-ok") !== null,
        output: document.querySelector(".pg-output")?.textContent ?? "",
        portalSecret: localStorage.getItem("portal-secret"),
        portalSession: sessionStorage.getItem("portal-session"),
        portalGuard: document.body.dataset.portalGuard,
        remainingIframes: document.querySelectorAll("iframe").length,
      })`);
      assert.equal(isolationCheck.passed, true, `Isolation probe failed: ${isolationCheck.output}`);
      const reportMatch = /ISOLATION_REPORT=(\{[^\n]+\})/u.exec(isolationCheck.output);
      assert.ok(
        reportMatch?.[1] !== undefined,
        `Missing isolation report in: ${isolationCheck.output}`,
      );
      const report = JSON.parse(reportMatch[1]) as Record<string, string>;
      assert.equal(report.origin, "null", "Sandbox iframe must run in an opaque origin");
      assert.match(report.parentDoc ?? "", /^BLOCKED:/u);
      assert.match(report.topDoc ?? "", /^BLOCKED:/u);
      assert.match(report.localStorage ?? "", /^BLOCKED:/u);
      assert.match(report.sessionStorage ?? "", /^BLOCKED:/u);
      assert.match(report.cookie ?? "", /^BLOCKED:/u);
      assert.equal(isolationCheck.portalSecret, "do-not-leak");
      assert.equal(isolationCheck.portalSession, "secret-session");
      assert.equal(isolationCheck.portalGuard, "intact");
      assert.equal(isolationCheck.remainingIframes, 0, "Ephemeral sandbox iframe must be removed");

      // 4. Execute all 6 production presets in real Chrome (verifying VirtualClock & observability work without setImmediate)
      for (const preset of PLAYGROUND_PRESETS) {
        // eslint-disable-next-line no-await-in-loop -- Run each preset sequentially for clear diagnostics.
        await browser.evalJs(
          `document.querySelector('[data-preset=${JSON.stringify(preset.id)}]')?.click()`,
        );
        // eslint-disable-next-line no-await-in-loop
        await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") === null`);
        // eslint-disable-next-line no-await-in-loop
        await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
        // eslint-disable-next-line no-await-in-loop
        await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") !== null`);

        // eslint-disable-next-line no-await-in-loop
        const outcome = await browser.evalJs<{
          readonly passed: boolean;
          readonly output: string;
          readonly waterfallTitle: string;
          readonly spanNames: readonly string[];
        }>(`({
          passed: document.querySelector(".pg-status-ok") !== null,
          output: document.querySelector(".pg-output")?.textContent ?? "",
          waterfallTitle: document.querySelector(".waterfall-title")?.textContent ?? "",
          spanNames: [...document.querySelectorAll(".span-name")].map((el) => el.textContent?.trim() ?? ""),
        })`);

        assert.equal(
          outcome.passed,
          true,
          `Preset "${preset.id}" failed in real Chrome:\n${outcome.output}`,
        );
        assert.equal(
          outcome.output.includes("ReferenceError"),
          false,
          `Preset "${preset.id}" hit ReferenceError:\n${outcome.output}`,
        );

        if (preset.id === "result-errors") {
          assert.ok(outcome.output.includes("<redacted:apiKey>"));
        }
        if (preset.id === "task-di") {
          assert.ok(outcome.output.includes("Hello, Ada Lovelace!"));
        }
        if (preset.id === "retry-virtual-clock") {
          assert.ok(
            outcome.output.includes("Virtual elapsed ms: 1350"),
            `Expected 1350ms virtual time in retry preset:\n${outcome.output}`,
          );
        }
        if (preset.id === "concurrency") {
          assert.ok(outcome.output.includes("DELTA"));
        }
        if (preset.id === "observability") {
          assert.ok(outcome.output.includes("Span trace:"));
          assert.ok(
            outcome.waterfallTitle.includes("3 spans"),
            `Expected 3 spans in waterfall title, got: ${outcome.waterfallTitle}`,
          );
          assert.deepEqual(outcome.spanNames, [
            "http.getProfile",
            "↳ db.findUser",
            "↳ cache.loadPermissions",
          ]);
        }
        if (preset.id === "match-enum") {
          assert.ok(outcome.output.includes("shipped via DHL"));
        }
      }

      assert.deepEqual(
        browser.uncaughtExceptions,
        [],
        `Uncaught browser exceptions: ${browser.uncaughtExceptions.join("; ")}`,
      );
    } finally {
      await browser.close();
    }
  },
);

const createDeferred = (): {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
} => {
  let resolveFn: (value: undefined) => void = () => {
    /* replaced immediately by Promise executor */
  };
  const promise = new Promise<undefined>((resolvePromise) => {
    resolveFn = resolvePromise;
  });
  return {
    promise,
    resolve: () => {
      resolveFn(undefined);
    },
  };
};

const isRunnerChunk = (relPath: string): boolean =>
  /^assets\/playground-runner-[^/]+\.js$/u.test(relPath);

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });

const withDeadline = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${String(ms)}ms waiting for ${label}`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

void test(
  "real browser cancels stale initial playground run when hash switches before runner module resolves",
  { timeout: 90_000 },
  async (context) => {
    const runnerRequested = createDeferred();
    const releaseRunner = createDeferred();
    const runnerServed = createDeferred();

    const url = await startStaticServer(context, distDir, {
      beforeServe: async (relPath) => {
        if (isRunnerChunk(relPath)) {
          runnerRequested.resolve();
          await releaseRunner.promise;
        }
      },
      afterServe: (relPath) => {
        if (isRunnerChunk(relPath)) {
          runnerServed.resolve();
        }
      },
    });
    const browser = await HeadlessBrowser.launch();

    try {
      const snippetA = `console.log("STALE_SNIPPET_A_RAN");\n`;
      const snippetB = `import { ok } from "resultar";\nconsole.log("TARGET_SNIPPET_B_RAN", ok(42));\n`;

      await browser.navigate(`${url}/#/playground?code=${encodeShareCode(snippetA)}`);
      await browser.waitFor(
        `document.querySelector("#pg-editor")?.value?.includes("STALE_SNIPPET_A_RAN")`,
      );

      // Observe every sandbox iframe creation, DOM mount, handshake, and execution result directly.
      await browser.evalJs(`(() => {
        const log = { createIframeCount: 0, mountedIframeCount: 0, readyCount: 0, results: [] };
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (tagName, options) {
          if (String(tagName).toLowerCase() === "iframe") {
            log.createIframeCount += 1;
          }
          return originalCreateElement(tagName, options);
        };
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node instanceof HTMLIFrameElement) {
                log.mountedIframeCount += 1;
              }
            }
          }
        });
        observer.observe(document.body, { childList: true });
        globalThis.addEventListener("message", (event) => {
          const data = event.data;
          if (!data || typeof data !== "object") return;
          if (data.type === "ready") {
            log.readyCount += 1;
          } else if (data.type === "result") {
            const logs = Array.isArray(data.result?.logs)
              ? data.result.logs.map((entry) => String(entry?.text ?? "")).join("\\n")
              : "";
            log.results.push({ runId: String(data.runId ?? ""), logs });
          }
        });
        globalThis.__pgDispatchLog = log;
      })()`);

      // Click Run on snippet A while the initial runner module chunk is held open by the server.
      await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
      await withDeadline(runnerRequested.promise, 5000, "initial playground-runner module fetch");

      // Navigate via hash to shared snippet B before the runner module resolves.
      await browser.evalJs(
        `globalThis.location.hash = ${JSON.stringify(`#/playground?code=${encodeShareCode(snippetB)}`)}`,
      );
      await browser.waitFor(
        `document.querySelector("#pg-editor")?.value?.includes("TARGET_SNIPPET_B_RAN")`,
      );

      // Release the runner chunk and allow any errant dispatch/iframe execution to settle.
      releaseRunner.resolve();
      await withDeadline(runnerServed.promise, 5000, "playground-runner response completion");
      await sleep(450);

      const afterStale = await browser.evalJs<{
        readonly createIframeCount: number;
        readonly mountedIframeCount: number;
        readonly readyCount: number;
        readonly results: readonly { readonly runId: string; readonly logs: string }[];
        readonly hasStatus: boolean;
        readonly editor: string;
      }>(`({
        createIframeCount: globalThis.__pgDispatchLog.createIframeCount,
        mountedIframeCount: globalThis.__pgDispatchLog.mountedIframeCount,
        readyCount: globalThis.__pgDispatchLog.readyCount,
        results: globalThis.__pgDispatchLog.results,
        hasStatus: document.querySelector(".pg-status-ok, .pg-status-err") !== null,
        editor: document.querySelector("#pg-editor")?.value ?? "",
      })`);

      assert.equal(afterStale.editor, snippetB);
      assert.equal(
        afterStale.createIframeCount,
        0,
        `Stale run must not dispatch to a sandbox iframe (results=${JSON.stringify(afterStale.results)})`,
      );
      assert.equal(afterStale.mountedIframeCount, 0);
      assert.equal(afterStale.readyCount, 0);
      assert.deepEqual(afterStale.results, []);
      assert.equal(afterStale.hasStatus, false);

      // Now explicitly click Run on B and verify a single dispatch running only snippet B.
      await browser.evalJs(`document.querySelector('[data-action="pg-run"]')?.click()`);
      await browser.waitFor(`document.querySelector(".pg-status-ok, .pg-status-err") !== null`);

      const afterRunB = await browser.evalJs<{
        readonly passed: boolean;
        readonly output: string;
        readonly createIframeCount: number;
        readonly mountedIframeCount: number;
        readonly readyCount: number;
        readonly results: readonly { readonly runId: string; readonly logs: string }[];
      }>(`({
        passed: document.querySelector(".pg-status-ok") !== null,
        output: document.querySelector(".pg-output")?.textContent ?? "",
        createIframeCount: globalThis.__pgDispatchLog.createIframeCount,
        mountedIframeCount: globalThis.__pgDispatchLog.mountedIframeCount,
        readyCount: globalThis.__pgDispatchLog.readyCount,
        results: globalThis.__pgDispatchLog.results,
      })`);

      assert.equal(afterRunB.passed, true, `Snippet B failed: ${afterRunB.output}`);
      assert.equal(afterRunB.createIframeCount, 1);
      assert.equal(afterRunB.mountedIframeCount, 1);
      assert.equal(afterRunB.readyCount, 1);
      assert.equal(afterRunB.results.length, 1);
      assert.equal(afterRunB.results[0]?.logs.includes("TARGET_SNIPPET_B_RAN"), true);
      assert.equal(afterRunB.results[0]?.logs.includes("STALE_SNIPPET_A_RAN"), false);
      assert.ok(afterRunB.output.includes("TARGET_SNIPPET_B_RAN"));
      assert.ok(afterRunB.output.includes("Ok(42)"));
      assert.deepEqual(
        browser.uncaughtExceptions,
        [],
        `Uncaught browser exceptions: ${browser.uncaughtExceptions.join("; ")}`,
      );
    } finally {
      releaseRunner.resolve();
      await browser.close();
    }
  },
);
