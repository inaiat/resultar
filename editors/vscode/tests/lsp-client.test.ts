import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { encodeLspMessage, parseContentLength, ResultarLspClient } from "../src/lsp-client.js";
import {
  extractHoverMarkdown,
  filePathToUri,
  type LspPublishDiagnosticsParams,
} from "../src/lsp-protocol.js";

const testDir = import.meta.dirname;
const repoRoot = join(testDir, "..", "..", "..");

const nativeBinaryPath = (): string => {
  const target = `${process.platform}-${process.arch}`;
  const binName = process.platform === "win32" ? "resultar-check.exe" : "resultar-check";
  return join(repoRoot, "packages", "check", "native-packages", target, "bin", binName);
};

const createFixtureWorkspace = (): { readonly dir: string; readonly file: string } => {
  const dir = mkdtempSync(join(tmpdir(), "resultar-vscode-lsp-"));
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}\n',
    "node_modules/resultar/package.json":
      '{"name":"resultar","type":"module","types":"index.d.ts"}\n',
    "node_modules/resultar/index.d.ts": `export interface Result<T, E> { readonly value: T; readonly error: E }
export interface ServiceTag<Id extends string, S> { readonly _tag: 'ServiceTag'; readonly identifier: Id; readonly service: S }
export interface ResultTask<A, E = never, R = never> {
  readonly value: A
  readonly error: E
  readonly requirements: R
}
export declare const ResultTask: {
  ok<A>(value: A): ResultTask<A, never, never>
}
export declare function ok<T>(value: T): Result<T, never>
export declare function pipe<A>(value: A): A
`,
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
          plugins: [{ name: "resultar-check", failOn: "suggestion" }],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "src/workflow.ts": `import { ok, pipe, type ResultTask, type ServiceTag } from "resultar"

type UserRepo = ServiceTag<"UserRepo", { readonly find: () => string }>
declare const loadUser: ResultTask<string, Error, UserRepo>

export function runWorkflow() {
  ok(1)
  const wrapped = pipe(loadUser)
  return wrapped
}
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return { dir, file: join(dir, "src", "workflow.ts") };
};

const waitForDiagnostics = async (
  events: readonly LspPublishDiagnosticsParams[],
  predicate: (params: LspPublishDiagnosticsParams) => boolean,
  timeoutMs = 5000,
): Promise<LspPublishDiagnosticsParams> =>
  new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const tick = (): void => {
      const match = events.toReversed().find((item) => predicate(item));
      if (match !== undefined) {
        resolvePromise(match);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        rejectPromise(new Error("Timed out waiting for matching publishDiagnostics notification"));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });

void test("LSP message framing handles multi-byte UTF-8 payloads", () => {
  const payload = { jsonrpc: "2.0", method: "test", params: { text: "olá 🚀 resultar" } };
  const encoded = encodeLspMessage(payload);
  const splitIndex = encoded.indexOf("\r\n\r\n");
  assert.ok(splitIndex > 0);
  const header = encoded.subarray(0, splitIndex).toString("ascii");
  const length = parseContentLength(header);
  const body = encoded.subarray(splitIndex + 4);
  assert.equal(length, body.length);
  assert.deepEqual(JSON.parse(body.toString("utf8")), payload);
});

void test("ResultarLspClient integrates live with native resultar-check lsp (diagnostics, hover, codeAction, unsaved edits)", async () => {
  const binary = nativeBinaryPath();
  assert.equal(
    existsSync(binary),
    true,
    `Expected compiled native binary at ${binary}. Run pnpm --filter resultar-check native:build:current first.`,
  );

  const fixture = createFixtureWorkspace();
  const published: LspPublishDiagnosticsParams[] = [];
  const client = new ResultarLspClient({
    command: binary,
    args: ["lsp", "--project", join(fixture.dir, "tsconfig.json")],
    cwd: fixture.dir,
    onDiagnostics: (params) => {
      published.push(params);
    },
  });

  try {
    const init = await client.start(fixture.dir);
    assert.equal(init.capabilities?.hoverProvider, true);

    const fileUri = filePathToUri(fixture.file);
    const initialSource = `import { ok, pipe, type ResultTask, type ServiceTag } from "resultar"

type UserRepo = ServiceTag<"UserRepo", { readonly find: () => string }>
declare const loadUser: ResultTask<string, Error, UserRepo>

export function runWorkflow() {
  ok(1)
  const wrapped = pipe(loadUser)
  return wrapped
}
`;
    client.didOpen(fileUri, "typescript", 1, initialSource);

    const initialDiags = await waitForDiagnostics(
      published,
      (params) => params.uri === fileUri && params.diagnostics.length >= 2,
    );
    const rules = initialDiags.diagnostics.map((item) => String(item.code));
    assert.ok(rules.includes("no-discard"), `Expected no-discard in ${JSON.stringify(rules)}`);
    assert.ok(
      rules.includes("unnecessary-pipe"),
      `Expected unnecessary-pipe in ${JSON.stringify(rules)}`,
    );

    // Verify hover shows ResultTask T/E/R channels on `loadUser` (line 7, char 25 inside `pipe(loadUser)`).
    const hover = await client.hover(fileUri, { line: 7, character: 25 });
    const markdown = extractHoverMarkdown(hover);
    assert.ok(markdown !== undefined && markdown.length > 0, "Expected non-empty hover markdown");
    assert.match(markdown, /string/u);
    assert.match(markdown, /Error/u);
    assert.match(markdown, /UserRepo/u);

    // Verify codeAction distinguishes safe `correction` from `intentional-discard`.
    const pipeActions = await client.codeAction(fileUri, {
      start: { line: 7, character: 18 },
      end: { line: 7, character: 32 },
    });
    assert.ok(
      pipeActions.some((action) => action.data?.kind === "correction"),
      `Expected a correction codeAction, got ${JSON.stringify(pipeActions)}`,
    );

    const discardActions = await client.codeAction(fileUri, {
      start: { line: 6, character: 2 },
      end: { line: 6, character: 7 },
    });
    assert.ok(
      discardActions.some((action) => action.data?.kind === "intentional-discard"),
      `Expected an intentional-discard codeAction, got ${JSON.stringify(discardActions)}`,
    );

    // Verify unsaved live buffer edit clears all diagnostics without touching disk.
    const cleanSource = `import { type ResultTask, type ServiceTag } from "resultar"

type UserRepo = ServiceTag<"UserRepo", { readonly find: () => string }>
declare const loadUser: ResultTask<string, Error, UserRepo>

export function runWorkflow() {
  return loadUser
}
`;
    const beforeChangeCount = published.length;
    client.didChange(fileUri, 2, cleanSource);

    const cleared = await waitForDiagnostics(
      published,
      (params) =>
        published.indexOf(params) >= beforeChangeCount &&
        params.uri === fileUri &&
        params.diagnostics.length === 0,
    );
    assert.equal(cleared.diagnostics.length, 0);
  } finally {
    await client.stop();
    rmSync(fixture.dir, { force: true, recursive: true });
  }
});

void test("ResultarLspClient handles stdin EPIPE errors without crashing when process exits immediately", async () => {
  const logs: string[] = [];
  const client = new ResultarLspClient({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: process.cwd(),
    requestTimeoutMs: 2000,
    onLog: (line) => {
      logs.push(line);
    },
  });

  await assert.rejects(async () => client.start(process.cwd()));
  // Sending a notification after exit must be a safe no-op, never an unhandled EPIPE.
  assert.doesNotThrow(() => {
    client.sendNotification("textDocument/didSave", { textDocument: { uri: "file:///tmp/x.ts" } });
  });
  await client.stop();
  assert.ok(Array.isArray(logs));
});
