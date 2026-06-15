import type { ErrResult } from './result.js'

import { isRedacted, stringifyRedacted } from './redacted.js'
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

export type TaggedEnum<Members extends Record<string, object>> = {
  readonly [Tag in keyof Members]: Readonly<Members[Tag]> & { readonly _tag: Tag }
}[keyof Members]
type TaggedEnumMember<Members extends Record<string, object>, Tag extends keyof Members> = Readonly<
  Members[Tag]
> & { readonly _tag: Tag }
type TaggedEnumConstructor<
  Members extends Record<string, object>,
  Tag extends keyof Members,
> = keyof Members[Tag] extends never
  ? (props?: Readonly<Members[Tag]>) => TaggedEnumMember<Members, Tag>
  : (props: Readonly<Members[Tag]>) => TaggedEnumMember<Members, Tag>
export type TaggedEnumFactory<Members extends Record<string, object>> = {
  readonly [Tag in keyof Members]: TaggedEnumConstructor<Members, Tag>
} & {
  $is<Tag extends keyof Members>(tag: Tag, value: unknown): value is TaggedEnumMember<Members, Tag>
  $match<ReturnType>(
    value: TaggedEnum<Members>,
    handlers: {
      readonly [Tag in keyof Members]: (value: TaggedEnumMember<Members, Tag>) => ReturnType
    },
  ): ReturnType
}

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
const templateVariableMatcher = /\$([a-zA-Z_][a-zA-Z0-9_]*)/gu
const reservedTemplateVariables = new Set<ReservedTemplateVariable>([
  '_tag',
  'cause',
  'fingerprint',
  'message',
  'messageTemplate',
  'name',
  'stack',
])

type TemplateValueStringifier = (value: unknown) => string

export function isError(value: unknown): value is Error
export function isError<Value>(value: Value): value is Extract<Value, Error>
export function isError(value: unknown): value is Error {
  return nativeError.isError?.(value) ?? value instanceof Error
}

const stringifyDirectTemplateValue: TemplateValueStringifier = String

const stringifySymbolTemplateValue = (value: unknown): string => {
  const symbol = value as symbol

  return symbol.description ?? symbol.toString()
}

const stringifyFunctionTemplateValue = (value: unknown): string =>
  (value as { readonly name: string }).name

const stringifyObjectTemplateValue = (value: unknown): string => {
  if (value === null) {
    return 'null'
  }

  return JSON.stringify(value) ?? Object.prototype.toString.call(value)
}

const templateValueStringifiers: Partial<Record<string, TemplateValueStringifier>> = {
  bigint: stringifyDirectTemplateValue,
  boolean: stringifyDirectTemplateValue,
  function: stringifyFunctionTemplateValue,
  number: stringifyDirectTemplateValue,
  object: stringifyObjectTemplateValue,
  string: stringifyDirectTemplateValue,
  symbol: stringifySymbolTemplateValue,
}

const stringifyTemplateValue = (value: unknown): string =>
  isRedacted(value)
    ? stringifyRedacted(value)
    : (templateValueStringifiers[typeof value]?.(value) ?? '')

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

const serializeTaggedValue = (value: unknown): unknown =>
  isRedacted(value) ? stringifyRedacted(value) : value

const serializeCause = (cause: unknown, seen = new Set<Error>()): unknown => {
  if (!isError(cause)) {
    return serializeTaggedValue(cause)
  }

  if (seen.has(cause)) {
    return { cause: '[Circular]', message: cause.message, name: cause.name, stack: cause.stack }
  }

  seen.add(cause)

  const json: Record<string, unknown> = {
    message: cause.message,
    name: cause.name,
    stack: cause.stack,
  }

  if (cause.cause !== undefined) {
    json['cause'] = serializeCause(cause.cause, seen)
  }

  return json
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
    public static readonly tag = options.name
    public readonly _tag = options.name
    public readonly fingerprint = [options.name, messageTemplate] as const
    public readonly messageTemplate = messageTemplate

    public constructor(props?: ConstructorProps<MessageTemplate>) {
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

    public static is(value: unknown): value is TaggedErrorInstance<Tag, MessageTemplate, Base> {
      return value instanceof this
    }

    public static err<
      This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate>) => Error,
    >(
      this: This,
      ...args: TaggedErrorConstructorArgs<MessageTemplate>
    ): ErrResult<never, InstanceType<This>> {
      const error = new this(...args) as InstanceType<This>
      return resultErr<never, InstanceType<This>>(error)
    }

    public findCause<T extends Error>(ErrorClass: ErrorClass<T>): T | undefined {
      return findCause(this, ErrorClass)
    }

    public toJSON(): object {
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
          json[key] = serializeTaggedValue(value)
        }
      }

      return json
    }
  }

  return GeneratedTaggedError as TaggedErrorClass<Tag, MessageTemplate, Base>
}

export const taggedEnum = <
  Members extends Record<string, object>,
>(): TaggedEnumFactory<Members> => {
  const target = {
    $is<Tag extends keyof Members>(
      tag: Tag,
      value: unknown,
    ): value is TaggedEnumMember<Members, Tag> {
      return (
        typeof value === 'object' &&
        value !== null &&
        '_tag' in value &&
        (value as { readonly _tag?: unknown })._tag === tag
      )
    },
    $match<ReturnType>(
      value: TaggedEnum<Members>,
      handlers: {
        readonly [Tag in keyof Members]: (value: TaggedEnumMember<Members, Tag>) => ReturnType
      },
    ): ReturnType {
      const handler = handlers[value._tag] as
        | ((value: TaggedEnum<Members>) => ReturnType)
        | undefined

      if (handler === undefined) {
        throw new Error(`No tagged enum handler for ${String(value._tag)}`)
      }

      return handler(value)
    },
  }

  return new Proxy(target, {
    get(base, property, receiver) {
      if (property in base) {
        return Reflect.get(base, property, receiver) as unknown
      }

      if (typeof property !== 'string') {
        return undefined
      }

      return (props?: object): object => {
        const value: Record<string, unknown> = { _tag: property }

        if (props !== undefined) {
          for (const [key, propValue] of Object.entries(props)) {
            if (key !== '_tag') {
              value[key] = propValue
            }
          }
        }

        return Object.freeze(value)
      }
    },
  }) as TaggedEnumFactory<Members>
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
