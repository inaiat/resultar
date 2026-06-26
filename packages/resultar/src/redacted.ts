export type Redacted<T> = string & {
  readonly __resultarRedacted: true
  readonly __resultarRedactedType?: T
  readonly label: string | undefined
  toJSON(): string
  toString(): string
}

const redactedValues = new WeakMap<object, unknown>()

const formatRedacted = (label: string | undefined): string =>
  label === undefined ? '<redacted>' : `<redacted:${label}>`

class RedactedValue<T> {
  public readonly __resultarRedacted = true
  public readonly label: string | undefined

  public constructor(value: T, label: string | undefined) {
    this.label = label
    redactedValues.set(this, value)
  }

  public toJSON(): string {
    return this.toString()
  }

  public toString(): string {
    return formatRedacted(this.label)
  }
}

export const redact = <T>(value: T, label?: string): Redacted<T> =>
  new RedactedValue(value, label) as unknown as Redacted<T>

export const isRedacted = (value: unknown): value is Redacted<unknown> =>
  // Stryker disable next-line all: the object/null guard documents the WeakMap-key contract; WeakMap.has returns false for non-objects.
  typeof value === 'object' && value !== null && redactedValues.has(value)

export const revealRedacted = <T>(value: Redacted<T>): T =>
  redactedValues.get(value as unknown as object) as T

export const stringifyRedacted = (value: Redacted<unknown>): string => value.toString()
