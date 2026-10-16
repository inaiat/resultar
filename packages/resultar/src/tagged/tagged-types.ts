import type { ResultAsync } from '../task/result-async.js'
import type { Result } from '../result.js'

export type TaggedValue = { readonly _tag: string }
export type TaggedErrorValue = Error & TaggedValue
export type TaggedReasonValue = TaggedValue
export type TaggedValueWithReason = TaggedValue & { readonly reason: TaggedReasonValue }
export type TagsOf<E> = Extract<E, TaggedValue>['_tag']
export type TagsWithReasonOf<E> = Extract<E, TaggedValueWithReason>['_tag']
export type ErrorTagsOf<E> = Extract<E, TaggedErrorValue>['_tag']
export type ErrorForTag<E, Tag extends string> = Extract<E, { readonly _tag: Tag }>
export type ExcludeTag<E, Tag extends string> = Exclude<E, { readonly _tag: Tag }>
type ConcreteTaggedError<E> = E extends TaggedErrorValue
  ? string extends E['_tag']
    ? never
    : E
  : never
type UntaggedError<E> = Exclude<E, ConcreteTaggedError<E>>
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

export type CatchTagHandlerResult<Handlers> = Handlers extends unknown
  ? { readonly [Key in keyof Handlers]-?: HandlerReturn<Handlers[Key]> }[keyof Handlers]
  : never

export type CatchReasonHandlerResult<Handlers> = Handlers extends unknown
  ? { readonly [Key in keyof Handlers]-?: HandlerReturn<Handlers[Key]> }[keyof Handlers]
  : never

type HandlerReturn<Handler> = Handler extends (...args: infer _Args) => infer R ? R : never

export type MatchTagHandlerResult<Handlers> = Handlers extends unknown
  ? { readonly [Key in keyof Handlers]-?: HandlerReturn<Handlers[Key]> }[keyof Handlers]
  : never

type CoveredKey<Handlers, Key> = Key extends PropertyKey
  ? [Handlers] extends [Record<Key, (...args: never[]) => unknown>]
    ? [Handlers] extends [never]
      ? never
      : Key
    : never
  : never

/** Keys with a required function in every possible handler-table branch. */
export type CoveredHandlerKeys<Handlers> = CoveredKey<Handlers, keyof Handlers>

/** Errors not covered by a handler guaranteed to be present at runtime. */
export type RemainingMatchTagErrors<E, Handlers> =
  'Error' extends CoveredHandlerKeys<Handlers>
    ? never
    : ExcludeTag<E, Extract<CoveredHandlerKeys<Handlers>, string>>

type CheckedHandlerReturn<Handler, R> = Handler extends (...args: never[]) => infer Ret
  ? Ret extends R
    ? Ret
    : R
  : unknown

export type CatchTagHandlers<E, Handlers, R> = {
  readonly [Tag in keyof Handlers]: Tag extends TagsOf<E>
    ? (error: NoInfer<ErrorForTag<E, Tag & string>>) => CheckedHandlerReturn<Handlers[Tag], R>
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
    ? (
        reason: NoInfer<ReasonForTag<E, ErrorTag, ReasonTag & string>>,
        error: NoInfer<ErrorForTag<E, ErrorTag>>,
      ) => CheckedHandlerReturn<Handlers[ReasonTag], R>
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

type ErrorFallback<E> = UntaggedError<E> | ErrorForTag<E, 'Error'>

export type MatchTagHandlers<E, Handlers> = {
  readonly [Tag in Exclude<ConcreteTaggedError<E>['_tag'], 'Error'>]: (
    error: NoInfer<ErrorForTag<E, Tag>>,
  ) => unknown
} & ([ErrorFallback<E>] extends [never]
  ? { readonly Error?: (error: Error) => unknown }
  : { readonly Error: (error: NoInfer<ErrorFallback<E>>) => unknown }) & {
    readonly [Tag in keyof Handlers]: Tag extends ErrorTagsOf<E> | 'Error' ? Handlers[Tag] : never
  }

export type PartialMatchTagHandlers<E, Handlers> = {
  readonly [Tag in keyof Handlers]: Tag extends ErrorTagsOf<E>
    ? ((error: NoInfer<ErrorForTag<E, Tag & string>>) => unknown) | undefined
    : Tag extends 'Error'
      ? ((error: NoInfer<E>) => unknown) | undefined
      : never
}
