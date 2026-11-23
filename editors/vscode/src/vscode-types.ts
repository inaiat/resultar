/**
 * Minimal typed subset of the VS Code / Cursor Extension API used by `resultar-check`.
 * Keeping this self-contained avoids external runtime or `@types/vscode` dependencies while
 * preserving full strict type safety and easy mock-host testing.
 */

export interface VscodeDisposable {
  dispose(): unknown;
}

export interface VscodeUri {
  readonly scheme: string;
  readonly fsPath: string;
  toString(skipEncoding?: boolean): string;
}

export interface VscodePosition {
  readonly line: number;
  readonly character: number;
}

export interface VscodeRange {
  readonly start: VscodePosition;
  readonly end: VscodePosition;
}

export interface VscodeTextDocument {
  readonly uri: VscodeUri;
  readonly languageId: string;
  readonly version: number;
  readonly fileName: string;
  readonly isDirty?: boolean;
  save?(): PromiseLike<boolean>;
  getText(): string;
}

export interface VscodeTextEditor {
  readonly document: VscodeTextDocument;
}

export interface VscodeDiagnostic {
  range: VscodeRange;
  message: string;
  severity?: number;
  code?: string | number;
  source?: string;
}

export interface VscodeDiagnosticCollection extends VscodeDisposable {
  set(uri: VscodeUri, diagnostics: readonly VscodeDiagnostic[] | undefined): void;
  delete(uri: VscodeUri): void;
  clear(): void;
  forEach(callback: (uri: VscodeUri, diagnostics: readonly VscodeDiagnostic[]) => void): void;
}

export interface VscodeMarkdownString {
  value: string;
  isTrusted?: boolean;
}

export interface VscodeHover {
  readonly contents: VscodeMarkdownString;
  readonly range?: VscodeRange;
}

export interface VscodeWorkspaceEdit {
  replace(uri: VscodeUri, range: VscodeRange, newText: string): void;
}

export interface VscodeCodeAction {
  title: string;
  kind?: VscodeCodeActionKind;
  edit?: VscodeWorkspaceEdit;
  isPreferred?: boolean;
  diagnostics?: readonly VscodeDiagnostic[];
}

export interface VscodeCodeActionKind {
  readonly value: string;
}

export interface VscodeCodeActionContext {
  readonly diagnostics: readonly VscodeDiagnostic[];
  readonly only?: VscodeCodeActionKind;
}

export interface VscodeOutputChannel extends VscodeDisposable {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  clear(): void;
}

export interface VscodeStatusBarItem extends VscodeDisposable {
  text: string;
  tooltip?: string;
  command?: string;
  show(): void;
  hide(): void;
}

export interface VscodeWorkspaceFolder {
  readonly uri: VscodeUri;
  readonly name: string;
}

export interface VscodeWorkspaceConfiguration {
  get<Value>(section: string, defaultValue: Value): Value;
}

export interface VscodeFileSystemWatcher extends VscodeDisposable {
  onDidCreate(listener: (uri: VscodeUri) => unknown): VscodeDisposable;
  onDidChange(listener: (uri: VscodeUri) => unknown): VscodeDisposable;
  onDidDelete(listener: (uri: VscodeUri) => unknown): VscodeDisposable;
}

export interface VscodeExtensionContext {
  readonly subscriptions: VscodeDisposable[];
}

export interface VscodeDocumentSelector {
  readonly language: string;
  readonly scheme?: string;
}

export interface VscodeHoverProvider {
  provideHover(
    document: VscodeTextDocument,
    position: VscodePosition,
  ): Promise<VscodeHover | undefined>;
}

export interface VscodeCodeActionProvider {
  provideCodeActions(
    document: VscodeTextDocument,
    range: VscodeRange,
    context: VscodeCodeActionContext,
  ): Promise<readonly VscodeCodeAction[]>;
}

export interface VscodeApi {
  readonly Uri: { file(path: string): VscodeUri; parse(value: string): VscodeUri };
  readonly Position: new (line: number, character: number) => VscodePosition;
  readonly Range: new (start: VscodePosition, end: VscodePosition) => VscodeRange;
  readonly Diagnostic: new (
    range: VscodeRange,
    message: string,
    severity?: number,
  ) => VscodeDiagnostic;
  readonly DiagnosticSeverity: {
    readonly Error: number;
    readonly Warning: number;
    readonly Information: number;
    readonly Hint: number;
  };
  readonly MarkdownString: new (value?: string) => VscodeMarkdownString;
  readonly Hover: new (contents: VscodeMarkdownString, range?: VscodeRange) => VscodeHover;
  readonly WorkspaceEdit: new () => VscodeWorkspaceEdit;
  readonly CodeAction: new (title: string, kind?: VscodeCodeActionKind) => VscodeCodeAction;
  readonly CodeActionKind: {
    readonly QuickFix: VscodeCodeActionKind;
    readonly RefactorRewrite: VscodeCodeActionKind;
  };
  readonly StatusBarAlignment: { readonly Left: number; readonly Right: number };
  readonly workspace: {
    readonly workspaceFolders?: readonly VscodeWorkspaceFolder[];
    readonly textDocuments: readonly VscodeTextDocument[];
    getWorkspaceFolder?(uri: VscodeUri): VscodeWorkspaceFolder | undefined;
    getConfiguration(section: string, scope?: VscodeUri): VscodeWorkspaceConfiguration;
    onDidOpenTextDocument(listener: (doc: VscodeTextDocument) => unknown): VscodeDisposable;
    onDidChangeTextDocument(
      listener: (event: { readonly document: VscodeTextDocument }) => unknown,
    ): VscodeDisposable;
    onDidSaveTextDocument(listener: (doc: VscodeTextDocument) => unknown): VscodeDisposable;
    onDidCloseTextDocument(listener: (doc: VscodeTextDocument) => unknown): VscodeDisposable;
    onDidChangeConfiguration(
      listener: (event: {
        affectsConfiguration(section: string, scope?: VscodeUri): boolean;
      }) => unknown,
    ): VscodeDisposable;
    onDidChangeWorkspaceFolders?(
      listener: (event: {
        readonly added: readonly VscodeWorkspaceFolder[];
        readonly removed: readonly VscodeWorkspaceFolder[];
      }) => unknown,
    ): VscodeDisposable;
    createFileSystemWatcher(globPattern: string): VscodeFileSystemWatcher;
  };
  readonly window: {
    readonly activeTextEditor?: VscodeTextEditor;
    createOutputChannel(name: string): VscodeOutputChannel;
    createStatusBarItem(alignment?: number, priority?: number): VscodeStatusBarItem;
    showInformationMessage(message: string): unknown;
    showWarningMessage(message: string): unknown;
    showErrorMessage(message: string): unknown;
  };
  readonly languages: {
    createDiagnosticCollection(name: string): VscodeDiagnosticCollection;
    registerHoverProvider(
      selector: readonly VscodeDocumentSelector[],
      provider: VscodeHoverProvider,
    ): VscodeDisposable;
    registerCodeActionsProvider(
      selector: readonly VscodeDocumentSelector[],
      provider: VscodeCodeActionProvider,
      metadata?: { readonly providedCodeActionKinds?: readonly VscodeCodeActionKind[] },
    ): VscodeDisposable;
  };
  readonly commands: {
    registerCommand(command: string, callback: () => unknown): VscodeDisposable;
  };
}
