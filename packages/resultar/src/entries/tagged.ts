/**
 * Typed tagged errors (`createTaggedError`), discriminated unions (`taggedEnum`), error matchers,
 * and secret redaction (`redact`).
 *
 * @module
 */

export { isRedacted, redact, revealRedacted } from '../core/redacted.js'
export type { Redacted } from '../core/redacted.js'
export {
  createTaggedError,
  findCause,
  isError,
  matchError,
  matchErrorPartial,
  taggedEnum,
} from '../tagged/tagged-error.js'
export type {
  TaggedEnum,
  TaggedEnumFactory,
  TaggedErrorClass,
  TaggedErrorInstance,
  TaggedErrorOptions,
} from '../tagged/tagged-error.js'
