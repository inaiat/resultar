import { parse } from "@babel/parser";

import * as resultarAsync from "../../packages/resultar/dist/async.js";
import * as resultarFunction from "../../packages/resultar/dist/function.js";
import * as resultarMatch from "../../packages/resultar/dist/match.js";
import * as resultarResult from "../../packages/resultar/dist/result.js";
import * as resultarRetry from "../../packages/resultar/dist/retry.js";
import * as resultarTagged from "../../packages/resultar/dist/tagged.js";
import * as resultarTask from "../../packages/resultar/dist/task.js";
import type * as ResultarModule from "../../packages/resultar/dist/index.js";
import type { RecordedSpan, SpanAttributeValue } from "../../packages/resultar/dist/index.js";

import { stripPlaygroundTypes, transpilePlaygroundTs } from "./ts-strip.js";

export interface PlaygroundLogEntry {
  readonly level: "log" | "info" | "warn" | "error";
  readonly text: string;
}

export interface PlaygroundSpan {
  readonly name: string;
  readonly parentName: string | undefined;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
  readonly startTime: number;
  readonly endTime: number | undefined;
  readonly durationMs: number | undefined;
  readonly exit: { readonly _tag: "Success" | "Failure" } | undefined;
}

export interface PlaygroundRunResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly logs: readonly PlaygroundLogEntry[];
  readonly spans: readonly PlaygroundSpan[];
  readonly error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isRecordedSpan = (value: unknown): value is RecordedSpan =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isFiniteNumber(value.startTime) &&
  "attributes" in value;

const sanitizeAttributeValue = (value: unknown): SpanAttributeValue | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return [...value];
    if (value.every((item) => typeof item === "number")) return [...value];
    if (value.every((item) => typeof item === "boolean")) return [...value];
  }
  return undefined;
};

export const sanitizeSpan = (span: RecordedSpan): PlaygroundSpan => {
  const attributes: Record<string, SpanAttributeValue> = {};
  if (isRecord(span.attributes)) {
    for (const [key, value] of Object.entries(span.attributes)) {
      const clean = sanitizeAttributeValue(value);
      if (clean !== undefined) attributes[key] = clean;
    }
  }
  const exitTag =
    isRecord(span.exit) && (span.exit._tag === "Success" || span.exit._tag === "Failure")
      ? span.exit._tag
      : undefined;
  return {
    name: span.name,
    parentName: typeof span.parentName === "string" ? span.parentName : undefined,
    attributes,
    startTime: isFiniteNumber(span.startTime) ? span.startTime : 0,
    endTime: isFiniteNumber(span.endTime) ? span.endTime : undefined,
    durationMs: isFiniteNumber(span.durationMs) ? Math.max(0, span.durationMs) : undefined,
    exit: exitTag === undefined ? undefined : { _tag: exitTag },
  };
};

const SKIP_AST_KEYS = new Set(["loc", "start", "end", "extra"]);

const getRootIdentifierName = (node: unknown): string | undefined => {
  let current = node;
  while (isRecord(current)) {
    if (current.type === "Identifier" && typeof current.name === "string") {
      return current.name;
    }
    if (current.type === "TSQualifiedName") {
      current = current.left;
    } else if (current.type === "MemberExpression") {
      current = current.object;
    } else {
      return undefined;
    }
  }
  return undefined;
};

const collectExpressionIdentifierNames = (node: unknown, target: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectExpressionIdentifierNames(item, target);
    return;
  }
  if (!isRecord(node)) return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    target.add(node.name);
    return;
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    collectExpressionIdentifierNames(node.object, target);
    if (node.computed === true) {
      collectExpressionIdentifierNames(node.property, target);
    }
    return;
  }
  if (node.type === "ObjectProperty") {
    if (node.computed === true) {
      collectExpressionIdentifierNames(node.key, target);
    }
    collectExpressionIdentifierNames(node.value, target);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_AST_KEYS.has(key)) continue;
    if (typeof value === "object" && value !== null) {
      collectExpressionIdentifierNames(value, target);
    }
  }
};

const collectTypeAndDecoratorRefs = (
  root: unknown,
): { readonly typeRefs: ReadonlySet<string>; readonly decoratorRefs: ReadonlySet<string> } => {
  const typeRefs = new Set<string>();
  const decoratorRefs = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "TSTypeReference") {
      const name = getRootIdentifierName(node.typeName);
      if (name !== undefined) typeRefs.add(name);
    } else if (
      node.type === "TSInterfaceHeritage" ||
      node.type === "TSClassImplements" ||
      node.type === "TSExpressionWithTypeArguments"
    ) {
      const name = getRootIdentifierName(node.expression);
      if (name !== undefined) typeRefs.add(name);
    } else if (node.type === "Decorator") {
      collectExpressionIdentifierNames(node.expression, decoratorRefs);
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      if (typeof value === "object" && value !== null) walk(value);
    }
  };
  walk(root);
  return { typeRefs, decoratorRefs };
};

const collectRuntimeImportedLocals = (source: string): ReadonlySet<string> => {
  const stripped = stripPlaygroundTypes(source);
  const { program } = parse(stripped, { sourceType: "module", plugins: ["decorators"] });
  const locals = new Set<string>();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration") continue;
    for (const specifier of node.specifiers) {
      locals.add(specifier.local.name);
    }
  }
  return locals;
};

interface ResultLike {
  readonly isOk: () => boolean;
  readonly isErr: () => boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}

const isResultLike = (value: unknown): value is ResultLike =>
  isRecord(value) && typeof value.isOk === "function" && typeof value.isErr === "function";

const formatValue = (value: unknown, resultar: typeof ResultarModule, depth = 0): string => {
  if (typeof value === "string") {
    return depth === 0 ? value : JSON.stringify(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    const tag = "_tag" in value && typeof value._tag === "string" ? `[${value._tag}] ` : "";
    return `${tag}${value.name}: ${value.message}`;
  }
  if (isResultLike(value)) {
    const okFlag = value.isOk();
    if (okFlag && "value" in value) {
      return `Ok(${formatValue(value.value, resultar, depth + 1)})`;
    }
    if (!okFlag && "error" in value) {
      return `Err(${formatValue(value.error, resultar, depth + 1)})`;
    }
  }
  if (isRecord(value) && value._tag === "Success" && "value" in value) {
    return `Exit.Success(${formatValue(value.value, resultar, depth + 1)})`;
  }
  if (isRecord(value) && value._tag === "Failure" && "cause" in value) {
    const { cause } = value;
    if (resultar.Cause.isCause(cause)) {
      return `Exit.Failure(\n${resultar.Cause.pretty(cause)}\n)`;
    }
  }
  try {
    return JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (val instanceof Error) {
          const serialized: Record<string, unknown> = { name: val.name, message: val.message };
          for (const [prop, propVal] of Object.entries(val)) {
            serialized[prop] = propVal;
          }
          return serialized;
        }
        return val;
      },
      2,
    );
  } catch {
    return "[unserializable]";
  }
};

export const executePlaygroundInContext = async (
  source: string,
  resultar: typeof ResultarModule,
): Promise<PlaygroundRunResult> => {
  const logs: PlaygroundLogEntry[] = [];
  const spans: PlaygroundSpan[] = [];
  const startedAt = performance.now();

  const captureSpans = (arg: unknown): void => {
    if (Array.isArray(arg) && arg.length > 0 && arg.every((item) => isRecordedSpan(item))) {
      for (const span of arg) {
        spans.push(sanitizeSpan(span));
      }
    } else if (
      isRecord(arg) &&
      Array.isArray(arg.spans) &&
      arg.spans.length > 0 &&
      arg.spans.every((item) => isRecordedSpan(item))
    ) {
      for (const span of arg.spans) {
        spans.push(sanitizeSpan(span));
      }
    }
  };

  const pushLog = (level: PlaygroundLogEntry["level"], args: readonly unknown[]): void => {
    for (const arg of args) {
      captureSpans(arg);
    }
    const text = args.map((arg) => formatValue(arg, resultar, 0)).join(" ");
    logs.push({ level, text });
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      pushLog("log", args);
    },
    info: (...args: unknown[]) => {
      pushLog("info", args);
    },
    warn: (...args: unknown[]) => {
      pushLog("warn", args);
    },
    error: (...args: unknown[]) => {
      pushLog("error", args);
    },
  };

  try {
    const modules = new Map<string, object>([
      ["resultar", resultar],
      ["resultar/async", resultarAsync],
      ["resultar/function", resultarFunction],
      ["resultar/match", resultarMatch],
      ["resultar/result", resultarResult],
      ["resultar/retry", resultarRetry],
      ["resultar/tagged", resultarTagged],
      ["resultar/task", resultarTask],
    ]);
    const loadModule = (specifier: string): object => {
      const module = modules.get(specifier);
      if (module !== undefined) return module;
      throw new Error(
        `Playground only supports imports from "resultar" and its public subpaths (found "${specifier}").`,
      );
    };
    // Check bindings before execution, including imports and re-exports.
    const { program } = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "decorators"],
    });
    let importAnalysis:
      | {
          readonly runtimeLocals: ReadonlySet<string>;
          readonly typeRefs: ReadonlySet<string>;
          readonly decoratorRefs: ReadonlySet<string>;
        }
      | undefined = undefined;
    const getImportAnalysis = () => {
      if (importAnalysis === undefined) {
        const { typeRefs, decoratorRefs } = collectTypeAndDecoratorRefs(program);
        importAnalysis = {
          runtimeLocals: collectRuntimeImportedLocals(source),
          typeRefs,
          decoratorRefs,
        };
      }
      return importAnalysis;
    };

    for (const node of program.body) {
      if (node.type === "ImportDeclaration") {
        if (node.importKind === "type") continue;
        const bindings = node.specifiers.filter(
          (binding) => binding.type !== "ImportSpecifier" || binding.importKind !== "type",
        );
        if (bindings.length === 0 && node.specifiers.length > 0) continue;

        const module = loadModule(node.source.value);
        for (const binding of bindings) {
          if (binding.type === "ImportNamespaceSpecifier") continue;
          let name = "default";
          if (binding.type === "ImportSpecifier") {
            name =
              binding.imported.type === "Identifier"
                ? binding.imported.name
                : binding.imported.value;
          }
          if (Object.hasOwn(module, name)) continue;
          const localName = binding.local.name;
          const analysis = getImportAnalysis();
          if (
            !analysis.runtimeLocals.has(localName) &&
            !analysis.decoratorRefs.has(localName) &&
            analysis.typeRefs.has(localName)
          ) {
            continue;
          }
          throw new SyntaxError(
            `Module "${node.source.value}" does not provide an export named "${name}".`,
          );
        }
        continue;
      }

      if (
        node.type === "ExportNamedDeclaration" &&
        node.source !== null &&
        node.source !== undefined
      ) {
        if (node.exportKind === "type") continue;
        const specifiers = node.specifiers.filter(
          (specifier) => specifier.type !== "ExportSpecifier" || specifier.exportKind !== "type",
        );
        if (specifiers.length === 0 && node.specifiers.length > 0) continue;

        const module = loadModule(node.source.value);
        for (const specifier of specifiers) {
          if (specifier.type === "ExportNamespaceSpecifier") continue;
          let name = "default";
          if (specifier.type === "ExportSpecifier") {
            name =
              specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value;
          }
          if (!Object.hasOwn(module, name)) {
            throw new SyntaxError(
              `Module "${node.source.value}" does not provide an export named "${name}".`,
            );
          }
        }
        continue;
      }

      if (node.type === "ExportAllDeclaration") {
        if (node.exportKind === "type") continue;
        loadModule(node.source.value);
      }
    }
    const jsCode = transpilePlaygroundTs(source);
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Function constructor evaluates sandboxed playground JS.
    const runner = new Function(
      "require",
      "exports",
      "console",
      `"use strict"; return (async () => {\n${jsCode}\n})();`,
    ) as (load: typeof loadModule, exports: object, con: typeof sandboxConsole) => Promise<void>;
    await runner(loadModule, {}, sandboxConsole);

    return { ok: true, durationMs: Math.max(0, performance.now() - startedAt), logs, spans };
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      ok: false,
      durationMs: Math.max(0, performance.now() - startedAt),
      logs,
      spans,
      error: message,
    };
  }
};
