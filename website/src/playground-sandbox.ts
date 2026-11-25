import * as resultar from "../../packages/resultar/dist/index.js";

import { executePlaygroundInContext } from "./playground-core.js";

interface SandboxRunMessage {
  readonly type: "run";
  readonly runId: string;
  readonly source: string;
}

const isSandboxRunMessage = (value: unknown): value is SandboxRunMessage => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly type?: unknown;
    readonly runId?: unknown;
    readonly source?: unknown;
  };
  return (
    candidate.type === "run" &&
    typeof candidate.runId === "string" &&
    typeof candidate.source === "string"
  );
};

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== globalThis.parent) return;
  if (!isSandboxRunMessage(event.data)) return;
  const { runId, source } = event.data;
  void executePlaygroundInContext(source, resultar).then((result) => {
    globalThis.parent.postMessage({ type: "result", runId, result }, "*");
  });
});

globalThis.parent.postMessage({ type: "ready" }, "*");
