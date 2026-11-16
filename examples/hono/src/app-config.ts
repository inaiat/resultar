import { defineAppConfig, t } from "resultar-app";

export const appConfigProperties = {
  PORT: t.Integer({ default: 3000, minimum: 1, maximum: 65_535 }),
};

export const appConfig = defineAppConfig({ properties: appConfigProperties });
