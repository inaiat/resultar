import { deepEqual, equal } from "node:assert";

import { describe, it } from "vite-plus/test";
import * as ts from "typescript";

import { createLanguageServicePlugin } from "../src/plugin.js";

describe("Resultar TypeScript language-service plugin", () => {
  it("returns an already wrapped language service unchanged", () => {
    const plugin = createLanguageServicePlugin({ typescript: ts });
    const languageService = {
      __resultarLanguageServicePlugin: true,
    } as unknown as ts.LanguageService;

    equal(plugin.create({ languageService } as ts.server.PluginCreateInfo), languageService);
  });

  it("binds proxied methods and preserves diagnostics when program data is unavailable", () => {
    const plugin = createLanguageServicePlugin({ typescript: ts });
    const baseDiagnostics = [
      {
        category: ts.DiagnosticCategory.Warning,
        code: 123,
        file: undefined,
        length: 1,
        messageText: "base diagnostic",
        start: 0,
      },
    ] satisfies ts.Diagnostic[];
    const languageService = {
      customMethod() {
        return this === languageService ? "bound" : "unbound";
      },
      getProgram() {
        return void baseDiagnostics.length;
      },
      getSemanticDiagnostics() {
        return baseDiagnostics;
      },
    } as unknown as ts.LanguageService & { customMethod(): string };

    const proxy = plugin.create({
      config: "not an object",
      languageService,
    } as unknown as ts.server.PluginCreateInfo) as ts.LanguageService & { customMethod(): string };

    equal(proxy.customMethod(), "bound");
    deepEqual(proxy.getSemanticDiagnostics("missing.ts"), baseDiagnostics);
  });
});
