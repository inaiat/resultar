import { defineAppConfig } from "resultar-config";
import { Type } from "typebox";

export const appConfigProperties = {
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65_535 }),
};

export const appConfig = defineAppConfig({ properties: appConfigProperties });
