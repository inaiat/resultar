import crossSpawn from "cross-spawn";
import { createRequire } from "node:module";
import { isAbsolute, relative, sep } from "node:path";

import { ResultarLspClient } from "./lsp-client.js";
import {
  extractHoverMarkdown,
  filePathToUri,
  uriToFilePath,
  type LspCodeAction,
  type LspDiagnostic,
  type LspRange,
} from "./lsp-protocol.js";
import { resolveResultarCheckCommand, type ResolvedCommand } from "./resolve-binary.js";
import type {
  VscodeApi,
  VscodeCodeAction,
  VscodeCodeActionContext,
  VscodeDiagnostic,
  VscodeDiagnosticCollection,
  VscodeDocumentSelector,
  VscodeExtensionContext,
  VscodeHover,
  VscodeOutputChannel,
  VscodePosition,
  VscodeRange,
  VscodeStatusBarItem,
  VscodeTextDocument,
  VscodeWorkspaceEdit,
} from "./vscode-types.js";

const SUPPORTED_LANGUAGES = new Set(["typescript", "typescriptreact"]);
const DOCUMENT_SELECTORS: readonly VscodeDocumentSelector[] = [
  { language: "typescript", scheme: "file" },
  { language: "typescriptreact", scheme: "file" },
];

export interface ExtensionController {
  readonly restart: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

const isSupportedDocument = (document: VscodeTextDocument): boolean =>
  document.uri.scheme === "file" && SUPPORTED_LANGUAGES.has(document.languageId);

const toVscodeRange = (api: VscodeApi, range: LspRange): VscodeRange =>
  new api.Range(
    new api.Position(range.start.line, range.start.character),
    new api.Position(range.end.line, range.end.character),
  );

const toLspRange = (range: VscodeRange): LspRange => ({
  start: { line: range.start.line, character: range.start.character },
  end: { line: range.end.line, character: range.end.character },
});

const mapSeverity = (api: VscodeApi, lspSeverity: number | undefined): number => {
  switch (lspSeverity ?? 1) {
    case 1: {
      return api.DiagnosticSeverity.Error;
    }
    case 2: {
      return api.DiagnosticSeverity.Warning;
    }
    case 3: {
      return api.DiagnosticSeverity.Information;
    }
    case 4: {
      return api.DiagnosticSeverity.Hint;
    }
    default: {
      return api.DiagnosticSeverity.Error;
    }
  }
};

export const mapLspDiagnostic = (api: VscodeApi, item: LspDiagnostic): VscodeDiagnostic => {
  const diagnostic = new api.Diagnostic(
    toVscodeRange(api, item.range),
    item.message,
    mapSeverity(api, item.severity),
  );
  if (item.code !== undefined) {
    diagnostic.code = item.code;
  }
  diagnostic.source = item.source ?? "resultar-check";
  return diagnostic;
};

export const mapLspCodeAction = (api: VscodeApi, action: LspCodeAction): VscodeCodeAction => {
  const kind =
    action.kind === "refactor.rewrite"
      ? api.CodeActionKind.RefactorRewrite
      : api.CodeActionKind.QuickFix;
  const description = action.data?.description;
  const title =
    description !== undefined &&
    description.length > 0 &&
    action.data?.kind === "intentional-discard"
      ? `${action.title} — ${description}`
      : action.title;

  const mapped = new api.CodeAction(title, kind);
  // Only mark semantic corrections as preferred; never auto-prefer intentional-discard (`void ...`).
  mapped.isPreferred = action.data?.kind === "correction";

  if (action.edit !== undefined) {
    const workspaceEdit: VscodeWorkspaceEdit = new api.WorkspaceEdit();
    if (action.edit.documentChanges !== undefined) {
      for (const change of action.edit.documentChanges) {
        const uri = api.Uri.file(uriToFilePath(change.textDocument.uri));
        for (const edit of change.edits) {
          workspaceEdit.replace(uri, toVscodeRange(api, edit.range), edit.newText);
        }
      }
    } else if (action.edit.changes !== undefined) {
      for (const [docUri, edits] of Object.entries(action.edit.changes)) {
        const uri = api.Uri.file(uriToFilePath(docUri));
        for (const edit of edits) {
          workspaceEdit.replace(uri, toVscodeRange(api, edit.range), edit.newText);
        }
      }
    }
    mapped.edit = workspaceEdit;
  }
  return mapped;
};

interface CliRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCliCommand = async (
  resolved: ResolvedCommand,
  extraArgs: readonly string[],
  cwd: string,
): Promise<CliRunResult> =>
  new Promise<CliRunResult>((resolveResult) => {
    const child = crossSpawn.spawn(resolved.command, [...resolved.baseArgs, ...extraArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      resolveResult({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });

const updateStatusBar = (
  statusBar: VscodeStatusBarItem,
  diagnostics: VscodeDiagnosticCollection,
): void => {
  let count = 0;
  diagnostics.forEach((_uri, list) => {
    count += list.length;
  });
  statusBar.text = count === 0 ? "$(check) Resultar" : `$(warning) Resultar: ${count}`;
  statusBar.tooltip =
    count === 0
      ? "Resultar Check: no diagnostics"
      : `Resultar Check: ${count} diagnostic${count === 1 ? "" : "s"} — click to view output`;
};

export interface ActivateOptions {
  readonly clientFactory?: (
    command: ResolvedCommand,
    project: string,
    workspaceRoot: string,
    trace: boolean,
    onDiagnostics: (uri: string, items: readonly LspDiagnostic[]) => void,
    onLog: (line: string) => void,
  ) => ResultarLspClient;
}

let activeController: ExtensionController | undefined = undefined;

export const activateWithApi = (
  context: VscodeExtensionContext,
  api: VscodeApi,
  options?: ActivateOptions,
): ExtensionController => {
  const output: VscodeOutputChannel = api.window.createOutputChannel("Resultar Check");
  const diagnostics: VscodeDiagnosticCollection =
    api.languages.createDiagnosticCollection("resultar-check");
  const statusBar: VscodeStatusBarItem = api.window.createStatusBarItem(
    api.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "resultarCheck.showOutput";
  statusBar.text = "$(sync~spin) Resultar";
  statusBar.show();

  let client: ResultarLspClient | undefined = undefined;
  let starting = false;
  let restartPending = false;
  let disposed = false;

  const getWorkspaceRoot = (): string | undefined =>
    api.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const getSettings = () => {
    const cfg = api.workspace.getConfiguration("resultarCheck");
    return {
      enable: cfg.get<boolean>("enable", true),
      project: cfg.get<string>("project", "tsconfig.json"),
      executablePath: cfg.get<string>("executablePath", ""),
      trace: cfg.get<string>("trace", "off") === "messages",
    };
  };

  const resolveCommand = (workspaceRoot: string): ResolvedCommand => {
    const settings = getSettings();
    return resolveResultarCheckCommand({ workspaceRoot, executablePath: settings.executablePath });
  };

  const handlePublishedDiagnostics = (uri: string, items: readonly LspDiagnostic[]): void => {
    const targetUri = api.Uri.file(uriToFilePath(uri));
    if (items.length === 0) {
      diagnostics.delete(targetUri);
    } else {
      diagnostics.set(
        targetUri,
        items.map((item) => mapLspDiagnostic(api, item)),
      );
    }
    updateStatusBar(statusBar, diagnostics);
  };

  const stopClient = async (): Promise<void> => {
    const current = client;
    client = undefined;
    if (current !== undefined) {
      await current.stop();
    }
  };

  const startClient = async (): Promise<void> => {
    if (disposed) return;
    if (starting) {
      restartPending = true;
      return;
    }
    const workspaceRoot = getWorkspaceRoot();
    const settings = getSettings();

    if (!settings.enable || workspaceRoot === undefined) {
      await stopClient();
      diagnostics.clear();
      statusBar.text = "$(circle-slash) Resultar";
      statusBar.tooltip = settings.enable
        ? "Resultar Check: open a workspace folder"
        : "Resultar Check: disabled";
      return;
    }

    starting = true;
    try {
      await stopClient();
      if (disposed) return;
      diagnostics.clear();
      statusBar.text = "$(sync~spin) Resultar";

      const resolved = resolveCommand(workspaceRoot);
      output.appendLine(
        `Starting resultar-check lsp (${resolved.source}): ${resolved.command} ${[...resolved.baseArgs, "lsp", "--project", settings.project].join(" ")}`,
      );

      const nextClient =
        options?.clientFactory?.(
          resolved,
          settings.project,
          workspaceRoot,
          settings.trace,
          handlePublishedDiagnostics,
          (line) => {
            output.appendLine(line);
          },
        ) ??
        new ResultarLspClient({
          command: resolved.command,
          args: [...resolved.baseArgs, "lsp", "--project", settings.project],
          cwd: workspaceRoot,
          trace: settings.trace,
          onDiagnostics: (params) => {
            handlePublishedDiagnostics(params.uri, params.diagnostics);
          },
          onLog: (line) => {
            output.appendLine(line);
          },
          onExit: (code, signal) => {
            if (code !== 0 || signal !== null) {
              statusBar.text = "$(error) Resultar";
              statusBar.tooltip = `Resultar Check exited with ${signal ?? code} — run Restart Language Server`;
            }
          },
        });

      client = nextClient;
      await nextClient.start(workspaceRoot);
      if (disposed || client !== nextClient) return;
      updateStatusBar(statusBar, diagnostics);

      for (const doc of api.workspace.textDocuments) {
        if (isSupportedDocument(doc)) {
          nextClient.didOpen(
            filePathToUri(doc.fileName),
            doc.languageId,
            doc.version,
            doc.getText(),
          );
        }
      }
    } catch (error: unknown) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Failed to start resultar-check lsp: ${message}`);
      statusBar.text = "$(error) Resultar";
      statusBar.tooltip = `Resultar Check failed to start: ${message}`;
      void api.window.showWarningMessage(
        `Resultar Check could not start: ${message}. Install resultar-check or configure resultarCheck.executablePath.`,
      );
    } finally {
      starting = false;
      if (restartPending && !disposed) {
        restartPending = false;
        await startClient();
      }
    }
  };

  const runFix = async (singleFile: boolean): Promise<void> => {
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot === undefined) {
      void api.window.showWarningMessage("Resultar Check: open a workspace folder first.");
      return;
    }
    const settings = getSettings();
    const resolved = resolveCommand(workspaceRoot);
    const args: string[] = ["--fix", "--project", settings.project];

    if (singleFile) {
      const activeDoc = api.window.activeTextEditor?.document;
      if (activeDoc === undefined || !isSupportedDocument(activeDoc)) {
        void api.window.showWarningMessage(
          "Resultar Check: active editor is not a TypeScript file.",
        );
        return;
      }
      args.push("--file", activeDoc.fileName);
    }

    const documents = singleFile
      ? [api.window.activeTextEditor?.document]
      : api.workspace.textDocuments;
    const dirty = documents.filter((doc): doc is VscodeTextDocument => {
      if (doc?.isDirty !== true || !isSupportedDocument(doc)) return false;
      const path = relative(workspaceRoot, doc.fileName);
      return singleFile || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    });
    const saved = await Promise.all(dirty.map(async (doc) => doc.save?.()));
    if (saved.some((ok) => ok !== true)) {
      void api.window.showWarningMessage(
        "Resultar Check: save modified TypeScript files before applying fixes.",
      );
      return;
    }
    output.appendLine(`Running: ${resolved.command} ${[...resolved.baseArgs, ...args].join(" ")}`);
    const result = await runCliCommand(resolved, args, workspaceRoot);
    if (result.stderr.trim().length > 0) {
      output.appendLine(result.stderr.trimEnd());
    }
    const summaryLine =
      result.stderr.split("\n").find((line) => line.startsWith("resultar-check:")) ??
      (result.code === 0
        ? "Resultar Check: no issues found."
        : "Resultar Check: fixes applied; remaining issues logged.");
    void api.window.showInformationMessage(summaryLine);
    client?.didChangeWatchedFiles(filePathToUri(workspaceRoot), 2);
  };

  const showOverview = async (): Promise<void> => {
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot === undefined) {
      return;
    }
    const settings = getSettings();
    const resolved = resolveCommand(workspaceRoot);
    const result = await runCliCommand(
      resolved,
      ["overview", "--project", settings.project],
      workspaceRoot,
    );
    output.clear();
    output.appendLine(`# Resultar Overview (${settings.project})`);
    output.appendLine(
      result.stdout.trim() || result.stderr.trim() || "No exported Resultar items found.",
    );
    output.show(true);
  };

  const hoverProvider = api.languages.registerHoverProvider(DOCUMENT_SELECTORS, {
    async provideHover(
      document: VscodeTextDocument,
      position: VscodePosition,
    ): Promise<VscodeHover | undefined> {
      if (client === undefined || !client.isRunning || !isSupportedDocument(document)) {
        return undefined;
      }
      try {
        const result = await client.hover(filePathToUri(document.fileName), {
          line: position.line,
          character: position.character,
        });
        const markdown = extractHoverMarkdown(result);
        if (markdown === undefined) {
          return undefined;
        }
        const content = new api.MarkdownString(markdown);
        return new api.Hover(
          content,
          result?.range === undefined ? undefined : toVscodeRange(api, result.range),
        );
      } catch {
        return undefined;
      }
    },
  });

  const codeActionProvider = api.languages.registerCodeActionsProvider(
    DOCUMENT_SELECTORS,
    {
      async provideCodeActions(
        document: VscodeTextDocument,
        range: VscodeRange,
        actionContext: VscodeCodeActionContext,
      ): Promise<readonly VscodeCodeAction[]> {
        if (client === undefined || !client.isRunning || !isSupportedDocument(document)) {
          return [];
        }
        try {
          const only = actionContext.only === undefined ? undefined : [actionContext.only.value];
          const actions = await client.codeAction(
            filePathToUri(document.fileName),
            toLspRange(range),
            only,
          );
          return actions.map((action) => mapLspCodeAction(api, action));
        } catch {
          return [];
        }
      },
    },
    { providedCodeActionKinds: [api.CodeActionKind.QuickFix, api.CodeActionKind.RefactorRewrite] },
  );

  const watcher = api.workspace.createFileSystemWatcher("**/*.{ts,tsx,mts,cts,json}");
  const notifyWatched = (uri: { readonly fsPath: string }, kind: 1 | 2 | 3) => {
    client?.didChangeWatchedFiles(filePathToUri(uri.fsPath), kind);
  };

  const controller: ExtensionController = {
    restart: startClient,
    dispose: async () => {
      disposed = true;
      await stopClient();
      diagnostics.dispose();
      statusBar.dispose();
      output.dispose();
    },
  };

  context.subscriptions.push(
    output,
    diagnostics,
    statusBar,
    hoverProvider,
    codeActionProvider,
    watcher,
    watcher.onDidCreate((uri) => {
      notifyWatched(uri, 1);
    }),
    watcher.onDidChange((uri) => {
      notifyWatched(uri, 2);
    }),
    watcher.onDidDelete((uri) => {
      notifyWatched(uri, 3);
    }),
    api.workspace.onDidOpenTextDocument((doc) => {
      if (isSupportedDocument(doc)) {
        client?.didOpen(filePathToUri(doc.fileName), doc.languageId, doc.version, doc.getText());
      }
    }),
    api.workspace.onDidChangeTextDocument((event) => {
      if (isSupportedDocument(event.document)) {
        client?.didChange(
          filePathToUri(event.document.fileName),
          event.document.version,
          event.document.getText(),
        );
      }
    }),
    api.workspace.onDidSaveTextDocument((doc) => {
      if (isSupportedDocument(doc)) {
        client?.didSave(filePathToUri(doc.fileName));
      }
    }),
    api.workspace.onDidCloseTextDocument((doc) => {
      if (isSupportedDocument(doc)) {
        client?.didClose(filePathToUri(doc.fileName));
      }
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("resultarCheck")) {
        void startClient();
      }
    }),
    api.commands.registerCommand("resultarCheck.restart", () => void startClient()),
    api.commands.registerCommand("resultarCheck.fixWorkspace", async () => runFix(false)),
    api.commands.registerCommand("resultarCheck.fixFile", async () => runFix(true)),
    api.commands.registerCommand("resultarCheck.showOverview", () => void showOverview()),
    api.commands.registerCommand("resultarCheck.showOutput", () => {
      output.show(true);
    }),
    {
      dispose: () => {
        void stopClient();
      },
    },
  );

  void startClient();
  return controller;
};

export const activate = (context: VscodeExtensionContext): void => {
  const hostRequire = createRequire(import.meta.url);
  const loaded: unknown = hostRequire("vscode");
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Provided dynamically by the VS Code / Cursor extension host.
  activeController = activateWithApi(context, loaded as VscodeApi);
};

export const deactivate = async (): Promise<void> => {
  const current = activeController;
  activeController = undefined;
  if (current !== undefined) {
    await current.dispose();
  }
};
