export interface RenderedSection {
  readonly heading: string;
  readonly anchor: string;
  readonly excerpt: string;
}

export interface RenderedTocItem {
  readonly level: number;
  readonly id: string;
  readonly text: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly toc: readonly RenderedTocItem[];
  readonly sections: readonly RenderedSection[];
}

export declare const isPlaygroundCandidate: (code: string, lang: string) => boolean;
export declare const renderInline: (text: string, sourceFileAbs: string) => string;
export declare const renderMarkdown: (
  rawMarkdown: string,
  sourceFileAbs: string,
) => RenderedMarkdown;
