/**
 * TypeBox schema adapter for `resultar-request`.
 *
 * @module
 */

export * from "resultar-request";
export { Type as t } from "typebox";
export { requestJsonTypeBox } from "./request-json-typebox.js";

/** Package-local alias for `requestJsonTypeBox`. */
export { requestJsonTypeBox as requestJson } from "./request-json-typebox.js";

export type {
  RequestJsonTypeBoxInput,
  RequestJsonTypeBoxMappedInput,
} from "./request-json-typebox.js";
