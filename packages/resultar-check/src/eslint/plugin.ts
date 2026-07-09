import { recommendedSeverities, rules } from "../rules.js";

export type {
  ResultarLintRuleName,
  ResultarRuleModule,
  RuleContext,
  RuleListener,
  RuleReportDescriptor,
} from "../rules.js";

export interface LinterConfig {
  readonly plugins?: Record<string, unknown>;
  readonly rules?: Record<string, "error" | "off" | "warn">;
}

export interface ResultarLintPlugin {
  readonly configs: { recommended?: LinterConfig };
  readonly meta: { readonly name: string };
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

const plugin: ResultarLintPlugin = { configs: {}, meta: { name: "resultar-check" }, rules };

const recommended: LinterConfig = { plugins: { resultar: plugin }, rules: recommendedRules };

plugin.configs.recommended = recommended;

export default plugin;
