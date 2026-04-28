import type { ErrResult } from './result.js'

import { err as resultErr } from './result.js'

type Alpha =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | '_'
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type AlphaNumeric = Alpha | Digit
type ReservedTemplateVariable =
  | '_tag'
  | 'cause'
  | 'fingerprint'
  | 'message'
  | 'messageTemplate'
  | 'name'
  | 'stack'

type ConsumeTemplateVariable<
  Template extends string,
  Accumulator extends string = '',
> = Template extends `${infer Character}${infer Rest}`
  ? Character extends AlphaNumeric
    ? ConsumeTemplateVariable<Rest, `${Accumulator}${Character}`>
    : { readonly rest: Template; readonly variable: Accumulator }
  : { readonly rest: ''; readonly variable: Accumulator }

type ExtractTemplateVariables<Template extends string> =
  Template extends `${string}$${infer AfterDollar}`
    ? AfterDollar extends `${Alpha}${string}`
      ? ConsumeTemplateVariable<AfterDollar> extends {
          readonly rest: infer Rest extends string
          readonly variable: infer Variable extends string
        }
        ? Variable | ExtractTemplateVariables<Rest>
        : never
      : ExtractTemplateVariables<AfterDollar>
    : never

type TemplateProps<Template extends string> = [ExtractTemplateVariables<Template>] extends [never]
  ? Record<never, never>
  : Readonly<Record<ExtractTemplateVariables<Template>, string | number>>
type ReservedVariablesIn<Template extends string> = Extract<
  ExtractTemplateVariables<Template>,
  ReservedTemplateVariable
>
type RejectReservedTemplateVariables<Template extends string> = [
  ReservedVariablesIn<Template>,
] extends [never]
  ? Template
  : never

type ErrorBaseConstructor<Base extends Error = Error> = new (
  message?: string,
  options?: ErrorOptions,
) => Base
type ErrorClass<Base extends Error = Error> = new (...args: readonly any[]) => Base
type ErrorClassInstance<This> = This extends new (...args: readonly any[]) => infer Instance
  ? Instance
  : never
type ConstructorProps<Template extends string> = TemplateProps<Template> & {
  readonly cause?: unknown
}
type TaggedErrorConstructorArgs<Template extends string> = [
  ExtractTemplateVariables<Template>,
] extends [never]
  ? [props?: { readonly cause?: unknown }]
  : [props: ConstructorProps<Template>]

export interface TaggedErrorOptions<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
> {
  readonly extends?: ErrorBaseConstructor<Base>
  readonly message?: MessageTemplate
  readonly name: Tag
}

export type TaggedErrorInstance<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
> = Base &
  Readonly<TemplateProps<MessageTemplate>> & {
    readonly _tag: Tag
    readonly fingerprint: readonly [Tag, MessageTemplate]
    readonly messageTemplate: MessageTemplate
    findCause<T extends Error>(ErrorClass: ErrorClass<T>): T | undefined
    toJSON(): object
  }

export type TaggedErrorClass<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
> = {
  new (
    ...args: TaggedErrorConstructorArgs<MessageTemplate>
  ): TaggedErrorInstance<Tag, MessageTemplate, Base>
  readonly tag: Tag
  err<This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate>) => Error>(
    this: This,
    ...args: TaggedErrorConstructorArgs<MessageTemplate>
  ): ErrResult<never, ErrorClassInstance<This>>
  is(value: unknown): value is TaggedErrorInstance<Tag, MessageTemplate, Base>
}

export type TaggedEnum<Members extends Record<string, Record<PropertyKey, unknown>>> = {
  readonly [Tag in keyof Members]: Readonly<Members[Tag]> & { readonly _tag: Tag }
}[keyof Members]

type TaggedErrorLike = Error & { readonly _tag: string }
type TaggedErrorTags<ErrorType extends Error> = Extract<ErrorType, TaggedErrorLike>['_tag']
type ErrorForTag<ErrorType extends Error, Tag extends string> = Extract<
  ErrorType,
  { readonly _tag: Tag }
>
type UntaggedError<ErrorType extends Error> = Exclude<ErrorType, TaggedErrorLike>
type MatchHandlers<ErrorType extends Error, ReturnType> = {
  readonly [Tag in TaggedErrorTags<ErrorType>]: (error: ErrorForTag<ErrorType, Tag>) => ReturnType
} & ([UntaggedError<ErrorType>] extends [never]
  ? { readonly Error?: (error: Error) => ReturnType }
  : { readonly Error: (error: UntaggedError<ErrorType>) => ReturnType })
type PartialMatchHandlers<ErrorType extends Error, ReturnType> = Partial<
  MatchHandlers<ErrorType, ReturnType>
>

const defaultBaseError: ErrorBaseConstructor = Error
const defaultMessageTemplate = '$message'

const nativeError = Error as typeof Error & { isError?: (value: unknown) => boolean }
const templateVariableMatcher = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g
const reservedTemplateVariables = new Set<ReservedTemplateVariable>([
  '_tag',
  'cause',
  'fingerprint',
  'message',
  'messageTemplate',
  'name',
  'stack',
])

export function isError(value: unknown): value is Error
export function isError<Value>(value: Value): value is Extract<Value, Error>
export function isError(value: unknown): value is Error {
  return nativeError.isError?.(value) ?? value instanceof Error
}

const stringifyTemplateValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'symbol') {
    return value.description ?? value.toString()
  }

  if (typeof value === 'function') {
    return value.name
  }

  if (typeof value === 'object') {
    return value === null
      ? 'null'
      : (JSON.stringify(value) ?? Object.prototype.toString.call(value))
  }

  return ''
}

const compileMessageInterpolator =
  (template: string): ((values?: Record<string, unknown>) => string) =>
  (values) =>
    template.replaceAll(templateVariableMatcher, (variable, key: string) => {
      const value = values?.[key]
      return value === undefined ? variable : stringifyTemplateValue(value)
    })

const getTemplateVariableNames = (template: string): readonly string[] => {
  templateVariableMatcher.lastIndex = 0
  return [...template.matchAll(templateVariableMatcher)].map((match) => String(match[1]))
}

const assertNoReservedTemplateVariables = (tag: string, template: string): void => {
  if (template === defaultMessageTemplate) {
    return
  }

  const reservedVariables = getTemplateVariableNames(template).filter(
    (variable): variable is ReservedTemplateVariable =>
      reservedTemplateVariables.has(variable as ReservedTemplateVariable),
  )

  if (reservedVariables.length > 0) {
    throw new Error(
      `createTaggedError(${tag}): reserved template variable $${reservedVariables[0]} is not allowed`,
    )
  }
}

const getErrorOptions = (cause: unknown): { cause?: unknown } =>
  cause === undefined ? {} : { cause }

const assignReadonly = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: false,
  })
}

const serializeCause = (cause: unknown): unknown => {
  if (!isError(cause)) {
    return cause
  }

  return { message: cause.message, name: cause.name, stack: cause.stack }
}

export const findCause = <T extends Error>(
  error: Error,
  ErrorClass: ErrorClass<T>,
): T | undefined => {
  const seen = new Set<Error>()
  let current: unknown = error

  while (isError(current)) {
    if (seen.has(current)) {
      break
    }

    seen.add(current)

    if (current instanceof ErrorClass) {
      return current
    }

    current = current.cause
  }

  return undefined
}

export function createTaggedError<
  const Tag extends string,
  const MessageTemplate extends string = typeof defaultMessageTemplate,
  Base extends Error = Error,
>(
  options: Omit<TaggedErrorOptions<Tag, MessageTemplate, Base>, 'message'> & {
    readonly message?: RejectReservedTemplateVariables<MessageTemplate>
  },
): TaggedErrorClass<Tag, MessageTemplate, Base> {
  const BaseError = options.extends ?? defaultBaseError
  const messageTemplate = options.message ?? (defaultMessageTemplate as MessageTemplate)
  assertNoReservedTemplateVariables(options.name, messageTemplate)
  const interpolate = compileMessageInterpolator(messageTemplate)

  class GeneratedTaggedError extends BaseError {
    static readonly tag = options.name
    readonly _tag = options.name
    readonly fingerprint = [options.name, messageTemplate] as const
    readonly messageTemplate = messageTemplate

    constructor(props?: ConstructorProps<MessageTemplate>) {
      const message = interpolate(props)
      super(message, getErrorOptions(props?.cause))
      // eslint-disable-next-line nicorn/custom-error-definition
      this.name = options.name

      if (props) {
        for (const [key, value] of Object.entries(props)) {
          if (!reservedTemplateVariables.has(key as ReservedTemplateVariable)) {
            assignReadonly(this, key, value)
          }
        }
      }
    }

    static is(value: unknown): value is TaggedErrorInstance<Tag, MessageTemplate, Base> {
      return value instanceof this
    }

    static err<This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate>) => Error>(
      this: This,
      ...args: TaggedErrorConstructorArgs<MessageTemplate>
    ): ErrResult<never, InstanceType<This>> {
      const error = new this(...args) as InstanceType<This>
      return resultErr<never, InstanceType<This>>(error)
    }

    findCause<T extends Error>(ErrorClass: ErrorClass<T>): T | undefined {
      return findCause(this, ErrorClass)
    }

    toJSON(): object {
      const json: Record<string, unknown> = {
        _tag: this._tag,
        fingerprint: this.fingerprint,
        message: this.message,
        messageTemplate: this.messageTemplate,
        name: this.name,
      }

      if (this.cause !== undefined) {
        json['cause'] = serializeCause(this.cause)
      }

      for (const [key, value] of Object.entries(this)) {
        if (!(key in json) && key !== 'cause' && key !== 'stack') {
          json[key] = value
        }
      }

      return json
    }
  }

  return GeneratedTaggedError as TaggedErrorClass<Tag, MessageTemplate, Base>
}

export const matchError = <ErrorType extends Error, ReturnType>(
  error: ErrorType,
  handlers: MatchHandlers<ErrorType, ReturnType>,
): ReturnType => {
  if ('_tag' in error && typeof error._tag === 'string' && error._tag in handlers) {
    const handler = handlers[error._tag as keyof typeof handlers] as (
      error: ErrorType,
    ) => ReturnType
    return handler(error)
  }

  if (handlers.Error) {
    return (handlers.Error as (error: ErrorType) => ReturnType)(error)
  }

  throw error
}

export const matchErrorPartial = <ErrorType extends Error, ReturnType>(
  error: ErrorType,
  handlers: PartialMatchHandlers<ErrorType, ReturnType>,
  fallback: (error: ErrorType) => ReturnType,
): ReturnType => {
  if ('_tag' in error && typeof error._tag === 'string' && error._tag in handlers) {
    const handler = handlers[error._tag as keyof typeof handlers]
    if (handler) {
      return (handler as (error: ErrorType) => ReturnType)(error)
    }
  }

  if (handlers.Error) {
    return (handlers.Error as (error: ErrorType) => ReturnType)(error)
  }

  return fallback(error)
}
