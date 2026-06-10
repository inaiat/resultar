import { resolve } from "node:path";

import {
  findDiscardedResults,
  type NoDiscardFinding,
  type NoDiscardMode,
  type NoDiscardResult,
} from "./no-discard";
import { normalizeNoDiscardMode } from "./no-discard-core";

interface OxlintLineColumn {
  readonly column: number;
  readonly line: number;
}

interface OxlintDiagnostic {
  readonly loc: OxlintLineColumn;
  readonly message: string;
}

interface OxlintContext {
  readonly cwd: string;
  readonly filename: string;
  readonly options: readonly unknown[];
  readonly physicalFilename: string;
  report(diagnostic: OxlintDiagnostic): void;
}

interface OxlintRule {
  readonly meta: {
    readonly docs: {
      readonly description: string;
      readonly recommended: boolean;
    };
    readonly messages: Record<string, string>;
    readonly schema: readonly unknown[];
    readonly type: "problem";
  };
  createOnce(context: OxlintContext): {
    Program(): void;
  };
}

interface OxlintPlugin {
  readonly meta: { readonly name: "resultar" };
  readonly rules: { readonly "no-discard": OxlintRule };
}

interface RuleOptions {
  readonly mode?: NoDiscardMode;
  readonly project?: string;
}

const defaultProject = "tsconfig.json";
const resultsByProject = new Map<string, NoDiscardResult>();
const reportedProjectFailures = new Set<string>();

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const normalizePath = (cwd: string, fileName: string): string =>
  resolve(cwd, fileName).replace(/\\/g, "/");

const parseRuleOptions = (options: readonly unknown[]): RuleOptions => {
  const firstOption = options[0];

  if (!isRecord(firstOption)) {
    return {};
  }

  const mode = normalizeNoDiscardMode(firstOption.mode);

  if (typeof firstOption.project !== "string") {
    return { mode };
  }

  const project = firstOption.project.trim();

  return project === "" ? { mode } : { mode, project };
};

const getProjectPath = (context: OxlintContext): string => {
  const { project = defaultProject } = parseRuleOptions(context.options);

  return project;
};

const getMode = (context: OxlintContext): NoDiscardMode =>
  normalizeNoDiscardMode(parseRuleOptions(context.options).mode);

const getCacheKey = (cwd: string, project: string, mode: NoDiscardMode): string =>
  `${normalizePath(process.cwd(), cwd)}\0${normalizePath(cwd, project)}\0${mode}`;

const getProjectResult = (context: OxlintContext): readonly [string, NoDiscardResult] => {
  const project = getProjectPath(context);
  const mode = getMode(context);
  const cacheKey = getCacheKey(context.cwd, project, mode);
  const cachedResult = resultsByProject.get(cacheKey);

  if (cachedResult !== undefined) {
    return [cacheKey, cachedResult];
  }

  const result = findDiscardedResults({ mode, project, rootDir: context.cwd });
  resultsByProject.set(cacheKey, result);

  return [cacheKey, result];
};

const getContextFileName = (context: OxlintContext): string =>
  context.physicalFilename === "<text>" ? context.filename : context.physicalFilename;

const isFindingForContextFile = (context: OxlintContext, finding: NoDiscardFinding): boolean =>
  normalizePath(context.cwd, finding.file) ===
  normalizePath(context.cwd, getContextFileName(context));

const formatFindingMessage = (finding: NoDiscardFinding): string => finding.message;

const reportProjectFailure = (
  context: OxlintContext,
  cacheKey: string,
  result: Extract<NoDiscardResult, { readonly ok: false }>,
): void => {
  if (reportedProjectFailures.has(cacheKey)) {
    return;
  }

  reportedProjectFailures.add(cacheKey);
  context.report({
    loc: { column: 0, line: 1 },
    message: `Resultar no-discard check failed: ${result.error.message}`,
  });
};

const reportProjectFindings = (context: OxlintContext): void => {
  const [cacheKey, result] = getProjectResult(context);

  if (!result.ok) {
    reportProjectFailure(context, cacheKey, result);
    return;
  }

  for (const finding of result.findings) {
    if (isFindingForContextFile(context, finding)) {
      context.report({
        loc: { column: Math.max(0, finding.column - 1), line: finding.line },
        message: formatFindingMessage(finding),
      });
    }
  }
};

const noDiscardRule: OxlintRule = {
  meta: {
    docs: {
      description: "Require Resultar Result values to be handled or explicitly discarded.",
      recommended: true,
    },
    messages: {
      ignored: "Ignored Resultar value. Handle it or explicitly discard it with `void`.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          mode: { enum: ["direct", "must-use"], type: "string" },
          project: { type: "string" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
  createOnce(context) {
    return {
      Program() {
        reportProjectFindings(context);
      },
    };
  },
};

const plugin: OxlintPlugin = {
  meta: { name: "resultar" },
  rules: { "no-discard": noDiscardRule },
};

export = plugin;
