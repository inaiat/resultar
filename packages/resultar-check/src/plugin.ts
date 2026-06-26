import type * as ts from "typescript";

import { getResultarDiagnostics } from "./diagnostics.js";
import { parsePluginOptions } from "./plugin-options.js";

const pluginMarker = "__resultarLanguageServicePlugin";

export const createLanguageServicePlugin = (modules: {
  readonly typescript: typeof ts;
}): ts.server.PluginModule => {
  const tsApi = modules.typescript;

  const create = (info: ts.server.PluginCreateInfo): ts.LanguageService => {
    if ((info.languageService as unknown as Record<string, unknown>)[pluginMarker] === true) {
      return info.languageService;
    }

    const options = parsePluginOptions(info.config);
    const proxy = Object.create(null) as ts.LanguageService & Record<string, unknown>;
    const proxyRecord = proxy as unknown as Record<string, unknown>;
    const serviceRecord = info.languageService as unknown as Record<string, unknown>;
    proxy[pluginMarker] = true;

    for (const key of Object.keys(serviceRecord)) {
      const property = serviceRecord[key];

      if (typeof property === "function") {
        proxyRecord[key] = (...args: readonly unknown[]) =>
          Reflect.apply(property, info.languageService, args) as unknown;
      }
    }

    proxy.getSemanticDiagnostics = (fileName, ...args) => {
      const diagnostics = info.languageService.getSemanticDiagnostics(fileName, ...args);

      const program = info.languageService.getProgram();
      const sourceFile = program?.getSourceFile(fileName);

      if (program === undefined || sourceFile === undefined) {
        return diagnostics;
      }

      return [...diagnostics, ...getResultarDiagnostics({ options, program, sourceFile, tsApi })];
    };

    return proxy;
  };

  return { create };
};
