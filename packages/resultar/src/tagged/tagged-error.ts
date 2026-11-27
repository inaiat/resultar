import type { ErrResult } from '../result/result.js'

import {
  canUseJit,
  compileJitFunction,
  formatPropertyAccess,
  serializeStringLiteral,
} from '../core/jit.js'
import { isRedacted, stringifyRedacted, type Redacted } from '../core/redacted.js'
import { ResultTask } from '../task/result-task.js'
import { err as resultErr } from '../result/result.js'
import { getTaggedHandler, isError, matchTaggedOr } from './tagged-match.js'

export { isError } from './tagged-match.js'

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

// Templates without placeholders intentionally contribute no properties to the Error intersection.
/* eslint-disable typescript/no-generated-empty-object-type */
type TemplateProps<Template extends string> = [ExtractTemplateVariables<Template>] extends [never]
  ? Record<never, never>
  : Readonly<Record<ExtractTemplateVariables<Template>, string | number | Redacted<unknown>>>
/* eslint-enable typescript/no-generated-empty-object-type */
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
type MergeProps<Current, Next> = Next extends unknown
  ? Current extends unknown
    ? Omit<Current, keyof Next> & Next
    : never
  : never
type ConstructorProps<Template extends string, Props extends object = object> = MergeProps<
  TemplateProps<Template> & { readonly cause?: unknown },
  Props
>
type TaggedErrorConstructorArgs<Template extends string, Props extends object = object> =
  object extends ConstructorProps<Template, Props>
    ? [props?: ConstructorProps<Template, Props>]
    : [props: ConstructorProps<Template, Props>]
type InstanceProps<Props> = Props extends unknown
  ? { readonly [Key in keyof Props]: Key extends 'message' ? string : Props[Key] }
  : never
type ReservedMetadataKeys<Template extends string, Base extends Error> = Exclude<
  | keyof Base
  | 'constructor'
  | 'toString'
  | 'valueOf'
  | 'hasOwnProperty'
  | 'isPrototypeOf'
  | 'propertyIsEnumerable'
  | 'toLocaleString'
  | '__defineGetter__'
  | '__defineSetter__'
  | '__lookupGetter__'
  | '__lookupSetter__'
  | '_tag'
  | 'fingerprint'
  | 'messageTemplate'
  | 'findCause'
  | 'toJSON'
  | 'err'
  | 'is'
  | 'tag'
  | 'withProps'
  | '__proto__'
  | 'prototype'
  | 'then',
  Template extends typeof defaultMessageTemplate ? 'message' : never
>
type InvalidMetadataKeys<Props, Template extends string, Base extends Error> = Props extends unknown
  ? | Extract<keyof Props, ReservedMetadataKeys<Template, Base> | symbol>
    | (string extends keyof Props ? string : never)
    | (number extends keyof Props ? number : never)
    | {
        [Key in keyof Props]-?: Key extends ExtractTemplateVariables<Template>
          ? object extends Pick<Props, Key>
            ? Key
            : never
          : never
      }[keyof Props]
  : never

/** Configuration used to create a tagged `Error` class. */
export interface TaggedErrorOptions<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
> {
  /**
   * Optional base Error class to extend instead of native Error.
   */
  readonly extends?: ErrorBaseConstructor<Base>
  /**
   * Message template. `$prop` placeholders are filled from constructor props.
   */
  readonly message?: MessageTemplate
  /**
   * Stable runtime tag and Error name.
   */
  readonly name: Tag
  /**
   * Captures a V8 stack trace on instantiation when `true` (default).
   * Set to `false` for high-frequency expected domain errors (such as 404 or validation failures)
   * where stack capture overhead is unnecessary.
   */
  readonly captureStackTrace?: boolean
}

/**
 * Instance type produced by `createTaggedError`.
 */
export type TaggedErrorInstance<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
  Props extends object = object,
> = Base &
  InstanceProps<MergeProps<TemplateProps<MessageTemplate>, Props>> & {
    /**
     * Stable runtime tag.
     */
    readonly _tag: Tag
    /**
     * Stable identity for grouping errors by tag and message template.
     */
    readonly fingerprint: readonly [Tag, MessageTemplate]
    /**
     * Original message template before interpolation.
     */
    readonly messageTemplate: MessageTemplate
    /**
     * Finds a matching cause in the error cause chain.
     */
    findCause: <T extends Error>(ErrorClass: ErrorClass<T>) => T | undefined
    /**
     * Serializes the tagged error, metadata, and cause chain.
     */
    toJSON: () => object
  }

/**
 * Class type returned by `createTaggedError`.
 */
export type TaggedErrorClass<
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error = Error,
  Props extends object = object,
> = {
  new (
    ...args: TaggedErrorConstructorArgs<MessageTemplate, Props>
  ): TaggedErrorInstance<Tag, MessageTemplate, Base, Props>
  /**
   * Stable runtime tag.
   */
  readonly tag: Tag
  /**
   * Creates an Err containing this tagged error.
   */
  err: <This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate, Props>) => Error>(
    this: This,
    ...args: TaggedErrorConstructorArgs<MessageTemplate, Props>
  ) => ErrResult<never, ErrorClassInstance<This>>
  /**
   * Creates a failed ResultTask containing this tagged error.
   */
  taskErr: <
    This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate, Props>) => Error,
  >(
    this: This,
    ...args: TaggedErrorConstructorArgs<MessageTemplate, Props>
  ) => ResultTask<never, ErrorClassInstance<This>>
  /**
   * Narrows a value to this tagged error class.
   */
  is: {
    <This extends ErrorClass>(this: This, value: unknown): value is ErrorClassInstance<This>
    (value: unknown): value is TaggedErrorInstance<Tag, MessageTemplate, Base, Props>
  }
  /**
   * Creates a fresh sibling constructor with explicit metadata types. Specified fields replace
   * template defaults; unspecified template fields keep their inferred types. Template fields
   * must stay required; additional metadata may be optional. Cause uses the existing constructor
   * channel and cannot be specialized as metadata. String properties, including getters and non-enumerable or inherited fields, are
   * copied as readonly metadata while preserving Error fields and helpers. Input types are checked
   * by TypeScript, without runtime validation. Guards distinguish sibling classes.
   *
   * @example
   * ```ts
   * import { createTaggedError } from 'resultar'
   *
   * class HttpFailure extends createTaggedError({
   *   name: 'HttpFailure',
   *   message: 'HTTP $status on $endpoint',
   * }).withProps<{
   *   readonly status: 429 | 503
   *   readonly retryAfterMs?: number
   * }>() {}
   * ```
   */
  withProps: <Metadata extends object>(
    ...args: [InvalidMetadataKeys<Metadata, MessageTemplate, Base>] extends [never]
      ? []
      : [invalidMetadata: never]
  ) => TaggedErrorClass<Tag, MessageTemplate, Base, MergeProps<Props, Metadata>>
}

/**
 * Union of members produced by `taggedEnum`.
 */
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
/**
 * Factory returned by `taggedEnum`.
 */
export type TaggedEnumFactory<Members extends Record<string, object>> = {
  readonly [Tag in Exclude<keyof Members, 'then'>]: TaggedEnumConstructor<Members, Tag>
} & {
  /**
   * Narrows a value to a tagged enum member.
   */
  $is: <Tag extends keyof Members>(
    tag: Tag,
    value: unknown,
  ) => value is TaggedEnumMember<Members, Tag>
  /**
   * Exhaustively matches a tagged enum value.
   */
  $match: <ReturnType>(
    value: TaggedEnum<Members>,
    handlers: {
      readonly [Tag in keyof Members]: (value: TaggedEnumMember<Members, Tag>) => ReturnType
    },
  ) => ReturnType
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

const templateVariableMatcher = /\$(?<name>[a-zA-Z_][a-zA-Z0-9_]*)/gu
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

const stringifyDirectTemplateValue: TemplateValueStringifier = String

const stringifySymbolTemplateValue = (value: unknown): string => {
  const symbol = value as symbol

  return symbol.description ?? symbol.toString()
}

const stringifyFunctionTemplateValue = (value: unknown): string =>
  (value as { readonly name: string }).name

const stringifyObjectTemplateValue = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

type StringifiableTemplateValueType =
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'

const templateValueStringifiers: Record<StringifiableTemplateValueType, TemplateValueStringifier> =
  {
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
    : templateValueStringifiers[typeof value as StringifiableTemplateValueType](value)

interface ParsedTemplateSegment {
  readonly key: string
  readonly tail: string
}

interface ParsedMessageTemplate {
  readonly prefix: string
  readonly segments: readonly ParsedTemplateSegment[]
}

const parseMessageTemplate = (template: string): ParsedMessageTemplate => {
  templateVariableMatcher.lastIndex = 0
  const segments: ParsedTemplateSegment[] = []
  let match = templateVariableMatcher.exec(template)
  if (match === null) {
    return { prefix: template, segments }
  }

  const prefix = template.slice(0, match.index)
  while (match !== null) {
    const key = String(match[1])
    const end = match.index + match[0].length
    const next = templateVariableMatcher.exec(template)
    const tail = next === null ? template.slice(end) : template.slice(end, next.index)
    segments.push({ key, tail })
    match = next
  }

  return { prefix, segments }
}

const formatTemplateValue = (value: unknown): string => {
  /* Stryker disable all: primitive fast-paths are equivalent to stringifyTemplateValue(value). */
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  /* Stryker restore all */
  return stringifyTemplateValue(value)
}

const hasTemplateValue = (values: Record<string, unknown>, key: string): boolean => {
  if (Object.hasOwn(values, key)) return true
  if (Object.hasOwn(Object.prototype, key)) return false
  let current = Object.getPrototypeOf(values) as object | null
  while (current !== null && current !== Object.prototype) {
    if (Object.hasOwn(current, key)) return true
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

const buildFallbackInterpolator =
  (template: string, parsed: ParsedMessageTemplate) =>
  (values?: Record<string, unknown>): string => {
    if (values === undefined || values === null) return template
    let output = parsed.prefix

    for (const { key, tail } of parsed.segments) {
      const raw = hasTemplateValue(values, key) ? values[key] : undefined
      output += raw === undefined ? `$${key}` : formatTemplateValue(raw)
      output += tail
    }

    return output
  }

/* Stryker disable all: transparent JIT interpolator equivalent to buildFallbackInterpolator; parity verified by jit-performance.test.ts. */
const buildJitInterpolator = (
  template: string,
  parsed: ParsedMessageTemplate,
): ((values?: Record<string, unknown>) => string) | undefined => {
  if (!canUseJit()) return undefined
  const { prefix, segments } = parsed
  const lines = [`let output = ${serializeStringLiteral(prefix)};`]
  for (const { key, tail } of segments) {
    const keyLit = serializeStringLiteral(key)
    lines.push(`{ const value = Object.hasOwn(p, ${keyLit}) || hasValue(p, ${keyLit}) ? ${formatPropertyAccess('p', key)} : undefined;
      output += typeof value === "string" || typeof value === "number" ? value :
        value === undefined ? ${serializeStringLiteral(`$${key}`)} : format(value);
      ${tail === '' ? '' : `output += ${serializeStringLiteral(tail)};`} }`)
  }
  const body = `return function resultarInterpolate(p) {
    if (p === undefined || p === null) return ${serializeStringLiteral(template)};
    ${lines.join('\n')}
    return output;
  }`
  return compileJitFunction<(values?: Record<string, unknown>) => string>(
    ['format', 'hasValue'],
    body,
    [formatTemplateValue, hasTemplateValue],
  )
}
/* Stryker restore all */

const compileMessageInterpolator = (
  template: string,
): ((values?: Record<string, unknown>) => string) => {
  /* Stryker disable all: fast-path shortcuts for default $message and variable-free templates are equivalent to the general interpolator below. */
  if (template === defaultMessageTemplate) {
    return (values) => {
      if (values === undefined || values === null) return defaultMessageTemplate
      const raw = hasTemplateValue(values, 'message') ? values['message'] : undefined
      return raw === undefined ? defaultMessageTemplate : formatTemplateValue(raw)
    }
  }

  const parsed = parseMessageTemplate(template)
  if (parsed.segments.length === 0) {
    return () => template
  }
  /* Stryker restore all */

  return buildJitInterpolator(template, parsed) ?? buildFallbackInterpolator(template, parsed)
}

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

const readonlyDescriptor: PropertyDescriptor = {
  configurable: true,
  enumerable: true,
  value: undefined,
  writable: false,
}

const assignReadonly = (target: object, key: PropertyKey, value: unknown): void => {
  readonlyDescriptor.value = value
  /* Stryker disable all: clears cached descriptor reference immediately after defineProperty to prevent GC retention. */
  Object.defineProperty(target, key, readonlyDescriptor)
  readonlyDescriptor.value = undefined
  /* Stryker restore all */
}

const allReservedMetadataProperties = new Set<string>([
  ...reservedTemplateVariables,
  'err',
  'is',
  'tag',
  'withProps',
  'prototype',
  'then',
])

const shouldCopyMetadata = (target: object, owner: object, key: string): boolean =>
  !allReservedMetadataProperties.has(key) && owner !== Function.prototype && !(key in target)

const copyOwnMetadata = (target: object, props: Record<string, unknown>): void => {
  for (const key in props) {
    if (Object.hasOwn(props, key) && !allReservedMetadataProperties.has(key) && !(key in target)) {
      assignReadonly(target, key, props[key])
    }
  }
}

/* Stryker disable all: single-key fast-path is behaviorally equivalent to copyOwnMetadata. */
const copyOwnMetadataWithFastKey = (
  target: object,
  props: Record<string, unknown>,
  safeKey: string,
): void => {
  for (const key in props) {
    if (
      Object.hasOwn(props, key) &&
      (key === safeKey || (!allReservedMetadataProperties.has(key) && !(key in target)))
    ) {
      assignReadonly(target, key, props[key])
    }
  }
}
/* Stryker restore all */

const copyVisibleMetadata = (target: object, props: object): void => {
  /* Stryker disable all: plain-object fast path is equivalent to the prototype-walk loop below. */
  const proto: unknown = Object.getPrototypeOf(props)
  if (proto === Object.prototype || proto === null) {
    for (const key of Object.getOwnPropertyNames(props)) {
      if (shouldCopyMetadata(target, props, key)) {
        assignReadonly(target, key, Reflect.get(props, key))
      }
    }
    return
  }
  /* Stryker restore all */

  let current: object | null = props

  while (current !== null) {
    for (const key of Object.getOwnPropertyNames(current)) {
      if (shouldCopyMetadata(target, current, key)) {
        assignReadonly(target, key, Reflect.get(props, key))
      }
    }

    current = Object.getPrototypeOf(current) as object | null
  }
}

const TAGGED_ERROR_TO_JSON = Symbol('resultar.taggedError.toJSON')
const TAGGED_ERROR_DEFAULT_TO_JSON = Symbol('resultar.taggedError.defaultToJSON')

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

  if (TAGGED_ERROR_TO_JSON in cause) {
    const tagged = cause as unknown as {
      readonly toJSON: () => object
      readonly [TAGGED_ERROR_TO_JSON]: (visited: Set<Error>) => object
      readonly [TAGGED_ERROR_DEFAULT_TO_JSON]: () => object
    }
    return tagged.toJSON === tagged[TAGGED_ERROR_DEFAULT_TO_JSON]
      ? tagged[TAGGED_ERROR_TO_JSON](seen)
      : tagged.toJSON()
  }

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

/**
 * Finds the first cause in an Error cause chain that is an instance of `ErrorClass`.
 */
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

/**
 * Creates an Error class with a stable `_tag`, typed template props, cause support, and JSON output.
 *
 * Prefer tagged errors for domain failures that travel through Resultar error channels.
 *
 * @example
 * ```ts
 * class UserNotFoundError extends createTaggedError({
 *   name: "UserNotFoundError",
 *   message: "User $id was not found",
 * }) {}
 * ```
 */
export function createTaggedError<
  const Tag extends string,
  const MessageTemplate extends string = typeof defaultMessageTemplate,
  Base extends Error = Error,
>(
  options: Omit<TaggedErrorOptions<Tag, MessageTemplate, Base>, 'message'> & {
    readonly message?: RejectReservedTemplateVariables<MessageTemplate>
  },
): TaggedErrorClass<Tag, MessageTemplate, Base> {
  return createTaggedErrorClass(options, false)
}

const createTaggedErrorClass = <
  Tag extends string,
  MessageTemplate extends string,
  Base extends Error,
>(
  options: TaggedErrorOptions<Tag, MessageTemplate, Base>,
  explicitProps: boolean,
): TaggedErrorClass<Tag, MessageTemplate, Base> => {
  const BaseError = options.extends ?? defaultBaseError
  const messageTemplate = options.message ?? (defaultMessageTemplate as MessageTemplate)
  const skipStackTrace = options.captureStackTrace === false
  assertNoReservedTemplateVariables(options.name, messageTemplate)
  const interpolate = compileMessageInterpolator(messageTemplate)
  const sharedFingerprint = Object.freeze([options.name, messageTemplate] as const)
  /* Stryker disable all: single-key fast-path is behaviorally equivalent to copyOwnMetadata. */
  const templateVariables =
    messageTemplate === defaultMessageTemplate ? [] : getTemplateVariableNames(messageTemplate)
  const firstTemplateVariable = templateVariables[0]
  const singleSafeTemplateKey =
    !explicitProps &&
    BaseError === defaultBaseError &&
    templateVariables.length === 1 &&
    firstTemplateVariable !== undefined &&
    !allReservedMetadataProperties.has(firstTemplateVariable) &&
    !(firstTemplateVariable in defaultBaseError.prototype)
      ? firstTemplateVariable
      : undefined
  /* Stryker restore all */

  class GeneratedTaggedError extends BaseError {
    public static readonly tag = options.name
    public readonly _tag = options.name
    public readonly fingerprint = sharedFingerprint
    public readonly messageTemplate = messageTemplate

    /* eslint-disable unicorn/custom-error-definition -- 1-arg super avoids options overhead when cause is absent; name is always set explicitly. */
    public constructor(props?: ConstructorProps<MessageTemplate>) {
      const message = interpolate(props)
      const cause = props?.cause
      let previousLimit: number | undefined = undefined
      if (skipStackTrace) {
        previousLimit = Error.stackTraceLimit
        Error.stackTraceLimit = 0
      }
      if (cause === undefined) {
        super(message)
      } else {
        super(message, { cause })
      }
      if (previousLimit !== undefined) {
        Error.stackTraceLimit = previousLimit
      }
      this.name = options.name

      if (props) {
        if (explicitProps) {
          copyVisibleMetadata(this, props)
        } else {
          /* Stryker disable all: single-key fast-path is behaviorally equivalent to copyOwnMetadata. */
          const record = props as Record<string, unknown>
          if (singleSafeTemplateKey === undefined) {
            copyOwnMetadata(this, record)
          } else {
            copyOwnMetadataWithFastKey(this, record, singleSafeTemplateKey)
          }
          /* Stryker restore all */
        }
      }
    }
    /* eslint-enable unicorn/custom-error-definition */

    /**
     * Narrows a value to this tagged error class.
     */
    public static is<This extends ErrorClass>(
      this: This,
      value: unknown,
    ): value is ErrorClassInstance<This> {
      return value instanceof this
    }

    /** Creates a distinct constructor from this factory's configuration, without runtime validation. */
    public static withProps(): TaggedErrorClass<Tag, MessageTemplate, Base> {
      return createTaggedErrorClass(options, true)
    }

    /**
     * Creates an Err containing this tagged error.
     */
    public static err<
      This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate>) => Error,
    >(
      this: This,
      ...args: TaggedErrorConstructorArgs<MessageTemplate>
    ): ErrResult<never, InstanceType<This>> {
      const error = new this(...args) as InstanceType<This>
      return resultErr<never, InstanceType<This>>(error)
    }

    /**
     * Creates a failed ResultTask containing this tagged error.
     */
    public static taskErr<
      This extends new (...args: TaggedErrorConstructorArgs<MessageTemplate>) => Error,
    >(
      this: This,
      ...args: TaggedErrorConstructorArgs<MessageTemplate>
    ): ResultTask<never, InstanceType<This>> {
      const error = new this(...args) as InstanceType<This>
      return ResultTask.err<never, InstanceType<This>>(error)
    }

    /**
     * Finds a matching cause in this error's cause chain.
     */
    public findCause<T extends Error>(ErrorClass: ErrorClass<T>): T | undefined {
      return findCause(this, ErrorClass)
    }

    /**
     * Serializes the tagged error, metadata, and cause chain.
     */
    public toJSON(): object {
      return this[TAGGED_ERROR_TO_JSON](new Set<Error>([this]))
    }

    public [TAGGED_ERROR_TO_JSON](seen: Set<Error>): object {
      const json: Record<string, unknown> = {
        _tag: this._tag,
        fingerprint: this.fingerprint,
        message: this.message,
        messageTemplate: this.messageTemplate,
        name: this.name,
      }

      if (this.cause !== undefined) {
        json['cause'] = serializeCause(this.cause, seen)
      }

      for (const [key, value] of Object.entries(this)) {
        if (!Object.hasOwn(json, key) && key !== 'cause' && key !== 'stack') {
          Object.defineProperty(json, key, {
            value: serializeTaggedValue(value),
            enumerable: true,
            writable: true,
            configurable: true,
          })
        }
      }

      return json
    }
  }

  Object.defineProperty(GeneratedTaggedError.prototype, TAGGED_ERROR_DEFAULT_TO_JSON, {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Store the method identity for nested cause serialization.
    value: GeneratedTaggedError.prototype.toJSON,
  })

  return GeneratedTaggedError as unknown as TaggedErrorClass<Tag, MessageTemplate, Base>
}

const makeTaggedEnumIgnoringInputTag = (tag: string, props: object): object => {
  const value: Record<PropertyKey, unknown> = { _tag: tag }
  const fields = props as Record<PropertyKey, unknown>
  // Define existing keys directly to bypass inherited setters. The frozen result has the same
  // descriptors for other keys, so those can use ordinary assignment.
  for (const key in props) {
    if (key !== '_tag' && Object.hasOwn(props, key)) {
      const field = fields[key]
      // Stryker disable next-line ConditionalExpression: defining every key yields the same frozen fields, with extra descriptor work.
      if (key in value) assignReadonly(value, key, field)
      else value[key] = field
    }
  }
  for (const key of Object.getOwnPropertySymbols(props)) {
    if (Object.prototype.propertyIsEnumerable.call(props, key)) {
      const field = fields[key]
      // Stryker disable next-line ConditionalExpression: defining every symbol yields the same frozen fields, with extra descriptor work.
      if (key in value) assignReadonly(value, key, field)
      else value[key] = field
    }
  }
  return Object.freeze(value)
}

/**
 * Creates a lightweight discriminated-union factory with frozen member constructors, `$is`, and `$match`.
 *
 * @example
 * ```ts
 * import { taggedEnum } from 'resultar'
 *
 * const PaymentState = taggedEnum<{
 *   Pending: { readonly id: string }
 *   Settled: { readonly id: string; readonly amount: number }
 * }>()
 *
 * const state = PaymentState.Settled({ id: 'pay_1', amount: 4200 })
 * PaymentState.$match(state, {
 *   Pending: ({ id }) => `waiting:${id}`,
 *   Settled: ({ amount }) => `paid:${amount}`,
 * })
 * ```
 */
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
      const handler = getTaggedHandler<ReturnType>(value, handlers)
      if (handler === undefined) {
        const tag =
          typeof value === 'object' && value !== null && '_tag' in value
            ? (value as { readonly _tag?: unknown })._tag
            : value
        throw new Error(`No tagged enum handler for ${String(tag)}`)
      }
      return handler(value)
    },
  }

  const constructors = new Map<string, (props?: object) => object>()

  return new Proxy(target, {
    get(base, property, receiver) {
      if (Object.hasOwn(base, property)) {
        return Reflect.get(base, property, receiver) as unknown
      }

      if (typeof property !== 'string' || property === 'then') {
        return undefined
      }

      let ctor = constructors.get(property)
      if (ctor === undefined) {
        ctor = (props?: object): object => {
          if (props === undefined || props === null) return Object.freeze({ _tag: property })
          // eslint-disable-next-line oxc/no-rest-spread-properties -- Spread defines own data properties without invoking inherited setters.
          if (!Object.hasOwn(props, '_tag')) return Object.freeze({ _tag: property, ...props })
          return makeTaggedEnumIgnoringInputTag(property, props)
        }
        constructors.set(property, ctor)
      }

      return ctor
    },
  }) as TaggedEnumFactory<Members>
}

/**
 * Exhaustively matches an `Error` union by its `_tag` property, with an optional native `Error` handler.
 *
 * Throws the original error when no handler matches at runtime.
 *
 * @example
 * ```ts
 * import { matchError } from 'resultar'
 *
 * const status = matchError(error, {
 *   NotFoundError: () => 404,
 *   ValidationError: () => 400,
 * })
 * ```
 */
export const matchError = <ErrorType extends Error, ReturnType>(
  error: ErrorType,
  handlers: MatchHandlers<ErrorType, ReturnType>,
): ReturnType =>
  matchTaggedOr(error, handlers, () => {
    throw error
  })

/**
 * Partially matches an `Error` union by `_tag`, falling back to `handlers.Error` and finally `fallback`.
 *
 * @example
 * ```ts
 * import { matchErrorPartial } from 'resultar'
 *
 * const status = matchErrorPartial(
 *   error,
 *   { NotFoundError: () => 404 },
 *   () => 500,
 * )
 * ```
 */
export const matchErrorPartial = <ErrorType extends Error, ReturnType>(
  error: ErrorType,
  handlers: PartialMatchHandlers<ErrorType, ReturnType>,
  fallback: (error: ErrorType) => ReturnType,
): ReturnType => matchTaggedOr(error, handlers, fallback)
