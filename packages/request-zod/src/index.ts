/**
 * Zod schema adapter for `resultar-request`.
 *
 * @module
 */

export * from "resultar-request";
export { requestJsonZod } from "./request-json-zod.js";

/** Package-local alias for `requestJsonZod`. */
export { requestJsonZod as requestJson } from "./request-json-zod.js";

export type { RequestJsonZodInput, RequestJsonZodMappedInput } from "./request-json-zod.js";
