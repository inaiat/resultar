type TaggedValue = { readonly _tag: string }

const isTaggedValue = (value: unknown): value is TaggedValue =>
  typeof value === 'object' && value !== null && '_tag' in value

export const hasTag = <Tag extends string>(
  value: unknown,
  tag: Tag,
): value is { readonly _tag: Tag } => isTaggedValue(value) && value._tag === tag

export const getTaggedHandler = <R>(
  value: unknown,
  handlers: object,
): ((error: unknown) => R) | undefined => {
  if (!isTaggedValue(value)) return undefined
  const tag = value._tag
  if (typeof tag !== 'string' || !Object.hasOwn(handlers, tag)) return undefined
  const handler = (handlers as Record<string, unknown>)[tag]
  return typeof handler === 'function' ? (handler as (error: unknown) => R) : undefined
}

export const matchTaggedOr = <E, R, F, Remaining = E>(
  error: E,
  handlers: object,
  fallback: (error: Remaining) => F,
): R | F => {
  const tagged = getTaggedHandler<R>(error, handlers)

  if (tagged !== undefined) {
    return tagged(error)
  }

  if (Object.hasOwn(handlers, 'Error')) {
    const errorHandler = (handlers as { readonly Error?: (error: E) => R }).Error
    if (typeof errorHandler === 'function') return errorHandler(error)
  }

  return fallback(error as unknown as Remaining)
}

const nativeError = Error as typeof Error & { isError?: (value: unknown) => boolean }

/**
 * Narrows a value to native or platform-recognized Error.
 */
export function isError(value: unknown): value is Error
export function isError<Value>(value: Value): value is Extract<Value, Error>
export function isError(value: unknown): value is Error {
  return nativeError.isError?.(value) ?? value instanceof Error
}
