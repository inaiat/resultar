import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const supportedTypeScriptMajor = 6;
const callStart = "/* resultar-lint-patch:start call */";
const callEnd = "/* resultar-lint-patch:end call */";
const helperStart = "/* resultar-lint-patch:start helper */";
const helperEnd = "/* resultar-lint-patch:end helper */";
const diagnosticsNeedle = "  const diagnostics = sortAndDeduplicateDiagnostics(allDiagnostics);";
const patchVersion = "/* resultar-lint-patch:version 3 */";

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
  addRange(allDiagnostics, resultarLanguageServiceDiagnostics(program));
${callEnd}
`;

const helperBlock = `
${helperStart}
${patchVersion}
function resultarLanguageServiceDiagnostics(program) {
  const compilerOptions = program.getCompilerOptions();
  const plugins = compilerOptions && Array.isArray(compilerOptions.plugins) ? compilerOptions.plugins : [];
  const plugin = plugins.find((entry) => entry && entry.name === "resultar-lint");
  if (!plugin) return [];
  const runtimeDiagnostics = resultarLanguageServiceRuntimeDiagnostics(program, plugin);
  if (runtimeDiagnostics) return runtimeDiagnostics;
  return resultarLanguageServiceNoDiscardDiagnostics(program, plugin);
}

function resultarLanguageServiceRuntimeDiagnostics(program, plugin) {
  const runtime = resultarLanguageServiceLoadRuntime();
  if (!runtime || typeof runtime.getProgramResultarDiagnostics !== "function") return void 0;
  const tsApi = resultarLanguageServiceLoadTypeScriptApi();
  if (!tsApi) return void 0;
  try {
    return runtime.getProgramResultarDiagnostics(tsApi, program, plugin);
  } catch (error) {
    return [{
      category: DiagnosticCategory.Error,
      code: 91999,
      messageText: "[resultar/internal] Failed to run Resultar diagnostics: " + (error && error.message ? error.message : String(error)),
      source: "resultar"
    }];
  }
}

function resultarLanguageServiceLoadRuntime() {
  if (typeof require !== "function") return void 0;
  try {
    return require("resultar-lint");
  } catch {
    return void 0;
  }
}

function resultarLanguageServiceLoadTypeScriptApi() {
  if (typeof require !== "function") return void 0;
  try {
    return require("typescript");
  } catch {
    return void 0;
  }
}

function resultarLanguageServiceNoDiscardDiagnostics(program, plugin) {
  if (plugin.noDiscard === "off") return [];
  const mode = plugin.noDiscardMode === "direct" ? "direct" : "must-use";
  const checker = program.getTypeChecker();
  const diagnostics = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (resultarLanguageServiceShouldSkipSourceFile(sourceFile)) continue;
    resultarLanguageServiceInspectSourceFile(checker, sourceFile, diagnostics, mode);
  }
  return diagnostics;
}

function resultarLanguageServiceShouldSkipSourceFile(sourceFile) {
  return sourceFile.isDeclarationFile || /(?:^|[/\\\\])node_modules(?:[/\\\\])/.test(sourceFile.fileName);
}

function resultarLanguageServiceInspectSourceFile(checker, sourceFile, diagnostics, mode) {
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
  if (mode === "must-use") {
    resultarLanguageServiceInspectMustUse(checker, sourceFile, diagnostics);
  }
}

function resultarLanguageServiceInspectMustUse(checker, sourceFile, diagnostics) {
  const trackedResults = resultarLanguageServiceCollectTrackedResults(checker, sourceFile);
  resultarLanguageServiceMarkTrackedResultUses(checker, sourceFile, trackedResults);
  for (const tracked of trackedResults) {
    if (!tracked.handled && !tracked.hasDiscardedResultUse) {
      const start = getTokenPosOfNode(tracked.identifier, sourceFile);
      diagnostics.push({
        category: DiagnosticCategory.Error,
        code: 91001,
        file: sourceFile,
        length: tracked.identifier.end - start,
        messageText: "[resultar/noDiscard] Unhandled " + tracked.typeName + " value assigned to \`" + tracked.name + "\`. Handle it, return it, or explicitly discard it with \`void\`.",
        source: "resultar",
        start
      });
    }
  }
}

function resultarLanguageServiceCollectTrackedResults(checker, sourceFile) {
  const trackedResults = [];
  function visit(node) {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer &&
      resultarLanguageServiceIsCallLikeDiscard(node.initializer)
    ) {
      const type = checker.getTypeAtLocation(node.initializer);
      if (resultarLanguageServiceIsResultLikeType(checker, node.initializer, type)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) {
          trackedResults.push({
            hasDiscardedResultUse: false,
            handled: false,
            identifier: node.name,
            name: resultarLanguageServiceIdentifierText(node.name),
            symbol,
            typeName: checker.typeToString(type, node.initializer, 1)
          });
        }
      }
    }
    forEachChild(node, visit);
  }
  visit(sourceFile);
  return trackedResults;
}

function resultarLanguageServiceMarkTrackedResultUses(checker, sourceFile, trackedResults) {
  function visit(node, ancestors) {
    if (isIdentifier(node)) {
      const tracked = resultarLanguageServiceGetTrackedResult(checker, trackedResults, node);
      if (tracked && node !== tracked.identifier) {
        if (resultarLanguageServiceIsHandledReference(node, ancestors)) {
          tracked.handled = true;
        }
        if (resultarLanguageServiceIsIdentifierInsideDiscardedResultExpression(checker, sourceFile, node, ancestors)) {
          tracked.hasDiscardedResultUse = true;
        }
      }
    }
    forEachChild(node, (child) => visit(child, ancestors.concat(node)));
  }
  visit(sourceFile, []);
}

function resultarLanguageServiceGetTrackedResult(checker, trackedResults, identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol ? trackedResults.find((tracked) => resultarLanguageServiceSymbolsEqual(tracked.symbol, symbol)) : void 0;
}

function resultarLanguageServiceSymbolsEqual(left, right) {
  return left === right || left.valueDeclaration === right.valueDeclaration;
}

function resultarLanguageServiceIsIdentifierInsideDiscardedResultExpression(checker, sourceFile, identifier, ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const current = ancestors[index];
    if (isExpressionStatement(current)) {
      if (
        resultarLanguageServiceIsExplicitDiscard(current.expression) ||
        !resultarLanguageServiceIsCallLikeDiscard(current.expression)
      ) {
        return false;
      }
      const type = checker.getTypeAtLocation(current.expression);
      return resultarLanguageServiceIsResultLikeType(checker, current.expression, type);
    }
  }
  return false;
}

function resultarLanguageServiceIsHandledReference(identifier, ancestors) {
  return resultarLanguageServiceIsReturnedReference(identifier, ancestors) ||
    resultarLanguageServiceIsExplicitDiscardReference(identifier, ancestors) ||
    resultarLanguageServiceIsConsumedByReceiverChain(identifier, ancestors);
}

function resultarLanguageServiceIsReturnedReference(identifier, ancestors) {
  const chain = resultarLanguageServiceGetReferenceChainRoot(identifier, ancestors);
  const parent = chain.parent;
  return Boolean(parent) &&
    ((isReturnStatement(parent) && parent.expression === chain.root) ||
      (isArrowFunction(parent) && parent.body === chain.root));
}

function resultarLanguageServiceIsExplicitDiscardReference(identifier, ancestors) {
  const chain = resultarLanguageServiceGetReferenceChainRoot(identifier, ancestors);
  const parent = chain.parent;
  return Boolean(parent) && isVoidExpression(parent) && parent.expression === chain.root;
}

function resultarLanguageServiceIsConsumedByReceiverChain(identifier, ancestors) {
  let current = identifier;
  let parentIndex = ancestors.length - 1;
  for (;;) {
    const parent = ancestors[parentIndex];
    if (!parent) return false;
    if (resultarLanguageServiceIsWrapperParent(parent, current)) {
      current = parent;
    } else if (isAwaitExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (isPropertyAccessExpression(parent) && parent.expression === current) {
      const methodOrPropertyName = resultarLanguageServiceIdentifierText(parent.name);
      const nextParent = ancestors[parentIndex - 1];
      if (methodOrPropertyName === "error" || methodOrPropertyName === "value") return true;
      if (
        resultarLanguageServiceIsConsumerMethod(methodOrPropertyName) &&
        nextParent &&
        isCallExpression(nextParent) &&
        nextParent.expression === parent
      ) {
        return true;
      }
      current = parent;
    } else if (isCallExpression(parent) && parent.expression === current) {
      current = parent;
    } else {
      return false;
    }
    parentIndex -= 1;
  }
}

function resultarLanguageServiceIsConsumerMethod(name) {
  return name === "_unsafeUnwrap" ||
    name === "_unsafeUnwrapErr" ||
    name === "isErr" ||
    name === "isOk" ||
    name === "match" ||
    name === "matchTags" ||
    name === "matchTagsPartial" ||
    name === "unwrapOr" ||
    name === "unwrapOrThrow";
}

function resultarLanguageServiceIdentifierText(identifier) {
  return String(identifier.escapedText || identifier.text);
}

function resultarLanguageServiceGetReferenceChainRoot(identifier, ancestors) {
  let current = identifier;
  let parentIndex = ancestors.length - 1;
  for (;;) {
    const parent = ancestors[parentIndex];
    if (!parent) return { parent: void 0, root: current };
    if (resultarLanguageServiceIsWrapperParent(parent, current)) {
      current = parent;
    } else if (isAwaitExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (isPropertyAccessExpression(parent) && parent.expression === current) {
      current = parent;
    } else if (isCallExpression(parent) && parent.expression === current) {
      current = parent;
    } else {
      return { parent, root: current };
    }
    parentIndex -= 1;
  }
}

function resultarLanguageServiceIsWrapperParent(parent, child) {
  return (isParenthesizedExpression(parent) && parent.expression === child) ||
    (typeof isAsExpression === "function" && isAsExpression(parent) && parent.expression === child) ||
    (typeof isTypeAssertionExpression === "function" && isTypeAssertionExpression(parent) && parent.expression === child) ||
    (typeof isNonNullExpression === "function" && isNonNullExpression(parent) && parent.expression === child) ||
    (typeof isSatisfiesExpression === "function" && isSatisfiesExpression(parent) && parent.expression === child);
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
  for (;;) {
    if (isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (typeof isAsExpression === "function" && isAsExpression(current)) {
      current = current.expression;
    } else if (typeof isTypeAssertionExpression === "function" && isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (typeof isNonNullExpression === "function" && isNonNullExpression(current)) {
      current = current.expression;
    } else if (typeof isSatisfiesExpression === "function" && isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
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
    return (kind === SyntaxKind.AmpersandAmpersandToken ||
      kind === SyntaxKind.BarBarToken ||
      kind === SyntaxKind.QuestionQuestionToken) &&
      resultarLanguageServiceIsCallLikeDiscard(unwrapped.right);
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
      `resultar-lint patch supports TypeScript ${supportedTypeScriptMajor}.x, found ${version}`,
    );
  }
};

const isPatched = (source: string): boolean =>
  source.includes(callStart) &&
  source.includes(callEnd) &&
  source.includes(helperStart) &&
  source.includes(helperEnd) &&
  source.includes(patchVersion);

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
  removeMarkedBlock(removeMarkedBlock(source, callStart, callEnd), helperStart, helperEnd);

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
