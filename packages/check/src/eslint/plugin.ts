/**
 * ESLint adapter for Resultar's syntax-only rules.
 *
 * Use the default export in an ESLint flat config. Keep the `resultar-check`
 * CLI as the authoritative type-aware project gate.
 *
 * @module
 */

import { recommendedSeverities, rules } from "../rules.js";

export type {
  ResultarLintRuleName,
  ResultarRuleModule,
  RuleContext,
  RuleListener,
  RuleReportDescriptor,
} from "../rules.js";

/** Minimal ESLint flat-config shape used by the Resultar adapter. */
export interface LinterConfig {
  /** Plugins available to rules in this config. */
  readonly plugins?: Record<string, unknown>;
  /** Configured rule severities keyed by qualified rule name. */
  readonly rules?: Record<string, "error" | "off" | "warn">;
}

/** Public shape of the Resultar ESLint plugin. */
export interface ResultarLintPlugin {
  /** Shareable configurations provided by the plugin. */
  readonly configs: { recommended?: LinterConfig };
  /** Plugin metadata consumed by ESLint. */
  readonly meta: { readonly name: string };
  /** Syntax-only Resultar rules exposed to ESLint. */
  readonly rules: typeof rules;
}

const createRecommendedRules = (): Record<string, "error" | "warn"> => {
  const configuredRules: Record<string, "error" | "warn"> = {};

  for (const [ruleName, severity] of Object.entries(recommendedSeverities)) {
    configuredRules[`resultar/${ruleName}`] = severity;
  }

  return configuredRules;
};

const recommendedRules = createRecommendedRules();

/** Ready-to-use Resultar plugin for ESLint flat config. */
const plugin: ResultarLintPlugin = { configs: {}, meta: { name: "resultar-check" }, rules };

const recommended: LinterConfig = { plugins: { resultar: plugin }, rules: recommendedRules };

plugin.configs.recommended = recommended;

export default plugin;
