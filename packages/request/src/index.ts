/**
 * Fetch-first JSON request helpers with typed Resultar failures, retries, decoding, and custom
 * error mapping.
 *
 * @module
 */

export {
  HttpResponseErrorCauseError,
  RequestError,
  baseRequestErrorHandler,
  integrationErrorHandler,
  isHttpResponseError,
  requestJson,
} from "./request-json.js";

/** Compatibility alias for `HttpResponseErrorCauseError`. */
export { HttpResponseErrorCauseError as HttpClientRequestErrorCause } from "./request-json.js";

export type {
  FetchJsonResponseData,
  RequestHeaders,
  RequestJsonBaseInput,
  RequestJsonDecodeFailure,
  RequestJsonDecodeInput,
  RequestJsonDecodeResult,
  RequestJsonDecodeSuccess,
  RequestJsonDecoder,
  RequestJsonErrorContext,
  RequestJsonHttpErrorContext,
  RequestJsonInput,
  RequestJsonInvalidJsonErrorContext,
  RequestJsonMapError,
  RequestJsonMapErrorResult,
  RequestJsonMappedDecodeInput,
  RequestJsonMappedInput,
  RequestJsonMappedValidatorInput,
  RequestJsonRequestFailureContext,
  RequestJsonResponseData,
  RequestJsonRetry,
  RequestJsonRetryContext,
  RequestJsonSource,
  RequestJsonValidationError,
  RequestJsonValidationErrorContext,
  RequestJsonValidationIssue,
  RequestJsonValidationReason,
  RequestJsonValidator,
  RequestJsonValidatorInput,
  UndiciJsonResponseData,
} from "./types.js";
