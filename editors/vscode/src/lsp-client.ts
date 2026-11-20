import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  filePathToUri,
  isCodeActionArray,
  isHoverResult,
  isInitializeResult,
  isPublishDiagnosticsParams,
  type LspCodeAction,
  type LspHoverResult,
  type LspInitializeResult,
  type LspPosition,
  type LspPublishDiagnosticsParams,
  type LspRange,
} from "./lsp-protocol.js";

export interface LspClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly trace?: boolean;
  readonly requestTimeoutMs?: number;
  readonly onDiagnostics?: (params: LspPublishDiagnosticsParams) => void;
  readonly onLog?: (line: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const HEADER_DELIMITER_CRLF = Buffer.from("\r\n\r\n");
const HEADER_DELIMITER_LF = Buffer.from("\n\n");

export const encodeLspMessage = (payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
};

export const parseContentLength = (headerText: string): number | undefined => {
  for (const line of headerText.split(/\r?\n/u)) {
    const match = /^content-length\s*:\s*(?<length>\d+)\s*$/iu.exec(line);
    if (match?.groups?.length !== undefined) {
      return Math.trunc(Number(match.groups.length));
    }
  }
  return undefined;
};

export class ResultarLspClient {
  readonly #options: LspClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined = undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #stopped = false;

  public constructor(options: LspClientOptions) {
    this.#options = options;
  }

  public get isRunning(): boolean {
    return this.#child !== undefined && !this.#stopped;
  }

  public async start(rootPath: string): Promise<LspInitializeResult> {
    if (this.#child !== undefined) {
      await this.stop();
    }
    this.#stopped = false;
    this.#buffer = Buffer.alloc(0);

    const child = spawn(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.#onStdout(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text.length > 0) {
        this.#options.onLog?.(`[stderr] ${text}`);
      }
    });
    child.on("error", (error: Error) => {
      this.#options.onLog?.(`[error] ${error.message}`);
      this.#rejectAllPending(error);
    });
    child.on("exit", (code, signal) => {
      if (this.#child === child) {
        this.#child = undefined;
      }
      this.#rejectAllPending(
        new Error(`resultar-check lsp exited (code=${String(code)}, signal=${String(signal)})`),
      );
      this.#options.onExit?.(code, signal);
    });

    const rawResult = await this.sendRequest("initialize", {
      processId: process.pid,
      rootPath,
      rootUri: filePathToUri(rootPath),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "refactor.rewrite"] },
            },
          },
          publishDiagnostics: {},
        },
      },
    });
    const result: LspInitializeResult = isInitializeResult(rawResult) ? rawResult : {};

    this.sendNotification("initialized", {});
    return result;
  }

  public didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  public didChange(uri: string, version: number, text: string): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  public didSave(uri: string): void {
    this.sendNotification("textDocument/didSave", { textDocument: { uri } });
  }

  public didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }

  public didChangeWatchedFiles(uri: string, type: 1 | 2 | 3): void {
    this.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri, type }] });
  }

  public async hover(uri: string, position: LspPosition): Promise<LspHoverResult | null> {
    if (!this.isRunning) {
      return null;
    }
    const result = await this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return isHoverResult(result) ? result : null;
  }

  public async codeAction(
    uri: string,
    range: LspRange,
    only?: readonly string[],
  ): Promise<readonly LspCodeAction[]> {
    if (!this.isRunning) {
      return [];
    }
    const result = await this.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: { diagnostics: [], ...(only !== undefined && only.length > 0 ? { only } : {}) },
    });
    return isCodeActionArray(result) ? result : [];
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    const child = this.#child;
    if (child === undefined) {
      return;
    }
    try {
      await this.sendRequest("shutdown", null, 2000);
      this.sendNotification("exit", null);
    } catch {
      // Best-effort shutdown before terminating the child process.
    }
    this.#child = undefined;
    this.#rejectAllPending(new Error("resultar-check lsp stopped"));
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  public sendNotification(method: string, params: unknown): void {
    const child = this.#child;
    if (child === undefined || !child.stdin.writable) {
      return;
    }
    const message = { jsonrpc: "2.0", method, params };
    if (this.#options.trace === true) {
      this.#options.onLog?.(`[->] ${method}`);
    }
    child.stdin.write(encodeLspMessage(message));
  }

  public async sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || !child.stdin.writable) {
      throw new Error(`resultar-check lsp is not running (request: ${method})`);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeout = timeoutMs ?? this.#options.requestTimeoutMs ?? 15_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`resultar-check lsp request "${method}" timed out after ${timeout}ms`));
      }, timeout);
      timer.unref();

      this.#pending.set(id, { method, resolve, reject, timer });
      const message = { jsonrpc: "2.0", id, method, params };
      if (this.#options.trace === true) {
        this.#options.onLog?.(`[-> #${id}] ${method}`);
      }
      child.stdin.write(encodeLspMessage(message));
    });
  }

  #onStdout(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const crlfIndex = this.#buffer.indexOf(HEADER_DELIMITER_CRLF);
      const lfIndex = this.#buffer.indexOf(HEADER_DELIMITER_LF);
      let headerEnd = -1;
      let delimiterLength = 0;

      if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex <= lfIndex)) {
        headerEnd = crlfIndex;
        delimiterLength = HEADER_DELIMITER_CRLF.length;
      } else if (lfIndex !== -1) {
        headerEnd = lfIndex;
        delimiterLength = HEADER_DELIMITER_LF.length;
      }

      if (headerEnd === -1) {
        return;
      }

      const headerText = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = parseContentLength(headerText);
      const bodyStart = headerEnd + delimiterLength;

      if (contentLength === undefined) {
        this.#options.onLog?.(`[protocol] missing Content-Length header`);
        this.#buffer = this.#buffer.subarray(bodyStart);
        continue;
      }

      if (this.#buffer.length < bodyStart + contentLength) {
        return;
      }

      const bodyText = this.#buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
      this.#buffer = this.#buffer.subarray(bodyStart + contentLength);
      this.#handleMessage(bodyText);
    }
  }

  #handleMessage(rawJson: string): void {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(rawJson);
    } catch (error: unknown) {
      this.#options.onLog?.(
        `[protocol] invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const message = parsed as {
      readonly id?: number;
      readonly method?: string;
      readonly params?: unknown;
      readonly result?: unknown;
      readonly error?: { readonly message?: string; readonly code?: number };
    };

    if (typeof message.id === "number" && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (this.#options.trace === true) {
        this.#options.onLog?.(`[<- #${message.id}] ${pending.method}`);
      }
      if (message.error === undefined) {
        pending.resolve(message.result);
      } else {
        pending.reject(
          new Error(message.error.message ?? `LSP error ${String(message.error.code)}`),
        );
      }
      return;
    }

    if (
      message.method === "textDocument/publishDiagnostics" &&
      isPublishDiagnosticsParams(message.params)
    ) {
      if (this.#options.trace === true) {
        this.#options.onLog?.(`[<-] textDocument/publishDiagnostics`);
      }
      this.#options.onDiagnostics?.(message.params);
    }
  }

  #rejectAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}
