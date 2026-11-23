import { gunzipSync } from "fflate";

import { PLAYGROUND_SANDBOX_GZIP_BASE64 } from "./generated/sandbox-bundle.js";
import type { PlaygroundLogEntry, PlaygroundRunResult, PlaygroundSpan } from "./playground-core.js";

export type { PlaygroundLogEntry, PlaygroundRunResult, PlaygroundSpan } from "./playground-core.js";

const SANDBOX_TIMEOUT_MS = 10_000;
let runCounter = 0;
let sandboxSrcdoc: string | undefined = undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLogLevel = (value: unknown): value is PlaygroundLogEntry["level"] =>
  value === "log" || value === "info" || value === "warn" || value === "error";

const parseLogs = (raw: unknown): readonly PlaygroundLogEntry[] => {
  if (!Array.isArray(raw)) return [];
  const entries: PlaygroundLogEntry[] = [];
  for (const item of raw) {
    if (isRecord(item) && isLogLevel(item.level) && typeof item.text === "string") {
      entries.push({ level: item.level, text: item.text });
    }
  }
  return entries;
};

const parseSpans = (raw: unknown): readonly PlaygroundSpan[] => {
  if (!Array.isArray(raw)) return [];
  const spans: PlaygroundSpan[] = [];
  for (const item of raw) {
    if (
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.startTime === "number" &&
      isRecord(item.attributes)
    ) {
      const exitTag =
        isRecord(item.exit) && (item.exit._tag === "Success" || item.exit._tag === "Failure")
          ? item.exit._tag
          : undefined;
      spans.push({
        name: item.name,
        parentName: typeof item.parentName === "string" ? item.parentName : undefined,
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Attributes were sanitized inside the sandbox before postMessage.
        attributes: item.attributes as PlaygroundSpan["attributes"],
        startTime: item.startTime,
        endTime: typeof item.endTime === "number" ? item.endTime : undefined,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        exit: exitTag === undefined ? undefined : { _tag: exitTag },
      });
    }
  }
  return spans;
};

const parseRunResult = (raw: unknown, fallbackDurationMs: number): PlaygroundRunResult => {
  if (!isRecord(raw)) {
    return {
      ok: false,
      durationMs: fallbackDurationMs,
      logs: [],
      spans: [],
      error: "Sandbox returned an invalid execution payload.",
    };
  }
  const ok = raw.ok === true;
  const durationMs =
    typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
      ? Math.max(0, raw.durationMs)
      : fallbackDurationMs;
  const logs = parseLogs(raw.logs);
  const spans = parseSpans(raw.spans);
  const error = typeof raw.error === "string" ? raw.error : undefined;
  return error === undefined
    ? { ok, durationMs, logs, spans }
    : { ok, durationMs, logs, spans, error };
};

const buildSandboxSrcdoc = (): string => {
  if (sandboxSrcdoc !== undefined) return sandboxSrcdoc;
  const compressed = Uint8Array.from(
    atob(PLAYGROUND_SANDBOX_GZIP_BASE64),
    (char) => char.codePointAt(0) ?? 0,
  );
  const script = new TextDecoder().decode(gunzipSync(compressed));
  const safeScript = script.replaceAll("</script", String.raw`<\/script`);
  sandboxSrcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';"></head><body><script>${safeScript}</script></body></html>`;
  return sandboxSrcdoc;
};

export const runPlaygroundCode = async (source: string): Promise<PlaygroundRunResult> =>
  new Promise<PlaygroundRunResult>((resolve) => {
    const startedAt = performance.now();
    runCounter += 1;
    const runId = `pg-${String(runCounter)}-${String(Date.now())}`;
    const iframe = document.createElement("iframe");
    // Opaque origin sandbox: omit allow-same-origin so user code cannot touch portal DOM or storage.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.display = "none";

    let settled = false;
    let dispatched = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      globalThis.removeEventListener("message", onMessage);
      iframe.remove();
    };

    const finish = (result: PlaygroundRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframe.contentWindow || !isRecord(event.data)) return;
      if (event.data.type === "ready" && !dispatched) {
        dispatched = true;
        iframe.contentWindow?.postMessage({ type: "run", runId, source }, "*");
        return;
      }
      if (event.data.type === "result" && event.data.runId === runId) {
        const elapsedMs = Math.max(0, performance.now() - startedAt);
        finish(parseRunResult(event.data.result, elapsedMs));
      }
    };

    timeoutId = setTimeout(() => {
      finish({
        ok: false,
        durationMs: Math.max(0, performance.now() - startedAt),
        logs: [],
        spans: [],
        error: `Playground execution timed out after ${String(SANDBOX_TIMEOUT_MS)}ms`,
      });
    }, SANDBOX_TIMEOUT_MS);

    globalThis.addEventListener("message", onMessage);
    iframe.srcdoc = buildSandboxSrcdoc();
    document.body.append(iframe);
  });
