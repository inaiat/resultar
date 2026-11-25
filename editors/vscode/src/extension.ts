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
  VscodeUri,
  VscodeWorkspaceEdit,
  VscodeWorkspaceFolder,
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
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => ResultarLspClient;
}

interface FolderSession {
  readonly root: string;
  folder: VscodeWorkspaceFolder;
  client: ResultarLspClient | undefined;
  readonly publishedUris: Set<string>;
  starting: boolean;
  restartPending: boolean;
  crashed: boolean;
}

const isPathInsideRoot = (root: string, filePath: string): boolean => {
  const rel = relative(root, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

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

  const sessions = new Map<string, FolderSession>();
  let disposed = false;

  const resolveWorkspaceFolder = (uri?: VscodeUri): VscodeWorkspaceFolder | undefined => {
    if (uri !== undefined) {
      const fromHost = api.workspace.getWorkspaceFolder?.(uri);
      if (fromHost !== undefined) {
        return fromHost;
      }
      let bestMatch: VscodeWorkspaceFolder | undefined = undefined;
      for (const folder of api.workspace.workspaceFolders ?? []) {
        if (
          isPathInsideRoot(folder.uri.fsPath, uri.fsPath) &&
          (bestMatch === undefined || folder.uri.fsPath.length > bestMatch.uri.fsPath.length)
        ) {
          bestMatch = folder;
        }
      }
      return bestMatch;
    }
    const activeUri = api.window.activeTextEditor?.document.uri;
    if (activeUri !== undefined) {
      const activeFolder = resolveWorkspaceFolder(activeUri);
      if (activeFolder !== undefined) {
        return activeFolder;
      }
    }
    return api.workspace.workspaceFolders?.[0];
  };

  const getClientForUri = (uri: VscodeUri): ResultarLspClient | undefined => {
    const folder = resolveWorkspaceFolder(uri);
    if (folder === undefined) {
      return undefined;
    }
    return sessions.get(folder.uri.fsPath)?.client;
  };

  const getSettings = (folder?: VscodeWorkspaceFolder) => {
    const cfg = api.workspace.getConfiguration("resultarCheck", folder?.uri);
    return {
      enable: cfg.get<boolean>("enable", true),
      project: cfg.get<string>("project", "tsconfig.json"),
      executablePath: cfg.get<string>("executablePath", ""),
      trace: cfg.get<string>("trace", "off") === "messages",
    };
  };

  const resolveCommand = (
    workspaceRoot: string,
    folder?: VscodeWorkspaceFolder,
  ): ResolvedCommand => {
    const settings = getSettings(folder);
    return resolveResultarCheckCommand({ workspaceRoot, executablePath: settings.executablePath });
  };

  const clearSessionDiagnostics = (session: FolderSession): void => {
    for (const fsPath of session.publishedUris) {
      diagnostics.delete(api.Uri.file(fsPath));
    }
    session.publishedUris.clear();
    if (sessions.size === 0) {
      diagnostics.clear();
    }
  };

  const refreshStatusBar = (): void => {
    const folders = api.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      statusBar.text = "$(circle-slash) Resultar";
      statusBar.tooltip = "Resultar Check: open a workspace folder";
      return;
    }
    for (const session of sessions.values()) {
      if (session.crashed) {
        return;
      }
    }
    const anyEnabled = folders.some((folder) => getSettings(folder).enable);
    if (!anyEnabled) {
      statusBar.text = "$(circle-slash) Resultar";
      statusBar.tooltip = "Resultar Check: disabled";
      return;
    }
    updateStatusBar(statusBar, diagnostics);
  };

  const handlePublishedDiagnostics = (
    session: FolderSession,
    uri: string,
    items: readonly LspDiagnostic[],
  ): void => {
    const fsPath = uriToFilePath(uri);
    const targetUri = api.Uri.file(fsPath);
    if (items.length === 0) {
      session.publishedUris.delete(fsPath);
      diagnostics.delete(targetUri);
    } else {
      session.publishedUris.add(fsPath);
      diagnostics.set(
        targetUri,
        items.map((item) => mapLspDiagnostic(api, item)),
      );
    }
    updateStatusBar(statusBar, diagnostics);
  };

  const stopSessionClient = async (session: FolderSession): Promise<void> => {
    const current = session.client;
    session.client = undefined;
    if (current !== undefined) {
      await current.stop();
    }
  };

  const stopAllClients = async (): Promise<void> => {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      active.map(async (session) => {
        clearSessionDiagnostics(session);
        await stopSessionClient(session);
      }),
    );
  };

  const startFolderClient = async (folder: VscodeWorkspaceFolder): Promise<void> => {
    if (disposed) return;
    const workspaceRoot = folder.uri.fsPath;
    let session = sessions.get(workspaceRoot);
    if (session === undefined) {
      session = {
        root: workspaceRoot,
        folder,
        client: undefined,
        publishedUris: new Set<string>(),
        starting: false,
        restartPending: false,
        crashed: false,
      };
      sessions.set(workspaceRoot, session);
    } else {
      session.folder = folder;
    }

    if (session.starting) {
      session.restartPending = true;
      return;
    }

    const settings = getSettings(folder);
    if (!settings.enable) {
      await stopSessionClient(session);
      session.crashed = false;
      clearSessionDiagnostics(session);
      refreshStatusBar();
      return;
    }

    session.starting = true;
    session.crashed = false;
    try {
      await stopSessionClient(session);
      if (disposed || sessions.get(workspaceRoot) !== session) return;
      clearSessionDiagnostics(session);
      statusBar.text = "$(sync~spin) Resultar";

      const resolved = resolveCommand(workspaceRoot, folder);
      output.appendLine(
        `Starting resultar-check lsp (${resolved.source}): ${resolved.command} ${[...resolved.baseArgs, "lsp", "--project", settings.project].join(" ")}`,
      );

      const activeSession = session;
      const onDiag = (uri: string, items: readonly LspDiagnostic[]): void => {
        if (disposed || sessions.get(workspaceRoot) !== activeSession) return;
        handlePublishedDiagnostics(activeSession, uri, items);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (disposed || sessions.get(workspaceRoot) !== activeSession) return;
        if (code !== 0 || signal !== null) {
          activeSession.crashed = true;
          clearSessionDiagnostics(activeSession);
          statusBar.text = "$(error) Resultar";
          statusBar.tooltip = `Resultar Check exited with ${signal ?? code} — run Restart Language Server`;
        }
      };

      const nextClient =
        options?.clientFactory?.(
          resolved,
          settings.project,
          workspaceRoot,
          settings.trace,
          onDiag,
          (line) => {
            output.appendLine(line);
          },
          onExit,
        ) ??
        new ResultarLspClient({
          command: resolved.command,
          args: [...resolved.baseArgs, "lsp", "--project", settings.project],
          cwd: workspaceRoot,
          trace: settings.trace,
          onDiagnostics: (params) => {
            onDiag(params.uri, params.diagnostics);
          },
          onLog: (line) => {
            output.appendLine(line);
          },
          onExit,
        });

      session.client = nextClient;
      await nextClient.start(workspaceRoot);
      if (disposed || sessions.get(workspaceRoot) !== session || session.client !== nextClient) {
        return;
      }
      refreshStatusBar();

      for (const doc of api.workspace.textDocuments) {
        if (
          isSupportedDocument(doc) &&
          resolveWorkspaceFolder(doc.uri)?.uri.fsPath === workspaceRoot
        ) {
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
      session.starting = false;
      if (session.restartPending && !disposed && sessions.get(workspaceRoot) === session) {
        session.restartPending = false;
        await startFolderClient(session.folder);
      }
    }
  };

  const startAllClients = async (): Promise<void> => {
    if (disposed) return;
    const folders = api.workspace.workspaceFolders ?? [];
    const currentRoots = new Set(folders.map((folder) => folder.uri.fsPath));

    const removedSessions: FolderSession[] = [];
    for (const [root, session] of sessions) {
      if (!currentRoots.has(root)) {
        sessions.delete(root);
        clearSessionDiagnostics(session);
        removedSessions.push(session);
      }
    }
    await Promise.all(removedSessions.map(async (session) => stopSessionClient(session)));

    if (folders.length === 0) {
      diagnostics.clear();
      refreshStatusBar();
      return;
    }

    await Promise.all(folders.map(async (folder) => startFolderClient(folder)));
    if (!disposed) {
      refreshStatusBar();
    }
  };

  const runFix = async (singleFile: boolean): Promise<void> => {
    const activeDoc = api.window.activeTextEditor?.document;
    if (singleFile && (activeDoc === undefined || !isSupportedDocument(activeDoc))) {
      void api.window.showWarningMessage("Resultar Check: active editor is not a TypeScript file.");
      return;
    }

    const folder = singleFile
      ? (resolveWorkspaceFolder(activeDoc?.uri) ?? resolveWorkspaceFolder())
      : resolveWorkspaceFolder();
    const workspaceRoot = folder?.uri.fsPath;
    if (workspaceRoot === undefined) {
      void api.window.showWarningMessage("Resultar Check: open a workspace folder first.");
      return;
    }
    const settings = getSettings(folder);
    const resolved = resolveCommand(workspaceRoot, folder);
    const args: string[] = ["--fix", "--project", settings.project];

    if (singleFile && activeDoc !== undefined) {
      args.push("--file", activeDoc.fileName);
    }

    const documents = singleFile ? [activeDoc] : api.workspace.textDocuments;
    const dirty = documents.filter((doc): doc is VscodeTextDocument => {
      if (doc?.isDirty !== true || !isSupportedDocument(doc)) return false;
      return singleFile || isPathInsideRoot(workspaceRoot, doc.fileName);
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
    sessions.get(workspaceRoot)?.client?.didChangeWatchedFiles(filePathToUri(workspaceRoot), 2);
  };

  const showOverview = async (): Promise<void> => {
    const folder = resolveWorkspaceFolder();
    const workspaceRoot = folder?.uri.fsPath;
    if (workspaceRoot === undefined) {
      return;
    }
    const settings = getSettings(folder);
    const resolved = resolveCommand(workspaceRoot, folder);
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
      const targetClient = getClientForUri(document.uri);
      if (targetClient === undefined || !targetClient.isRunning || !isSupportedDocument(document)) {
        return undefined;
      }
      try {
        const result = await targetClient.hover(filePathToUri(document.fileName), {
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
        const targetClient = getClientForUri(document.uri);
        if (
          targetClient === undefined ||
          !targetClient.isRunning ||
          !isSupportedDocument(document)
        ) {
          return [];
        }
        try {
          const only = actionContext.only === undefined ? undefined : [actionContext.only.value];
          const actions = await targetClient.codeAction(
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
  const notifyWatched = (uri: VscodeUri, kind: 1 | 2 | 3) => {
    const fileUri = filePathToUri(uri.fsPath);
    const targetClient = getClientForUri(uri);
    if (targetClient !== undefined) {
      targetClient.didChangeWatchedFiles(fileUri, kind);
      return;
    }
    for (const session of sessions.values()) {
      session.client?.didChangeWatchedFiles(fileUri, kind);
    }
  };

  const controller: ExtensionController = {
    restart: startAllClients,
    dispose: async () => {
      disposed = true;
      await stopAllClients();
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
        getClientForUri(doc.uri)?.didOpen(
          filePathToUri(doc.fileName),
          doc.languageId,
          doc.version,
          doc.getText(),
        );
      }
    }),
    api.workspace.onDidChangeTextDocument((event) => {
      if (isSupportedDocument(event.document)) {
        getClientForUri(event.document.uri)?.didChange(
          filePathToUri(event.document.fileName),
          event.document.version,
          event.document.getText(),
        );
      }
    }),
    api.workspace.onDidSaveTextDocument((doc) => {
      if (isSupportedDocument(doc)) {
        getClientForUri(doc.uri)?.didSave(filePathToUri(doc.fileName));
      }
    }),
    api.workspace.onDidCloseTextDocument((doc) => {
      if (isSupportedDocument(doc)) {
        getClientForUri(doc.uri)?.didClose(filePathToUri(doc.fileName));
      }
    }),
    api.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("resultarCheck")) {
        void startAllClients();
      }
    }),
    api.commands.registerCommand("resultarCheck.restart", () => void startAllClients()),
    api.commands.registerCommand("resultarCheck.fixWorkspace", async () => runFix(false)),
    api.commands.registerCommand("resultarCheck.fixFile", async () => runFix(true)),
    api.commands.registerCommand("resultarCheck.showOverview", () => void showOverview()),
    api.commands.registerCommand("resultarCheck.showOutput", () => {
      output.show(true);
    }),
    {
      dispose: () => {
        void stopAllClients();
      },
    },
  );

  if (api.workspace.onDidChangeWorkspaceFolders !== undefined) {
    context.subscriptions.push(
      api.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const removed of event.removed) {
          const session = sessions.get(removed.uri.fsPath);
          if (session !== undefined) {
            sessions.delete(removed.uri.fsPath);
            clearSessionDiagnostics(session);
            void stopSessionClient(session);
          }
        }
        for (const added of event.added) {
          void startFolderClient(added);
        }
        refreshStatusBar();
      }),
    );
  }

  void startAllClients();
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
