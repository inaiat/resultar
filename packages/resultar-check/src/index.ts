import { getProgramResultarDiagnostics } from "./diagnostics.js";
import { findResultarLintFindings, runResultarCheckCli } from "./lint.js";
import { createLanguageServicePlugin } from "./plugin.js";

type ResultarLanguageServicePlugin = typeof createLanguageServicePlugin & {
  readonly createLanguageServicePlugin: typeof createLanguageServicePlugin;
  readonly findResultarLintFindings: typeof findResultarLintFindings;
  readonly getProgramResultarDiagnostics: typeof getProgramResultarDiagnostics;
  readonly runResultarCheckCli: typeof runResultarCheckCli;
};

const plugin: ResultarLanguageServicePlugin = Object.assign(createLanguageServicePlugin, {
  createLanguageServicePlugin,
  findResultarLintFindings,
  getProgramResultarDiagnostics,
  runResultarCheckCli,
});

export default plugin;
