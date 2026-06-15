import { getProgramResultarDiagnostics } from "./diagnostics.js";
import { createLanguageServicePlugin } from "./plugin.js";

type ResultarLanguageServicePlugin = typeof createLanguageServicePlugin & {
  readonly createLanguageServicePlugin: typeof createLanguageServicePlugin;
  readonly getProgramResultarDiagnostics: typeof getProgramResultarDiagnostics;
};

const plugin: ResultarLanguageServicePlugin = Object.assign(createLanguageServicePlugin, {
  createLanguageServicePlugin,
  getProgramResultarDiagnostics,
});

export default plugin;
