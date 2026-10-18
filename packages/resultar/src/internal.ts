/** Private implementation contracts shared with the deprecated Async entrypoint. */
export { dual } from './core/dual.js'
export { Pipeable } from './core/pipe.js'
export {
  isRetryPolicy,
  observeRetry,
  retryContext,
  retryPolicyDelay,
  validateRetryPolicy,
} from './core/retry.js'
export type {
  Combine,
  Dedup,
  EmptyArrayToNever,
  IsLiteralArray,
  MatchHandlers,
  MemberListOf,
  MembersToUnion,
} from './result/result-types.js'
export type { InferOkTypes, InferErrTypes } from './core/utils.js'
export { createEmptyResultsCollectionError, getMatchErrorHandler } from './result/result-helpers.js'
export {
  callTaggedHandler,
  hasTag,
  isTaggedHandlerMatch,
  matchTaggedOr,
} from './tagged/tagged-match.js'
export type {
  CatchTagHandlerResult,
  CatchReasonHandlerResult,
  CoveredHandlerKeys,
  ErrorForTag,
  ExcludeTag,
  ExcludeReasonTag,
  MatchTagHandlerResult,
  MatchTagHandlers,
  PartialMatchTagHandlers,
  RemainingMatchTagErrors,
  ReasonForTag,
  ReasonTagsOf,
  ReasonsOf,
  TagsOf,
  TagsWithReasonOf,
} from './tagged/tagged-types.js'
