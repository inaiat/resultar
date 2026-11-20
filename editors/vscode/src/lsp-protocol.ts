import { fileURLToPath, pathToFileURL } from "node:url";

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export interface LspPublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

export interface LspHoverResult {
  readonly contents:
    | string
    | { readonly kind: string; readonly value: string }
    | readonly (string | { readonly language: string; readonly value: string })[];
  readonly range?: LspRange;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

export interface LspDocumentEdit {
  readonly textDocument: { readonly uri: string; readonly version?: number | null };
  readonly edits: readonly LspTextEdit[];
}

export interface LspWorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly LspTextEdit[]>>;
  readonly documentChanges?: readonly LspDocumentEdit[];
}

export type LspFixKind = "correction" | "intentional-discard";

export interface LspFixData {
  readonly kind?: LspFixKind;
  readonly description?: string;
}

export interface LspCodeAction {
  readonly title: string;
  readonly kind?: string;
  readonly edit?: LspWorkspaceEdit;
  readonly data?: LspFixData;
}

export interface LspInitializeResult {
  readonly capabilities?: Record<string, unknown>;
}

export const filePathToUri = (filePath: string): string => pathToFileURL(filePath).href;

export const uriToFilePath = (uri: string): string => {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isInitializeResult = (value: unknown): value is LspInitializeResult => isRecord(value);

export const isHoverResult = (value: unknown): value is LspHoverResult =>
  isRecord(value) && "contents" in value;

export const isPublishDiagnosticsParams = (value: unknown): value is LspPublishDiagnosticsParams =>
  isRecord(value) && typeof value.uri === "string" && Array.isArray(value.diagnostics);

export const isCodeActionArray = (value: unknown): value is readonly LspCodeAction[] =>
  Array.isArray(value);

export const extractHoverMarkdown = (hover: LspHoverResult | null): string | undefined => {
  if (hover === null) {
    return undefined;
  }
  const { contents } = hover;
  if (typeof contents === "string") {
    return contents.length > 0 ? contents : undefined;
  }
  if (Array.isArray(contents)) {
    const parts: string[] = [];
    for (const item of contents as readonly unknown[]) {
      if (typeof item === "string") {
        if (item.length > 0) parts.push(item);
      } else if (
        isRecord(item) &&
        typeof item.language === "string" &&
        typeof item.value === "string"
      ) {
        parts.push(`\`\`\`${item.language}\n${item.value}\n\`\`\``);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  if (isRecord(contents) && typeof contents.value === "string") {
    return contents.value.length > 0 ? contents.value : undefined;
  }
  return undefined;
};
