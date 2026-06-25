import { createRequire } from "node:module";

interface ResultarCheckPlugin {
  readonly createLanguageServicePlugin: unknown;
  readonly findResultarLintFindings: unknown;
  readonly getProgramResultarDiagnostics: unknown;
  readonly runResultarCheckCli: (args?: readonly string[]) => number;
}

const requirePackage = createRequire(import.meta.url);
const plugin = requirePackage("resultar-check") as ResultarCheckPlugin;

export default plugin;
