import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { activateWithApi, mapLspCodeAction, mapLspDiagnostic } from "../src/extension.js";
import type { ResultarLspClient } from "../src/lsp-client.js";
import { filePathToUri, type LspDiagnostic } from "../src/lsp-protocol.js";
import { resolveResultarCheckCommand } from "../src/resolve-binary.js";
import type {
  VscodeApi,
  VscodeCodeAction,
  VscodeCodeActionProvider,
  VscodeDiagnostic,
  VscodeExtensionContext,
  VscodeHoverProvider,
  VscodePosition,
  VscodeRange,
  VscodeStatusBarItem,
  VscodeUri,
} from "../src/vscode-types.js";

const createMockVscode = () => {
  const diagnosticMap = new Map<string, readonly VscodeDiagnostic[]>();
  const outputLines: string[] = [];
  const infoMessages: string[] = [];
  const commands = new Map<string, () => unknown>();
  let hoverProvider: VscodeHoverProvider | undefined = undefined;
  let codeActionProvider: VscodeCodeActionProvider | undefined = undefined;

  const statusBar: VscodeStatusBarItem = {
    text: "",
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  };

  const makeUri = (fsPath: string): VscodeUri => ({
    scheme: "file",
    fsPath,
    toString: () => filePathToUri(fsPath),
  });

  const api: VscodeApi = {
    Uri: { file: makeUri, parse: (value: string) => makeUri(value) },
    Position: class {
      public readonly line: number;
      public readonly character: number;
      public constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class {
      public readonly start: VscodePosition;
      public readonly end: VscodePosition;
      public constructor(start: VscodePosition, end: VscodePosition) {
        this.start = start;
        this.end = end;
      }
    },
    Diagnostic: class {
      public range: VscodeRange;
      public message: string;
      public severity?: number;
      public code?: string | number;
      public source?: string;
      public constructor(range: VscodeRange, message: string, severity?: number) {
        this.range = range;
        this.message = message;
        if (severity !== undefined) {
          this.severity = severity;
        }
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    MarkdownString: class {
      public value: string;
      public constructor(value = "") {
        this.value = value;
      }
    },
    Hover: class {
      public readonly contents: { value: string };
      public readonly range?: VscodeRange;
      public constructor(contents: { value: string }, range?: VscodeRange) {
        this.contents = contents;
        if (range !== undefined) {
          this.range = range;
        }
      }
    },
    WorkspaceEdit: class {
      public readonly edits: { uri: VscodeUri; range: VscodeRange; newText: string }[] = [];
      public replace(uri: VscodeUri, range: VscodeRange, newText: string): void {
        this.edits.push({ uri, range, newText });
      }
    },
    CodeAction: class {
      public title: string;
      public kind?: { readonly value: string };
      public isPreferred?: boolean;
      public constructor(title: string, kind?: { readonly value: string }) {
        this.title = title;
        if (kind !== undefined) {
          this.kind = kind;
        }
      }
    },
    CodeActionKind: {
      QuickFix: { value: "quickfix" },
      RefactorRewrite: { value: "refactor.rewrite" },
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    workspace: {
      workspaceFolders: [{ uri: makeUri("/workspace"), name: "app" }],
      textDocuments: [],
      getConfiguration: () => ({
        get: <Value>(_key: string, defaultValue: Value): Value => defaultValue,
      }),
      onDidOpenTextDocument: () => ({ dispose: () => undefined }),
      onDidChangeTextDocument: () => ({ dispose: () => undefined }),
      onDidSaveTextDocument: () => ({ dispose: () => undefined }),
      onDidCloseTextDocument: () => ({ dispose: () => undefined }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose: () => undefined }),
        onDidChange: () => ({ dispose: () => undefined }),
        onDidDelete: () => ({ dispose: () => undefined }),
        dispose: () => undefined,
      }),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line: string) => {
          outputLines.push(line);
        },
        show: () => undefined,
        clear: () => {
          outputLines.length = 0;
        },
        dispose: () => undefined,
      }),
      createStatusBarItem: () => statusBar,
      showInformationMessage: (message: string) => {
        infoMessages.push(message);
      },
      showWarningMessage: (message: string) => {
        infoMessages.push(message);
      },
      showErrorMessage: (message: string) => {
        infoMessages.push(message);
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri, list) => {
          if (list === undefined) {
            diagnosticMap.delete(uri.fsPath);
          } else {
            diagnosticMap.set(uri.fsPath, list);
          }
        },
        delete: (uri) => {
          diagnosticMap.delete(uri.fsPath);
        },
        clear: () => {
          diagnosticMap.clear();
        },
        forEach: (cb) => {
          for (const [fsPath, list] of diagnosticMap) {
            cb(makeUri(fsPath), list);
          }
        },
        dispose: () => undefined,
      }),
      registerHoverProvider: (_selector, provider) => {
        hoverProvider = provider;
        return { dispose: () => undefined };
      },
      registerCodeActionsProvider: (_selector, provider) => {
        codeActionProvider = provider;
        return { dispose: () => undefined };
      },
    },
    commands: {
      registerCommand: (name, cb) => {
        commands.set(name, cb);
        return { dispose: () => undefined };
      },
    },
  };

  return {
    api,
    diagnosticMap,
    statusBar,
    outputLines,
    infoMessages,
    commands,
    getHoverProvider: () => hoverProvider,
    getCodeActionProvider: () => codeActionProvider,
  };
};

void test("resolveResultarCheckCommand prefers configured path, then local node_modules, then pnpm, then PATH", () => {
  const configured = resolveResultarCheckCommand({
    workspaceRoot: "/repo/app",
    executablePath: "./bin/custom-check",
    pathExists: () => false,
  });
  assert.equal(configured.source, "configured");
  assert.equal(configured.command, join("/repo/app", "bin/custom-check"));

  const localParent = resolveResultarCheckCommand({
    workspaceRoot: "/repo/packages/web",
    platform: "linux",
    pathExists: (candidate) => candidate === "/repo/node_modules/.bin/resultar-check",
  });
  assert.equal(localParent.source, "local-bin");
  assert.equal(localParent.command, "/repo/node_modules/.bin/resultar-check");

  const pnpmFallback = resolveResultarCheckCommand({
    workspaceRoot: "/repo/app",
    platform: "darwin",
    pathExists: (candidate) => candidate === "/repo/app/pnpm-lock.yaml",
  });
  assert.equal(pnpmFallback.source, "pnpm");
  assert.deepEqual(pnpmFallback.baseArgs, ["exec", "resultar-check"]);

  const pathFallback = resolveResultarCheckCommand({
    workspaceRoot: "/repo/app",
    platform: "win32",
    pathExists: () => false,
  });
  assert.equal(pathFallback.source, "path");
  assert.equal(pathFallback.command, "resultar-check.cmd");
});

void test("mapLspDiagnostic and mapLspCodeAction distinguish correction vs intentional-discard", () => {
  const { api } = createMockVscode();
  const diag = mapLspDiagnostic(api, {
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
    severity: 2,
    code: "prefer-as-void",
    message: "Use asVoid()",
  });
  assert.equal(diag.severity, api.DiagnosticSeverity.Warning);
  assert.equal(diag.code, "prefer-as-void");
  assert.equal(diag.source, "resultar-check");

  const correction: VscodeCodeAction = mapLspCodeAction(api, {
    title: "Replace with asVoid()",
    kind: "quickfix",
    data: { kind: "correction" },
    edit: {
      changes: {
        "file:///workspace/src/a.ts": [
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
            newText: "asVoid()",
          },
        ],
      },
    },
  });
  assert.equal(correction.isPreferred, true);
  assert.equal(correction.title, "Replace with asVoid()");

  const discard: VscodeCodeAction = mapLspCodeAction(api, {
    title: "Intentionally discard this Resultar value",
    kind: "quickfix",
    data: { kind: "intentional-discard", description: "Does not execute a lazy ResultTask." },
  });
  assert.equal(discard.isPreferred, false);
  assert.match(discard.title, /Does not execute a lazy ResultTask/u);
});

void test("activateWithApi wires diagnostics, status bar, hover, code actions, and commands", async () => {
  const mock = createMockVscode();
  const context: VscodeExtensionContext = { subscriptions: [] };
  const holder: { publish?: (uri: string, items: readonly LspDiagnostic[]) => void } = {};

  const fakeClient = {
    isRunning: true,
    start: () => Promise.resolve({ capabilities: { hoverProvider: true } }),
    stop: () => Promise.resolve(undefined),
    didOpen: () => undefined,
    didChange: () => undefined,
    didSave: () => undefined,
    didClose: () => undefined,
    didChangeWatchedFiles: () => undefined,
    hover: () =>
      Promise.resolve({ contents: { kind: "markdown", value: "`T`: `number`\n`E`: `never`" } }),
    codeAction: () =>
      Promise.resolve([
        { title: "Unwrap pipe", kind: "quickfix", data: { kind: "correction" as const } },
      ]),
  } as unknown as ResultarLspClient;

  const controller = activateWithApi(context, mock.api, {
    clientFactory: (_cmd, _proj, _root, _trace, onDiag) => {
      holder.publish = onDiag;
      return fakeClient;
    },
  });

  // Allow microtasks from startClient() to finish.
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, 10);
  });

  assert.ok(mock.commands.has("resultarCheck.restart"));
  assert.ok(mock.commands.has("resultarCheck.fixWorkspace"));
  assert.ok(mock.commands.has("resultarCheck.fixFile"));
  assert.ok(mock.commands.has("resultarCheck.showOverview"));
  assert.equal(mock.statusBar.text, "$(check) Resultar");

  holder.publish?.("file:///workspace/src/a.ts", [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      code: "no-discard",
      message: "Unhandled Result",
    },
  ]);
  assert.equal(mock.diagnosticMap.get("/workspace/src/a.ts")?.length, 1);
  assert.equal(mock.statusBar.text, "$(warning) Resultar: 1");

  const doc = {
    uri: mock.api.Uri.file("/workspace/src/a.ts"),
    languageId: "typescript",
    version: 1,
    fileName: "/workspace/src/a.ts",
    getText: () => "ok(1)",
  };
  let saveAttempts = 0;
  Object.defineProperty(mock.api.workspace, "textDocuments", {
    value: [
      {
        ...doc,
        isDirty: true,
        save: async () => {
          await Promise.resolve();
          saveAttempts += 1;
          return false;
        },
      },
    ],
  });
  await Promise.resolve(mock.commands.get("resultarCheck.fixWorkspace")?.());
  assert.equal(saveAttempts, 1);
  assert.ok(
    mock.infoMessages.some((message) => message.includes("save modified TypeScript files")),
  );
  assert.ok(!mock.outputLines.some((message) => message.startsWith("Running:")));
  const hover = await mock.getHoverProvider()?.provideHover(doc, new mock.api.Position(0, 0));
  assert.ok(hover !== undefined);
  assert.match(hover.contents.value, /`T`: `number`/u);

  const actions = await mock
    .getCodeActionProvider()
    ?.provideCodeActions(
      doc,
      new mock.api.Range(new mock.api.Position(0, 0), new mock.api.Position(0, 5)),
      { diagnostics: [] },
    );
  assert.equal(actions?.length, 1);
  assert.equal(actions?.[0]?.isPreferred, true);

  await controller.dispose();
});
