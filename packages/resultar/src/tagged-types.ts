import type { ResultAsync } from './result-async.js'
import type { Result } from './result.js'

export type TaggedValue = { readonly _tag: string }
export type TaggedErrorValue = Error & TaggedValue
export type TagsOf<E> = Extract<E, TaggedValue>['_tag']
export type ErrorTagsOf<E> = Extract<E, TaggedErrorValue>['_tag']
export type ErrorForTag<E, Tag extends string> = Extract<E, { readonly _tag: Tag }>
export type ExcludeTag<E, Tag extends string> = Exclude<E, { readonly _tag: Tag }>
export type UntaggedError<E> = Exclude<Extract<E, Error>, TaggedErrorValue>

export type CatchTagHandlerResult<Handlers> = {
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
