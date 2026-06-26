import type { ResultAsync } from './result-async.js'
import type { Result } from './result.js'

export type TaggedValue = { readonly _tag: string }
export type TaggedErrorValue = Error & TaggedValue
export type TaggedReasonValue = TaggedValue
export type TaggedValueWithReason = TaggedValue & { readonly reason: TaggedReasonValue }
export type TagsOf<E> = Extract<E, TaggedValue>['_tag']
export type TagsWithReasonOf<E> = Extract<E, TaggedValueWithReason>['_tag']
export type ErrorTagsOf<E> = Extract<E, TaggedErrorValue>['_tag']
export type ErrorForTag<E, Tag extends string> = Extract<E, { readonly _tag: Tag }>
export type ExcludeTag<E, Tag extends string> = Exclude<E, { readonly _tag: Tag }>
export type UntaggedError<E> = Exclude<Extract<E, Error>, TaggedErrorValue>
export type ReasonsOf<E, ErrorTag extends string> = Extract<
  ErrorForTag<E, ErrorTag>,
  { readonly reason: TaggedReasonValue }
>['reason']
export type ReasonTagsOf<E, ErrorTag extends string> = ReasonsOf<E, ErrorTag>['_tag']
export type ReasonForTag<E, ErrorTag extends string, ReasonTag extends string> = Extract<
  ReasonsOf<E, ErrorTag>,
  { readonly _tag: ReasonTag }
>
type ErrorWithRemainingReason<ErrorType, Reason> = [Reason] extends [never]
  ? never
  : Omit<ErrorType, 'reason'> & { readonly reason: Reason }
export type ExcludeReasonTag<E, ErrorTag extends string, ReasonTag extends string> =
  | Exclude<E, { readonly _tag: ErrorTag }>
  | ErrorWithRemainingReason<
      ErrorForTag<E, ErrorTag>,
      Exclude<ReasonsOf<E, ErrorTag>, { readonly _tag: ReasonTag }>
    >

export type CatchTagHandlerResult<Handlers> = {
  readonly [Key in keyof Handlers]: Handlers[Key] extends (...args: infer _Args) => infer R
    ? R
    : never
}[keyof Handlers]

export type CatchReasonHandlerResult<Handlers> = {
  readonly [Key in keyof Handlers]: Handlers[Key] extends (...args: infer _Args) => infer R
    ? R
    : never
}[keyof Handlers]

export type MatchTagHandlerResult<Handlers> = {
  readonly [Key in keyof Handlers]: Handlers[Key] extends (...args: infer _Args) => infer R
    ? R
    : never
}[keyof Handlers]

export type CatchTagHandlers<E, Handlers, R> = {
  readonly [Tag in keyof Handlers]: Tag extends TagsOf<E>
    ? (error: ErrorForTag<E, Tag & string>) => R
    : never
}

export type ResultCatchTagHandlers<E, Handlers> = CatchTagHandlers<
  E,
  Handlers,
  Result<unknown, unknown>
>

export type ResultAsyncCatchTagHandlers<E, Handlers> = CatchTagHandlers<
  E,
  Handlers,
  Result<unknown, unknown> | ResultAsync<unknown, unknown>
>

export type CatchReasonHandlers<E, ErrorTag extends string, Handlers, R> = {
  readonly [ReasonTag in keyof Handlers]: ReasonTag extends ReasonTagsOf<E, ErrorTag>
    ? (reason: ReasonForTag<E, ErrorTag, ReasonTag & string>, error: ErrorForTag<E, ErrorTag>) => R
    : never
}

export type ResultCatchReasonHandlers<E, ErrorTag extends string, Handlers> = CatchReasonHandlers<
  E,
  ErrorTag,
  Handlers,
  Result<unknown, unknown>
>

export type ResultAsyncCatchReasonHandlers<
  E,
  ErrorTag extends string,
  Handlers,
> = CatchReasonHandlers<
  E,
  ErrorTag,
  Handlers,
  Result<unknown, unknown> | ResultAsync<unknown, unknown>
>

export type MatchTagHandlers<E, Handlers> = {
  readonly [Tag in ErrorTagsOf<E>]: (error: ErrorForTag<E, Tag>) => unknown
} & ([UntaggedError<E>] extends [never]
  ? { readonly Error?: (error: Error) => unknown }
  : { readonly Error: (error: UntaggedError<E>) => unknown }) & {
    readonly [Tag in keyof Handlers]: Tag extends ErrorTagsOf<E> | 'Error' ? Handlers[Tag] : never
  }

export type PartialMatchTagHandlers<E, Handlers> = {
  readonly [Tag in keyof Handlers]: Tag extends ErrorTagsOf<E>
    ? (error: ErrorForTag<E, Tag & string>) => unknown
    : Tag extends 'Error'
      ? (error: Extract<E, Error>) => unknown
      : never
}
