import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { test } from "node:test";

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
  rootDir: string,
  hooks?: StaticServerHooks,
): Promise<{ readonly server: Server; readonly url: string }> => {
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
  return { server, url: `http://127.0.0.1:${String(address.port)}` };
};

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

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

  public static async launch(): Promise<HeadlessBrowser> {
    const executable = findBrowserExecutable();
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
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const wsUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
      let stderrBuf = "";
      const timer = setTimeout(() => {
        rejectUrl(new Error(`Timed out waiting for Chrome DevTools URL. Stderr:\n${stderrBuf}`));
      }, 15_000);

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

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.addEventListener("open", () => {
        resolveOpen();
      });
      ws.addEventListener("error", () => {
        rejectOpen(new Error(`Failed to open CDP WebSocket at ${wsUrl}`));
      });
    });

    const browser = new HeadlessBrowser(proc, userDataDir, ws, "");
    ws.addEventListener("message", (event) => {
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
  }

  private async sendRaw(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolveCmd, rejectCmd) => {
      this.pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
      const payload =
        sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
      this.ws.send(JSON.stringify(payload));
    });
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
    try {
      this.ws.close();
    } catch {
      /* ignore close errors */
    }
    this.proc.kill("SIGKILL");
    await new Promise<void>((resolveExit) => {
      if (this.proc.exitCode !== null || this.proc.killed) {
        resolveExit();
        return;
      }
      this.proc.once("exit", () => {
        resolveExit();
      });
    });
    rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const encodeShareCode = (code: string): string =>
  encodeURIComponent(Buffer.from(code, "utf8").toString("base64"));

void test("the home page links to the full benchmark report", async (context) => {
  const { server, url } = await startStaticServer(distDir);
  context.after(async () => {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
  });
  const browser = await HeadlessBrowser.launch();
  context.after(async () => {
    await browser.close();
  });

  await browser.navigate(url);
  await browser.evalJs(`document.querySelector('[data-action="open-search"]').click()`);
  const composing = await browser.evalJs<boolean>(`(() => {
    const input = document.querySelector("#search-input");
    input.value = "ResultTask";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    return document.querySelector("#search-input") === input;
  })()`);
  assert.equal(composing, true);
  await browser.evalJs(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);

  await browser.evalJs(
    `document.querySelector('.hero-actions a[href="#/docs/benchmarks"]').click()`,
  );
  await browser.waitFor(`document.querySelector(".doc-prose table") !== null`);
  const headings = await browser.evalJs<string[]>(
    `Array.from(document.querySelectorAll(".doc-prose h2"), (heading) => heading.textContent)`,
  );
  assert.equal(headings.length, 12);
  assert.match(headings[0] ?? "", /v5 versus published 4\.1\.1/u);
  assert.deepEqual(browser.uncaughtExceptions, []);
});

void test(
  "real browser verifies shared-link manual run, opaque iframe sandbox isolation, and all production presets",
  { timeout: 60_000 },
  async () => {
    const { server, url } = await startStaticServer(distDir);
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
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
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
  { timeout: 60_000 },
  async () => {
    const runnerRequested = createDeferred();
    const releaseRunner = createDeferred();
    const runnerServed = createDeferred();

    const { server, url } = await startStaticServer(distDir, {
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
      await browser.close();
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  },
);
