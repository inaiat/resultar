/**
 * Zod schema adapter for `resultar-request`.
 *
 * @module
 */

export * from "resultar-request";
export { requestJsonZod, requestJsonZodTask } from "./request-json-zod.js";

/** Package-local aliases for `requestJsonZod` and `requestJsonZodTask`. */
export {
  requestJsonZod as requestJson,
  requestJsonZodTask as requestJsonTask,
} from "./request-json-zod.js";

export type {
  RequestJsonZodInput,
  RequestJsonZodMappedInput,
  RequestJsonZodTaskInput,
  RequestJsonZodTaskMappedInput,
} from "./request-json-zod.js";
