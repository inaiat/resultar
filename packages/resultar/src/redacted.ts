/**
 * String-like wrapper that hides a sensitive value in messages and JSON output.
 */
export type Redacted<T> = string & {
  /**
   * Internal marker used by `isRedacted`.
   */
  readonly __resultarRedacted: true
  readonly __resultarRedactedType?: T
  /**
   * Optional label shown as `<redacted:label>`.
   */
  readonly label: string | undefined
  /**
   * Serializes to the redacted placeholder.
   */
  toJSON: () => string
  /**
   * Converts to the redacted placeholder.
   */
  toString: () => string
}

const redactedValues = new WeakMap<object, unknown>()

const formatRedacted = (label: string | undefined): string =>
  label === undefined ? '<redacted>' : `<redacted:${label}>`

class RedactedValue<T> {
  public readonly __resultarRedacted = true
  public readonly label: string | undefined

  /**
   * Stores a sensitive value behind a redacted string wrapper.
   */
  public constructor(value: T, label: string | undefined) {
    this.label = label
    redactedValues.set(this, value)
  }

  /**
   * Serializes to the redacted placeholder.
   */
  public toJSON(): string {
    return this.toString()
  }

  /**
   * Converts to the redacted placeholder.
   */
  public toString(): string {
    return formatRedacted(this.label)
  }
}

/**
 * Wraps a sensitive value so tagged-error messages and JSON output show only a placeholder.
 */
export const redact = <T>(value: T, label?: string): Redacted<T> =>
  new RedactedValue(value, label) as unknown as Redacted<T>

/**
 * Checks whether a value was created by `redact`.
 */
export const isRedacted = (value: unknown): value is Redacted<unknown> =>
  // Stryker disable next-line all: the object/null guard documents the WeakMap-key contract; WeakMap.has returns false for non-objects.
  typeof value === 'object' && value !== null && redactedValues.has(value)

/**
 * Returns the original sensitive value from a Redacted wrapper.
 */
export const revealRedacted = <T>(value: Redacted<T>): T =>
  redactedValues.get(value as unknown as object) as T

/**
 * Converts a Redacted wrapper to its placeholder string.
 */
export const stringifyRedacted = (value: Redacted<unknown>): string => value.toString()
