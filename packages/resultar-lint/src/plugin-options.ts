import { normalizeNoDiscardMode } from "./result-usage-core.js";
import {
  type ResultarRulesOptions,
  defaultResultarRulesOptions,
  normalizeRuleSeverity,
} from "./rules-core.js";

export type ResultarLanguageServiceOptions = ResultarRulesOptions;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isResultarPluginName = (value: unknown): boolean => value === "resultar-lint";

export const parsePluginOptions = (config: unknown): ResultarLanguageServiceOptions => {
  if (!isRecord(config)) {
    return defaultResultarRulesOptions;
  }

  return {
    noDiscard: normalizeRuleSeverity(config.noDiscard, defaultResultarRulesOptions.noDiscard),
    noDiscardMode: normalizeNoDiscardMode(config.noDiscardMode),
    noTaggedErrorConstructorOverride: normalizeRuleSeverity(
      config.noTaggedErrorConstructorOverride,
      defaultResultarRulesOptions.noTaggedErrorConstructorOverride,
    ),
    noTryCatchInSafeTry: normalizeRuleSeverity(
      config.noTryCatchInSafeTry,
      defaultResultarRulesOptions.noTryCatchInSafeTry,
    ),
    noUselessRecovery: normalizeRuleSeverity(
      config.noUselessRecovery,
      defaultResultarRulesOptions.noUselessRecovery,
    ),
    preferAndThen: normalizeRuleSeverity(
      config.preferAndThen,
      defaultResultarRulesOptions.preferAndThen,
    ),
    preferMapErr: normalizeRuleSeverity(
      config.preferMapErr,
      defaultResultarRulesOptions.preferMapErr,
    ),
    preferTaggedError: normalizeRuleSeverity(
      config.preferTaggedError,
      defaultResultarRulesOptions.preferTaggedError,
    ),
    taggedErrorNameMatch: normalizeRuleSeverity(
      config.taggedErrorNameMatch,
      defaultResultarRulesOptions.taggedErrorNameMatch,
    ),
    typedCatchMapper: normalizeRuleSeverity(
      config.typedCatchMapper,
      defaultResultarRulesOptions.typedCatchMapper,
    ),
    unsafeResultTypeAssertion: normalizeRuleSeverity(
      config.unsafeResultTypeAssertion,
      defaultResultarRulesOptions.unsafeResultTypeAssertion,
    ),
    yieldStarInSafeTry: normalizeRuleSeverity(
      config.yieldStarInSafeTry,
      defaultResultarRulesOptions.yieldStarInSafeTry,
    ),
  };
};

export const findResultarPluginConfig = (
  plugins: readonly unknown[] | undefined,
): ResultarLanguageServiceOptions | undefined => {
  const plugin = plugins?.find((entry) => isRecord(entry) && isResultarPluginName(entry.name));

  return plugin === undefined ? undefined : parsePluginOptions(plugin);
};
