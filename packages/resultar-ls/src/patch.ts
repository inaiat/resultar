import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const supportedTypeScriptMajor = 6;
const callStart = "/* resultar-ls-patch:start call */";
const callEnd = "/* resultar-ls-patch:end call */";
const helperStart = "/* resultar-ls-patch:start helper */";
const helperEnd = "/* resultar-ls-patch:end helper */";
const legacyCallStart = "/* resultar-language-service-patch:start call */";
const legacyCallEnd = "/* resultar-language-service-patch:end call */";
const legacyHelperStart = "/* resultar-language-service-patch:start helper */";
const legacyHelperEnd = "/* resultar-language-service-patch:end helper */";
const diagnosticsNeedle = "  const diagnostics = sortAndDeduplicateDiagnostics(allDiagnostics);";

const moduleFiles = ["lib/_tsc.js", "lib/typescript.js"] as const;

export interface TypeScriptPatchOptions {
  readonly dir?: string;
}

export interface ModulePatchStatus {
  readonly changed: boolean;
  readonly file: string;
  readonly patched: boolean;
}

export interface TypeScriptPatchResult {
  readonly modules: readonly ModulePatchStatus[];
  readonly typescriptVersion: string;
}

const callBlock = `${callStart}
  addRange(allDiagnostics, resultarLanguageServiceNoDiscardDiagnostics(program));
${callEnd}
`;

const helperBlock = `
${helperStart}
function resultarLanguageServiceNoDiscardDiagnostics(program) {
  const compilerOptions = program.getCompilerOptions();
  const plugins = compilerOptions && Array.isArray(compilerOptions.plugins) ? compilerOptions.plugins : [];
  const plugin = plugins.find((entry) => entry && (entry.name === "resultar-ls" || entry.name === "resultar-language-service"));
  if (!plugin || plugin.noDiscard === "off") return [];
  const checker = program.getTypeChecker();
  const diagnostics = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (resultarLanguageServiceShouldSkipSourceFile(sourceFile)) continue;
    resultarLanguageServiceInspectSourceFile(checker, sourceFile, diagnostics);
  }
  return diagnostics;
}

function resultarLanguageServiceShouldSkipSourceFile(sourceFile) {
  return sourceFile.isDeclarationFile || /(?:^|[/\\\\])node_modules(?:[/\\\\])/.test(sourceFile.fileName);
}

function resultarLanguageServiceInspectSourceFile(checker, sourceFile, diagnostics) {
  function visit(node) {
    if (
      isExpressionStatement(node) &&
      !resultarLanguageServiceIsExplicitDiscard(node.expression) &&
      resultarLanguageServiceIsCallLikeDiscard(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node.expression);
      if (resultarLanguageServiceIsResultLikeType(checker, node.expression, type)) {
        const typeName = checker.typeToString(type, node.expression, 1);
        const start = getTokenPosOfNode(node.expression, sourceFile);
        diagnostics.push({
          category: DiagnosticCategory.Error,
          code: 91001,
          file: sourceFile,
          length: node.expression.end - start,
          messageText: "[resultar/noDiscard] Ignored " + typeName + " value. Handle it or explicitly discard it with \`void\`.",
          source: "resultar",
          start
        });
      }
    }
    forEachChild(node, visit);
  }
  visit(sourceFile);
}

function resultarLanguageServiceIsResultLikeType(checker, node, type) {
  if (type.flags & (TypeFlags.Union | TypeFlags.Intersection)) {
    return type.types.some((innerType) => resultarLanguageServiceIsResultLikeType(checker, node, innerType));
  }
  return /\\b(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)\\b/.test(
    checker.typeToString(type, node, 1 | 64)
  );
}

function resultarLanguageServiceUnwrapExpression(expression) {
  let current = expression;
  while (isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function resultarLanguageServiceIsExplicitDiscard(expression) {
  return isVoidExpression(resultarLanguageServiceUnwrapExpression(expression));
}

function resultarLanguageServiceIsCallLikeDiscard(expression) {
  const unwrapped = resultarLanguageServiceUnwrapExpression(expression);
  if (isAwaitExpression(unwrapped)) return resultarLanguageServiceIsCallLikeDiscard(unwrapped.expression);
  if (isCallExpression(unwrapped)) return true;
  if (isConditionalExpression(unwrapped)) {
    return (
      resultarLanguageServiceIsCallLikeDiscard(unwrapped.whenTrue) ||
      resultarLanguageServiceIsCallLikeDiscard(unwrapped.whenFalse)
    );
  }
  if (isBinaryExpression(unwrapped)) {
    const kind = unwrapped.operatorToken.kind;
    return kind === SyntaxKind.AmpersandAmpersandToken ||
      kind === SyntaxKind.BarBarToken ||
      kind === SyntaxKind.QuestionQuestionToken;
  }
  return false;
}
${helperEnd}
`;

const resolveTypeScriptDir = (options: TypeScriptPatchOptions): string => {
  if (options.dir !== undefined) {
    return options.dir;
  }

  const requireFromCwd = createRequire(join(process.cwd(), "package.json"));

  try {
    return dirname(requireFromCwd.resolve("typescript/package.json"));
  } catch {
    throw new Error(
      "Unable to resolve local TypeScript. Install typescript in this project or pass --dir ./node_modules/typescript.",
    );
  }
};

const readPackageVersion = async (dir: string): Promise<string> => {
  const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new TypeError(`Unable to read TypeScript version from ${join(dir, "package.json")}`);
  }

  return packageJson.version;
};

const assertSupportedVersion = (version: string): void => {
  if (!version.startsWith(`${supportedTypeScriptMajor}.`)) {
    throw new Error(
      `resultar-ls patch supports TypeScript ${supportedTypeScriptMajor}.x, found ${version}`,
    );
  }
};

const isPatched = (source: string): boolean =>
  source.includes(callStart) &&
  source.includes(callEnd) &&
  source.includes(helperStart) &&
  source.includes(helperEnd);

const removeMarkedBlock = (source: string, startMarker: string, endMarker: string): string => {
  let nextSource = source;

  for (;;) {
    const start = nextSource.indexOf(startMarker);

    if (start === -1) {
      return nextSource;
    }

    const end = nextSource.indexOf(endMarker, start);

    if (end === -1) {
      throw new Error(`Found ${startMarker} without ${endMarker}`);
    }

    let removeUntil = end + endMarker.length;

    if (nextSource[removeUntil] === "\r" && nextSource[removeUntil + 1] === "\n") {
      removeUntil += 2;
    } else if (nextSource[removeUntil] === "\n") {
      removeUntil += 1;
    }

    nextSource = nextSource.slice(0, start) + nextSource.slice(removeUntil);
  }
};

const removeResultarPatch = (source: string): string =>
  removeMarkedBlock(
    removeMarkedBlock(
      removeMarkedBlock(removeMarkedBlock(source, callStart, callEnd), helperStart, helperEnd),
      legacyCallStart,
      legacyCallEnd,
    ),
    legacyHelperStart,
    legacyHelperEnd,
  );

const patchSource = (source: string): { readonly changed: boolean; readonly source: string } => {
  if (isPatched(source)) {
    return { changed: false, source };
  }

  const cleanSource = removeResultarPatch(source);
  const diagnosticsPosition = cleanSource.indexOf(diagnosticsNeedle);

  if (diagnosticsPosition === -1) {
    throw new Error(`Unable to find TypeScript diagnostics insertion point: ${diagnosticsNeedle}`);
  }

  return {
    changed: true,
    source:
      cleanSource.slice(0, diagnosticsPosition) +
      callBlock +
      cleanSource.slice(diagnosticsPosition) +
      helperBlock,
  };
};

const patchModuleFile = async (file: string): Promise<ModulePatchStatus> => {
  const source = await readFile(file, "utf8");
  const patched = patchSource(source);

  if (patched.changed) {
    await writeFile(file, patched.source);
  }

  return { changed: patched.changed, file, patched: true };
};

const unpatchModuleFile = async (file: string): Promise<ModulePatchStatus> => {
  const source = await readFile(file, "utf8");
  const unpatched = removeResultarPatch(source);
  const changed = unpatched !== source;

  if (changed) {
    await writeFile(file, unpatched);
  }

  return { changed, file, patched: false };
};

export const getTypeScriptPatchStatus = async (
  options: TypeScriptPatchOptions = {},
): Promise<TypeScriptPatchResult> => {
  const dir = resolveTypeScriptDir(options);
  const typescriptVersion = await readPackageVersion(dir);
  const modules = await Promise.all(
    moduleFiles.map(async (moduleFile): Promise<ModulePatchStatus> => {
      const file = join(dir, moduleFile);
      await access(file);
      const source = await readFile(file, "utf8");

      return { changed: false, file, patched: isPatched(source) };
    }),
  );

  return { modules, typescriptVersion };
};

export const patchTypeScriptPackage = async (
  options: TypeScriptPatchOptions = {},
): Promise<TypeScriptPatchResult> => {
  const dir = resolveTypeScriptDir(options);
  const typescriptVersion = await readPackageVersion(dir);
  assertSupportedVersion(typescriptVersion);

  const modules = await Promise.all(
    moduleFiles.map(async (moduleFile) => patchModuleFile(join(dir, moduleFile))),
  );

  return { modules, typescriptVersion };
};

export const unpatchTypeScriptPackage = async (
  options: TypeScriptPatchOptions = {},
): Promise<TypeScriptPatchResult> => {
  const dir = resolveTypeScriptDir(options);
  const typescriptVersion = await readPackageVersion(dir);
  const modules = await Promise.all(
    moduleFiles.map(async (moduleFile) => unpatchModuleFile(join(dir, moduleFile))),
  );

  return { modules, typescriptVersion };
};
