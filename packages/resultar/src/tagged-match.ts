type TaggedValue = { readonly _tag: string }

const noTaggedHandlerMatch = Symbol('noTaggedHandlerMatch')

export type TaggedHandlerCall<R> = typeof noTaggedHandlerMatch | { readonly value: R }

export const isTaggedHandlerMatch = <R>(
  call: TaggedHandlerCall<R>,
): call is { readonly value: R } => call !== noTaggedHandlerMatch

const isTaggedValue = (value: unknown): value is TaggedValue =>
  typeof value === 'object' && value !== null && '_tag' in value

export const hasTag = <Tag extends string>(
  value: unknown,
  tag: Tag,
): value is { readonly _tag: Tag } => isTaggedValue(value) && value._tag === tag

export const callTaggedHandler = <R>(value: unknown, handlers: object): TaggedHandlerCall<R> => {
  if (!isTaggedValue(value)) {
    return noTaggedHandlerMatch
  }

  const handler = (handlers as Record<string, unknown>)[value._tag]

  if (handler === undefined) {
    return noTaggedHandlerMatch
  }

  return { value: (handler as (error: unknown) => R)(value) }
}

const callErrorHandler = <E, R>(
  error: E,
  handlers: { readonly Error?: (error: E) => R },
): TaggedHandlerCall<R> => {
  const handler = handlers.Error

  if (handler === undefined) {
    return noTaggedHandlerMatch
  }

  return { value: handler(error) }
}

const callTaggedOrErrorHandler = <E, R>(error: E, handlers: object): TaggedHandlerCall<R> => {
  const tagged = callTaggedHandler<R>(error, handlers)

  if (isTaggedHandlerMatch(tagged)) {
    return tagged
  }

  return callErrorHandler(error, handlers as { readonly Error?: (error: E) => R })
}

export const matchTaggedOr = <E, R, F>(
  error: E,
  handlers: object,
  fallback: (error: E) => F,
): R | F => {
  const handled = callTaggedOrErrorHandler<E, R>(error, handlers)

  return isTaggedHandlerMatch(handled) ? handled.value : fallback(error)
}
