import * as resultar from "../../packages/resultar/dist/index.js";
import type { RecordedSpan } from "../../packages/resultar/dist/index.js";

import { transpilePlaygroundTs } from "./ts-strip.js";

export interface PlaygroundLogEntry {
  readonly level: "log" | "info" | "warn" | "error";
  readonly text: string;
}

export interface PlaygroundRunResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly logs: readonly PlaygroundLogEntry[];
  readonly spans: readonly RecordedSpan[];
  readonly error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRecordedSpan = (value: unknown): value is RecordedSpan =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.startTime === "number" &&
  "attributes" in value;

interface ResultLike {
  readonly isOk: () => boolean;
  readonly isErr: () => boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}

const isResultLike = (value: unknown): value is ResultLike =>
  isRecord(value) && typeof value.isOk === "function" && typeof value.isErr === "function";

const formatValue = (value: unknown, depth = 0): string => {
  if (typeof value === "string") {
    return depth === 0 ? value : JSON.stringify(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    const tag = "_tag" in value && typeof value._tag === "string" ? `[${value._tag}] ` : "";
    return `${tag}${value.name}: ${value.message}`;
  }
  if (isResultLike(value)) {
    const okFlag = value.isOk();
    if (okFlag && "value" in value) {
      return `Ok(${formatValue(value.value, depth + 1)})`;
    }
    if (!okFlag && "error" in value) {
      return `Err(${formatValue(value.error, depth + 1)})`;
    }
  }
  if (isRecord(value) && value._tag === "Success" && "value" in value) {
    return `Exit.Success(${formatValue(value.value, depth + 1)})`;
  }
  if (isRecord(value) && value._tag === "Failure" && "cause" in value) {
    const { cause } = value;
    if (resultar.Cause.isCause(cause)) {
      return `Exit.Failure(\n${resultar.Cause.pretty(cause)}\n)`;
    }
  }
  try {
    return JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (val instanceof Error) {
          const serialized: Record<string, unknown> = { name: val.name, message: val.message };
          for (const [prop, propVal] of Object.entries(val)) {
            serialized[prop] = propVal;
          }
          return serialized;
        }
        return val;
      },
      2,
    );
  } catch {
    return "[unserializable]";
  }
};

export const runPlaygroundCode = async (source: string): Promise<PlaygroundRunResult> => {
  const logs: PlaygroundLogEntry[] = [];
  const spans: RecordedSpan[] = [];
  const startedAt = performance.now();

  const captureSpans = (arg: unknown): void => {
    if (Array.isArray(arg) && arg.length > 0 && arg.every((item) => isRecordedSpan(item))) {
      for (const span of arg) {
        spans.push(span);
      }
    } else if (
      isRecord(arg) &&
      Array.isArray(arg.spans) &&
      arg.spans.length > 0 &&
      arg.spans.every((item) => isRecordedSpan(item))
    ) {
      for (const span of arg.spans) {
        spans.push(span);
      }
    }
  };

  const pushLog = (level: PlaygroundLogEntry["level"], args: readonly unknown[]): void => {
    for (const arg of args) {
      captureSpans(arg);
    }
    const text = args.map((arg) => formatValue(arg, 0)).join(" ");
    logs.push({ level, text });
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      pushLog("log", args);
    },
    info: (...args: unknown[]) => {
      pushLog("info", args);
    },
    warn: (...args: unknown[]) => {
      pushLog("warn", args);
    },
    error: (...args: unknown[]) => {
      pushLog("error", args);
    },
  };

  try {
    const jsCode = transpilePlaygroundTs(source);
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Function constructor evaluates sandboxed playground JS.
    const runner = new Function(
      "__resultar",
      "console",
      `"use strict"; return (async () => {\n${jsCode}\n})();`,
    ) as (mod: typeof resultar, con: typeof sandboxConsole) => Promise<void>;
    await runner(resultar, sandboxConsole);

    return { ok: true, durationMs: Math.max(0, performance.now() - startedAt), logs, spans };
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      ok: false,
      durationMs: Math.max(0, performance.now() - startedAt),
      logs,
      spans,
      error: message,
    };
  }
};
