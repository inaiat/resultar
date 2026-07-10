import { rules } from "../rules.js";

export type {
  ResultarLintRuleName,
  ResultarRuleModule,
  RuleContext,
  RuleListener,
  RuleReportDescriptor,
} from "../rules.js";

export interface DenoLintPlugin {
  readonly name: string;
  readonly rules: typeof rules;
}

const plugin: DenoLintPlugin = { name: "resultar", rules };

export default plugin;
