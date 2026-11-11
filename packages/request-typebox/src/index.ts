/**
 * TypeBox schema adapter for `resultar-request`.
 *
 * @module
 */

export * from "resultar-request";
export { requestJsonTypeBox, requestJsonTypeBoxTask } from "./request-json-typebox.js";

/** Package-local aliases for `requestJsonTypeBox` and `requestJsonTypeBoxTask`. */
export {
  requestJsonTypeBox as requestJson,
  requestJsonTypeBoxTask as requestJsonTask,
} from "./request-json-typebox.js";

export type {
  RequestJsonTypeBoxInput,
  RequestJsonTypeBoxMappedInput,
  RequestJsonTypeBoxTaskInput,
  RequestJsonTypeBoxTaskMappedInput,
} from "./request-json-typebox.js";
