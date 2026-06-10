import { normalizeNoDiscardMode, type NoDiscardMode } from "./no-discard-core";

export type NoDiscardSeverity = "error" | "off";

export interface ResultarLanguageServiceOptions {
  readonly noDiscard: NoDiscardSeverity;
  readonly noDiscardMode: NoDiscardMode;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isResultarPluginName = (value: unknown): boolean =>
  value === "resultar-lint" || value === "resultar-ls" || value === "resultar-language-service";

export const parsePluginOptions = (config: unknown): ResultarLanguageServiceOptions => {
  const noDiscardMode = isRecord(config)
    ? normalizeNoDiscardMode(config.noDiscardMode)
    : "must-use";

  if (isRecord(config) && config.noDiscard === "off") {
    return { noDiscard: "off", noDiscardMode };
  }

  return { noDiscard: "error", noDiscardMode };
};

export const findResultarPluginConfig = (
  plugins: readonly unknown[] | undefined,
): ResultarLanguageServiceOptions | undefined => {
  const plugin = plugins?.find((entry) => isRecord(entry) && isResultarPluginName(entry.name));

  return plugin === undefined ? undefined : parsePluginOptions(plugin);
};
