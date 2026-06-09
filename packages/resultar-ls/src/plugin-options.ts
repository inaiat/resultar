export type NoDiscardSeverity = "error" | "off";

export interface ResultarLanguageServiceOptions {
  readonly noDiscard: NoDiscardSeverity;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isResultarPluginName = (value: unknown): boolean =>
  value === "resultar-ls" || value === "resultar-language-service";

export const parsePluginOptions = (config: unknown): ResultarLanguageServiceOptions => {
  if (isRecord(config) && config.noDiscard === "off") {
    return { noDiscard: "off" };
  }

  return { noDiscard: "error" };
};

export const findResultarPluginConfig = (
  plugins: readonly unknown[] | undefined,
): ResultarLanguageServiceOptions | undefined => {
  const plugin = plugins?.find((entry) => isRecord(entry) && isResultarPluginName(entry.name));

  return plugin === undefined ? undefined : parsePluginOptions(plugin);
};
