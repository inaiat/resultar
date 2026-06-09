type TaggedValue = { readonly _tag: string }

export type TaggedHandlerCall<R> =
  | { readonly matched: false }
  | { readonly matched: true; readonly value: R }

const isTaggedValue = (value: unknown): value is TaggedValue =>
  typeof value === 'object' && value !== null && '_tag' in value

export const hasTag = <Tag extends string>(
  value: unknown,
  tag: Tag,
): value is { readonly _tag: Tag } => isTaggedValue(value) && value._tag === tag

export const callTaggedHandler = <R>(value: unknown, handlers: object): TaggedHandlerCall<R> => {
  if (!isTaggedValue(value)) {
    return { matched: false }
  }

  const handler = (handlers as Record<string, unknown>)[value._tag]

  if (handler === undefined) {
    return { matched: false }
  }

  return { matched: true, value: (handler as (error: unknown) => R)(value) }
}

const callErrorHandler = <E, R>(
  error: E,
  handlers: { readonly Error?: (error: E) => R },
): TaggedHandlerCall<R> => {
  if (handlers.Error === undefined) {
    return { matched: false }
  }

  return { matched: true, value: handlers.Error(error) }
}

const callTaggedOrErrorHandler = <E, R>(error: E, handlers: object): TaggedHandlerCall<R> => {
  const tagged = callTaggedHandler<R>(error, handlers)

  if (tagged.matched) {
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

  return handled.matched ? handled.value : fallback(error)
}
