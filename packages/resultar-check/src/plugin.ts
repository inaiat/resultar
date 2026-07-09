import type * as ts from "./typescript-api.js";

import { getResultarDiagnostics } from "./diagnostics.js";
import { parsePluginOptions } from "./plugin-options.js";

const pluginMarker = "__resultarLanguageServicePlugin";

const getObjectProperty = (value: object, property: PropertyKey): unknown =>
  Reflect.get(value, property);

export interface LanguageServiceLike {
  readonly getProgram?: () => ts.Program | undefined;
  getSemanticDiagnostics: (
    fileName: string,
    ...args: readonly unknown[]
  ) => readonly ts.Diagnostic[];
}

export interface PluginCreateInfo {
  readonly config?: unknown;
  readonly languageService: LanguageServiceLike;
}

export interface PluginModule {
  readonly create: (info: PluginCreateInfo) => LanguageServiceLike;
}

export const createLanguageServicePlugin = (modules: {
  readonly typescript: typeof ts;
}): PluginModule => {
  const tsApi = modules.typescript;

  const create = (info: PluginCreateInfo): LanguageServiceLike => {
    if (getObjectProperty(info.languageService, pluginMarker) === true) {
      return info.languageService;
    }

    const options = parsePluginOptions(info.config);
    const proxy: LanguageServiceLike = {
      getSemanticDiagnostics: (fileName: string, ...args: readonly unknown[]) => {
        const diagnostics = info.languageService.getSemanticDiagnostics(fileName, ...args);

        const program = info.languageService.getProgram?.();
        const sourceFile = program?.getSourceFile(fileName);

        if (program === undefined || sourceFile === undefined) {
          return diagnostics;
        }

        return [...diagnostics, ...getResultarDiagnostics({ options, program, sourceFile, tsApi })];
      },
    };

    Object.defineProperty(proxy, pluginMarker, { value: true });

    for (const key of Object.keys(info.languageService)) {
      if (key === "getSemanticDiagnostics") {
        continue;
      }

      const property = getObjectProperty(info.languageService, key);

      if (typeof property === "function") {
        Object.defineProperty(proxy, key, {
          configurable: true,
          enumerable: true,
          value: (...args: readonly unknown[]): unknown => {
            const result: unknown = Reflect.apply(property, info.languageService, args);

            return result;
          },
          writable: true,
        });
      }
    }

    return proxy;
  };

  return { create };
};
