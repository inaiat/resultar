import { deepEqual, equal } from "node:assert";

import { describe, it } from "vite-plus/test";
import * as ts from "../src/typescript-api.js";

import {
  createLanguageServicePlugin,
  type LanguageServiceLike,
  type PluginCreateInfo,
} from "../src/plugin.js";

type CustomLanguageService = LanguageServiceLike & { readonly customMethod: () => string };

describe("Resultar TypeScript language-service plugin", () => {
  it("returns an already wrapped language service unchanged", () => {
    const plugin = createLanguageServicePlugin({ typescript: ts });
    const languageService = {
      __resultarLanguageServicePlugin: true,
      getSemanticDiagnostics: () => [],
    } as unknown as LanguageServiceLike;

    equal(plugin.create({ languageService }), languageService);
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
        source: undefined,
        start: 0,
      },
    ] satisfies ts.Diagnostic[];
    const expectedThis: { value: unknown } = { value: undefined };
    const languageService: CustomLanguageService = {
      customMethod(this: unknown) {
        return this === expectedThis.value ? "bound" : "unbound";
      },
      getProgram() {
        return void baseDiagnostics.length;
      },
      getSemanticDiagnostics() {
        return baseDiagnostics;
      },
    };
    expectedThis.value = languageService;

    const proxy = plugin.create({
      config: "not an object",
      languageService,
    } satisfies PluginCreateInfo) as CustomLanguageService;

    equal(proxy.customMethod(), "bound");
    deepEqual(proxy.getSemanticDiagnostics("missing.ts"), baseDiagnostics);
  });
});
