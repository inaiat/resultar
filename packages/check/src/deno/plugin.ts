/**
 * Deno Lint adapter for Resultar's syntax-only rules.
 *
 * Add the default export to `plugins` in `deno.json`. Keep the
 * `resultar-check` CLI as the authoritative type-aware project gate.
 *
 * @module
 */

import { rules } from "../rules.js";

export type {
  ResultarLintRuleName,
  ResultarRuleModule,
  RuleContext,
  RuleListener,
  RuleReportDescriptor,
} from "../rules.js";

/** Public shape of the Resultar Deno Lint plugin. */
export interface DenoLintPlugin {
  /** Plugin namespace used by Deno Lint. */
  readonly name: string;
  /** Syntax-only Resultar rules exposed to Deno Lint. */
  readonly rules: typeof rules;
}

/** Ready-to-use Resultar plugin for Deno Lint. */
const plugin: DenoLintPlugin = { name: "resultar", rules };

export default plugin;
