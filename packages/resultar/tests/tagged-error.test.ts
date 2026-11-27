import { deepEqual, equal, ok as isTrue, throws } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { ErrResult, Redacted, ResultTask, TaggedEnum } from '../src/index.js'

import {
  Result,
  ResultTask as ResultTaskValue,
  createTaggedError,
  findCause,
  isError,
  matchError,
  matchErrorPartial,
  taggedEnum,
} from '../src/index.js'

class UserNotFoundError extends createTaggedError({
  message: 'User $id not found in $source',
  name: 'UserNotFoundError',
}) {}

class DatabaseError extends createTaggedError({
  message: 'Database operation $operation failed',
  name: 'DatabaseError',
}) {}

class StaticMessageError extends createTaggedError({
  message: 'Static failure',
  name: 'StaticMessageError',
}) {}

class DynamicMessageError extends createTaggedError({ name: 'DynamicMessageError' }) {}

class AppError extends Error {
  public statusCode = 500
}

class ForbiddenError extends createTaggedError({
  extends: AppError,
  message: 'Missing permission $permission',
  name: 'ForbiddenError',
}) {
  public override statusCode = 403
}

const createKnownTaggedError = (): UserNotFoundError | DatabaseError =>
  new UserNotFoundError({ id: '789', source: 'users' })

const createUnknownTaggedError = (): UserNotFoundError | DatabaseError =>
  new DatabaseError({ operation: 'write' })

it('constructs tagged variants whose names also exist on Object.prototype', () => {
  const names = taggedEnum<{ constructor: object; toString: object; __proto__: object }>()
  for (const tag of ['constructor', 'toString', '__proto__'] as const) {
    const value = names[tag]({})
    equal(value._tag, tag)
    equal(names.$is(tag, value), true)
  }
})

it('copies enumerable enum fields as own data without invoking inherited setters', () => {
  const key = 'resultarEnumSetterProbe'
  const symbol = Symbol(key)
  const hidden = Symbol('hidden')
  const setter = (): never => {
    throw new Error('inherited setter ran')
  }
  const descriptor = { configurable: true, set: setter }
  const items = taggedEnum<{ Item: { [key]: number; [symbol]: number } }>()
  /* eslint-disable no-extend-native -- Reproduce an inherited setter and restore the prototype. */
  Object.defineProperty(Object.prototype, key, descriptor)
  Object.defineProperty(Object.prototype, symbol, descriptor)
  /* eslint-enable no-extend-native */
  try {
    const fields = { [key]: 1, [symbol]: 2 }
    const reserved = {
      [key]: 1,
      [symbol]: 2,
      get _tag(): never {
        throw new Error('reserved getter ran')
      },
    }
    for (const props of [fields, reserved]) {
      Object.defineProperty(props, hidden, { value: 'hidden' })
      const item = items.Item(props)
      deepEqual(item, { _tag: 'Item', [key]: 1, [symbol]: 2 })
      deepEqual(Reflect.ownKeys(item), ['_tag', key, symbol])
      equal(Object.isFrozen(item), true)
    }
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
    Reflect.deleteProperty(Object.prototype, symbol)
  }
})

describe('tagged errors', async () => {
  it('concatenates adjacent numeric placeholders', () => {
    const Adjacent = createTaggedError({ name: 'Adjacent', message: '$a$b failed' })
    equal(new Adjacent({ a: 10, b: 20 }).message, '1020 failed')
  })

  it('creates a typed Error subclass with interpolated props', () => {
    const error = new UserNotFoundError({ id: '123', source: 'users' })

    isTrue(error instanceof Error)
    isTrue(error instanceof UserNotFoundError)
    equal(error.name, 'UserNotFoundError')
    equal(error._tag, 'UserNotFoundError')
    equal(error.message, 'User 123 not found in users')
    equal(error.id, '123')
    equal(error.source, 'users')
    deepEqual(error.fingerprint, ['UserNotFoundError', 'User $id not found in $source'])
    equal(error.messageTemplate, 'User $id not found in $source')

    const idDescriptor = Object.getOwnPropertyDescriptor(error, 'id')

    isTrue(idDescriptor)
    deepEqual(
      {
        configurable: idDescriptor.configurable,
        enumerable: idDescriptor.enumerable,
        writable: idDescriptor.writable,
      },
      { configurable: true, enumerable: true, writable: false },
    )
  })

  it('keeps causes and finds nested causes by class', () => {
    const cause = new UserNotFoundError({ id: '456', source: 'users' })
    const error = new DatabaseError({ cause, operation: 'read' })

    equal(error.cause, cause)
    equal(error.findCause(UserNotFoundError), cause)
    equal(findCause(error, UserNotFoundError), cause)
  })

  it('stops searching circular cause chains safely', () => {
    const root = new Error('root')
    const wrapped = new Error('wrapped', { cause: root })

    Object.defineProperty(root, 'cause', { configurable: true, value: wrapped })

    equal(findCause(wrapped, TypeError), undefined)
  })

  it('still finds nested causes before circular cause chains repeat', () => {
    const target = new TypeError('target')
    const wrapped = new Error('wrapped', { cause: target })

    Object.defineProperty(target, 'cause', { configurable: true, value: wrapped })

    equal(findCause(wrapped, TypeError), target)
  })

  it('supports custom base error classes', () => {
    const error = new ForbiddenError({ permission: 'admin:write' })

    isTrue(error instanceof ForbiddenError)
    isTrue(error instanceof AppError)
    equal(error.statusCode, 403)
    equal(error.permission, 'admin:write')
  })

  it('creates Result.err values from the static err helper', () => {
    const result = UserNotFoundError.err({ id: '123', source: 'users' })

    isTrue(result instanceof Result)
    isTrue(result.isErr())
    isTrue(result.error instanceof UserNotFoundError)
    equal(result.error.message, 'User 123 not found in users')
    equal(result.error.id, '123')
  })

  it('supports static err for templates without variables', () => {
    const result = StaticMessageError.err()

    isTrue(result.isErr())
    isTrue(result.error instanceof StaticMessageError)
    equal(result.error.message, 'Static failure')
  })

  it('creates ResultTask failures from static taskErr helpers', async () => {
    const task = UserNotFoundError.taskErr({ id: '456', source: 'accounts' })
    const resolvedTask = await ResultTaskValue.runResult(task)

    isTrue(resolvedTask.isErr())
    isTrue(resolvedTask.error instanceof UserNotFoundError)
    equal(resolvedTask.error.message, 'User 456 not found in accounts')
    equal(resolvedTask.error.id, '456')

    const staticTaskResult = await ResultTaskValue.runResult(StaticMessageError.taskErr())
    isTrue(staticTaskResult.isErr())
    equal(staticTaskResult.error.message, 'Static failure')
  })

  it('supports dynamic messages when the message template is omitted', () => {
    const error = new DynamicMessageError({ message: 'Dynamic failure' })
    const result = DynamicMessageError.err({ message: 'Result failure' })
    const RuntimeDynamicError = createTaggedError({ name: 'RuntimeDynamicError' })
    const runtimeError = new RuntimeDynamicError({ message: 'Runtime failure' })

    equal(error.message, 'Dynamic failure')
    equal('cause' in error, false)
    equal(error.messageTemplate, '$message')
    deepEqual(error.fingerprint, ['DynamicMessageError', '$message'])
    equal(runtimeError.message, 'Runtime failure')
    isTrue(result.isErr())
    equal(result.error.message, 'Result failure')
  })

  it('stringifies runtime template values consistently', () => {
    const RuntimeValueError = createTaggedError({
      message: 'Values $text $count $flag $big $symbol $fn $object $nil $missing $unknown',
      name: 'RuntimeValueError',
    })
    const UnsafeConstructor = RuntimeValueError as unknown as new (
      props: Record<string, unknown>,
    ) => Error
    const namedTemplateValue = (): void => undefined
    const error = new UnsafeConstructor({
      big: 10n,
      count: 1,
      flag: false,
      fn: namedTemplateValue,
      nil: null,
      object: { ok: true },
      symbol: Symbol('sym'),
      text: 'text',
      unknown: undefined,
    })

    equal(
      error.message,
      'Values text 1 false 10 sym namedTemplateValue {"ok":true} null $missing $unknown',
    )
  })

  it('matches tagged error unions exhaustively', () => {
    const error = createKnownTaggedError()

    const message = matchError(error, {
      DatabaseError: (err) => `database: ${err.operation}`,
      UserNotFoundError: (err) => `user: ${err.id}`,
    })

    equal(message, 'user: 789')
  })

  it('only dispatches prototype-shaped tags to explicitly supplied handlers', () => {
    for (const tag of ['toString', 'constructor', '__proto__']) {
      const problem = Object.assign(new Error('fallback'), { _tag: tag })
      equal(
        matchErrorPartial(problem, {} as never, (e) => e.message),
        'fallback',
      )
      equal(
        matchErrorPartial(problem, { [tag]: () => 'handled' } as never, () => 'fallback'),
        'handled',
      )
      deepEqual(ResultTaskValue.err(problem).catchTags({}).runSync(), Result.err(problem))
    }
  })

  it('matches partial handlers with fallback', () => {
    const error = createUnknownTaggedError()

    const message = matchErrorPartial(
      error,
      { UserNotFoundError: (err) => `user: ${err.id}` },
      (err) => `fallback: ${err.message}`,
    )

    equal(message, 'fallback: Database operation write failed')
  })

  it('does not treat untagged errors with spoofed tag shapes as tagged matches', () => {
    const missingTag = new Error('missing tag')
    const numericTag = new Error('numeric tag')

    Object.defineProperty(numericTag, '_tag', { configurable: true, value: 123 })

    equal(
      matchError(missingTag, {
        Error: (error: Error) => `error: ${error.message}`,
        undefined: () => 'bad undefined tag',
      } as never),
      'error: missing tag',
    )
    equal(
      matchError(numericTag, {
        123: () => 'bad numeric tag',
        Error: (error: Error) => `error: ${error.message}`,
      } as never),
      'error: numeric tag',
    )
    equal(
      matchErrorPartial(
        missingTag,
        { undefined: () => 'bad undefined tag' } as never,
        (error) => `fallback: ${error.message}`,
      ),
      'fallback: missing tag',
    )
    equal(
      matchErrorPartial(
        numericTag,
        { 123: () => 'bad numeric tag' } as never,
        (error) => `fallback: ${error.message}`,
      ),
      'fallback: numeric tag',
    )
  })

  it('uses static guards and serializes predictable metadata', () => {
    const cause = new Error('root')
    const error = new UserNotFoundError({ cause, id: '123', source: 'users' })
    const causeLikeProp = new UserNotFoundError({ id: '456', source: 'users' })
    const spoofed = new Error('spoofed')

    Object.defineProperty(spoofed, '_tag', { configurable: true, value: 'UserNotFoundError' })
    Object.defineProperty(error, 'cause', { configurable: true, enumerable: true, value: cause })
    Object.defineProperty(error, 'stack', {
      configurable: true,
      enumerable: true,
      value: 'spoofed stack',
    })

    isTrue(UserNotFoundError.is(error))
    equal(UserNotFoundError.is(spoofed), false)
    isTrue(isError(error))
    deepEqual(error.toJSON(), {
      _tag: 'UserNotFoundError',
      cause: { message: 'root', name: 'Error', stack: cause.stack },
      fingerprint: ['UserNotFoundError', 'User $id not found in $source'],
      id: '123',
      message: 'User 123 not found in users',
      messageTemplate: 'User $id not found in $source',
      name: 'UserNotFoundError',
      source: 'users',
    })

    Object.defineProperty(causeLikeProp, 'cause', {
      configurable: true,
      enumerable: true,
      value: undefined,
    })

    const json = causeLikeProp.toJSON() as Record<string, unknown>

    equal('cause' in json, false)
  })

  it('rejects reserved template variables and ignores reserved runtime props', () => {
    const unsafeCreateTaggedError = createTaggedError as unknown as (options: {
      readonly message: string
      readonly name: string
    }) => unknown

    throws(
      () => unsafeCreateTaggedError({ message: 'Bad $name', name: 'BadNameError' }),
      /reserved template variable \$name/u,
    )

    const UnsafeConstructor = UserNotFoundError as unknown as new (
      props: Record<string, unknown>,
    ) => UserNotFoundError
    const cause = new Error('safe cause')
    const error = new UnsafeConstructor({
      _tag: 'SpoofedTag',
      cause,
      fingerprint: ['spoofed'],
      id: '123',
      message: 'spoofed message',
      messageTemplate: 'spoofed template',
      name: 'SpoofedName',
      source: 'users',
      stack: 'spoofed stack',
    })

    equal(error._tag, 'UserNotFoundError')
    equal(error.name, 'UserNotFoundError')
    equal(error.message, 'User 123 not found in users')
    equal(error.messageTemplate, 'User $id not found in $source')
    deepEqual(error.fingerprint, ['UserNotFoundError', 'User $id not found in $source'])
    equal(error.cause, cause)
    equal(error.id, '123')
    equal(error.source, 'users')
  })

  it('defines _tag, fingerprint, messageTemplate, and name as own enumerable properties preserved by spread', () => {
    const Missing = createTaggedError({ name: 'Missing' })
    const missingA = new Missing({ message: 'first missing' })
    const missingB = new Missing({ message: 'second missing' })
    const staticA = new StaticMessageError()
    const staticB = new StaticMessageError()
    const expectedKeys = ['_tag', 'fingerprint', 'messageTemplate', 'name'] as const

    for (const key of expectedKeys) {
      isTrue(Object.hasOwn(missingA, key))
      isTrue(Object.hasOwn(staticA, key))
      const desc = Object.getOwnPropertyDescriptor(missingA, key)
      isTrue(desc)
      deepEqual(
        { configurable: desc.configurable, enumerable: desc.enumerable, writable: desc.writable },
        { configurable: true, enumerable: true, writable: true },
      )
    }

    deepEqual(Object.keys(missingA), [...expectedKeys])
    deepEqual(Object.keys(staticA), [...expectedKeys])
    isTrue(Object.isFrozen(missingA.fingerprint))
    equal(missingA.fingerprint, missingB.fingerprint)
    equal(staticA.fingerprint, staticB.fingerprint)

    /* eslint-disable oxc/no-rest-spread-properties, typescript/no-misused-spread -- Explicitly testing object-spread cloning of tagged error instances. */
    deepEqual(
      { ...missingA },
      {
        _tag: 'Missing',
        fingerprint: ['Missing', '$message'],
        messageTemplate: '$message',
        name: 'Missing',
      },
    )
    deepEqual(
      { ...new UserNotFoundError({ id: '99', source: 'db' }) },
      {
        _tag: 'UserNotFoundError',
        fingerprint: ['UserNotFoundError', 'User $id not found in $source'],
        id: '99',
        messageTemplate: 'User $id not found in $source',
        name: 'UserNotFoundError',
        source: 'db',
      },
    )
    /* eslint-enable oxc/no-rest-spread-properties, typescript/no-misused-spread */
    deepEqual(missingA.toJSON(), {
      _tag: 'Missing',
      fingerprint: ['Missing', '$message'],
      message: 'first missing',
      messageTemplate: '$message',
      name: 'Missing',
    })
  })

  it('preserves own enumerable metadata descriptors, spread, cause, and toJSON on custom base error classes', () => {
    const rootCause = new Error('policy denied')
    const forbiddenA = new ForbiddenError({ permission: 'admin:write' })
    const forbiddenB = new ForbiddenError({ cause: rootCause, permission: 'admin:read' })

    for (const key of ['_tag', 'fingerprint', 'messageTemplate', 'name'] as const) {
      isTrue(Object.hasOwn(forbiddenA, key))
      const desc = Object.getOwnPropertyDescriptor(forbiddenA, key)
      isTrue(desc)
      deepEqual(
        { configurable: desc.configurable, enumerable: desc.enumerable, writable: desc.writable },
        { configurable: true, enumerable: true, writable: true },
      )
    }

    deepEqual(Object.keys(forbiddenA), [
      'statusCode',
      '_tag',
      'fingerprint',
      'messageTemplate',
      'name',
      'permission',
    ])
    isTrue(Object.isFrozen(forbiddenA.fingerprint))
    equal(forbiddenA.fingerprint, forbiddenB.fingerprint)
    equal(forbiddenB.cause, rootCause)
    /* eslint-disable oxc/no-rest-spread-properties, typescript/no-misused-spread -- Explicitly testing object-spread cloning of custom-base tagged errors. */
    deepEqual(
      { ...forbiddenA },
      {
        _tag: 'ForbiddenError',
        fingerprint: ['ForbiddenError', 'Missing permission $permission'],
        messageTemplate: 'Missing permission $permission',
        name: 'ForbiddenError',
        permission: 'admin:write',
        statusCode: 403,
      },
    )
    /* eslint-enable oxc/no-rest-spread-properties, typescript/no-misused-spread */
    deepEqual(forbiddenB.toJSON(), {
      _tag: 'ForbiddenError',
      cause: { message: 'policy denied', name: 'Error', stack: rootCause.stack },
      fingerprint: ['ForbiddenError', 'Missing permission $permission'],
      message: 'Missing permission admin:read',
      messageTemplate: 'Missing permission $permission',
      name: 'ForbiddenError',
      permission: 'admin:read',
      statusCode: 403,
    })
  })

  it('supports opting out of stack trace capture while preserving error metadata and stackTraceLimit', () => {
    const LightweightNotFoundError = createTaggedError({
      name: 'LightweightNotFoundError',
      message: 'Missing item $code',
      captureStackTrace: false,
    })
    const DefaultStackNotFoundError = createTaggedError({
      name: 'DefaultStackNotFoundError',
      message: 'Missing item $code',
    })
    const ExplicitStackNotFoundError = createTaggedError({
      name: 'ExplicitStackNotFoundError',
      message: 'Missing item $code',
      captureStackTrace: true,
    })
    const LightweightWithPropsError = createTaggedError({
      name: 'LightweightWithPropsError',
      message: 'Missing item $code',
      captureStackTrace: false,
    }).withProps<{ readonly reason?: string }>()

    const originalLimit = Error.stackTraceLimit
    Error.stackTraceLimit = 7
    try {
      const cause = new Error('upstream')
      const error = new LightweightNotFoundError({ code: 'abc123', cause })
      equal(Error.stackTraceLimit, 7)
      equal(error.stack?.includes('\n    at '), false)

      const defaultError = new DefaultStackNotFoundError({ code: 'def' })
      equal(Error.stackTraceLimit, 7)
      equal(defaultError.stack?.includes('\n    at '), true)

      const explicitError = new ExplicitStackNotFoundError({ code: 'ghi' })
      equal(Error.stackTraceLimit, 7)
      equal(explicitError.stack?.includes('\n    at '), true)

      const withProps = new LightweightWithPropsError({ code: 'xyz', reason: 'expired' })
      equal(Error.stackTraceLimit, 7)
      equal(withProps.stack?.includes('\n    at '), false)

      equal(error instanceof Error, true)
      equal(error instanceof LightweightNotFoundError, true)
      equal(error._tag, 'LightweightNotFoundError')
      equal(error.name, 'LightweightNotFoundError')
      equal(error.message, 'Missing item abc123')
      equal(error.code, 'abc123')
      equal(error.cause, cause)
      equal(Object.getOwnPropertyDescriptor(error, 'code')?.writable, false)
      equal(withProps._tag, 'LightweightWithPropsError')
      equal(withProps.reason, 'expired')
      equal(Object.getOwnPropertyDescriptor(withProps, 'reason')?.writable, false)
    } finally {
      Error.stackTraceLimit = originalLimit
    }
  })

  it('restores Error.stackTraceLimit when a base constructor throws and preserves an absent limit', () => {
    const baseFailure = new Error('base constructor failure')
    class ThrowingBaseError extends Error {
      public constructor() {
        super('unused')
        throw baseFailure
      }
    }
    const FailingTaggedError = createTaggedError({
      name: 'FailingTaggedError',
      message: 'Failed $code',
      extends: ThrowingBaseError,
      captureStackTrace: false,
    })
    const LightweightTaggedError = createTaggedError({
      name: 'LightweightTaggedError',
      message: 'Lightweight $code',
      captureStackTrace: false,
    })

    const originalDescriptor = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit')
    Error.stackTraceLimit = 7
    try {
      throws(
        () => new FailingTaggedError({ code: 'boom' }),
        (thrown) => thrown === baseFailure,
      )
      equal(Error.stackTraceLimit, 7)
      equal(new Error('subsequent').stack?.includes('\n    at '), true)

      delete (Error as { stackTraceLimit?: number }).stackTraceLimit
      equal(Object.hasOwn(Error, 'stackTraceLimit'), false)

      const lightweight = new LightweightTaggedError({ code: 'absent' })
      equal(lightweight.message, 'Lightweight absent')
      equal(Object.hasOwn(Error, 'stackTraceLimit'), false)
      equal('stackTraceLimit' in Error, false)

      throws(
        () => new FailingTaggedError({ code: 'absent-boom' }),
        (thrown) => thrown === baseFailure,
      )
      equal(Object.hasOwn(Error, 'stackTraceLimit'), false)
      equal('stackTraceLimit' in Error, false)
    } finally {
      if (originalDescriptor === undefined) {
        delete (Error as { stackTraceLimit?: number }).stackTraceLimit
      } else {
        Object.defineProperty(Error, 'stackTraceLimit', originalDescriptor)
      }
    }
  })

  it('preserves inherited toJSON and subclass methods when single-key metadata collides', () => {
    const ToJsonTemplateError = createTaggedError({
      name: 'ToJsonTemplateError',
      message: 'Serialize $toJSON',
    })
    const serialized = new ToJsonTemplateError({ toJSON: 'payload' })
    equal(serialized.message, 'Serialize payload')
    equal(typeof serialized.toJSON, 'function')
    deepEqual(serialized.toJSON(), {
      _tag: 'ToJsonTemplateError',
      fingerprint: ['ToJsonTemplateError', 'Serialize $toJSON'],
      message: 'Serialize payload',
      messageTemplate: 'Serialize $toJSON',
      name: 'ToJsonTemplateError',
    })

    const SubclassBase = createTaggedError({
      name: 'SubclassMethodError',
      message: 'Action $format failed',
    }) as unknown as new (props: {
      readonly format: string
    }) => Error & { readonly _tag: 'SubclassMethodError' }
    class SubclassMethodError extends SubclassBase {
      public format(): string {
        return `formatted:${this.message}`
      }
    }
    const subclassError = new SubclassMethodError({ format: 'override' })
    equal(subclassError.message, 'Action override failed')
    equal(subclassError.format(), 'formatted:Action override failed')
  })
})

describe('tagged error types', async () => {
  it('supports lightweight tagged enum domain types', () => {
    type PaymentError = TaggedEnum<{
      CardDeclined: { readonly code: string }
      InsufficientFunds: { readonly balance: number }
    }>

    const error: PaymentError = { _tag: 'CardDeclined', code: 'card_declined' }

    expectTypeOf(error._tag).toEqualTypeOf<'CardDeclined'>()
    expectTypeOf(error.code).toEqualTypeOf<string>()

    if (false) {
      // @ts-expect-error CardDeclined requires code.
      const missingCode: PaymentError = { _tag: 'CardDeclined' }

      // @ts-expect-error _tag is readonly.
      error._tag = 'InsufficientFunds'

      JSON.stringify(missingCode)
    }
  })

  it('infers template props and narrows handlers', () => {
    const error = new UserNotFoundError({ id: '123', source: 'users' })
    const defaultResult = UserNotFoundError.err({ id: '123', source: 'users' })
    const defaultTaskResult = UserNotFoundError.taskErr({ id: '123', source: 'users' })
    const assignableResult: Result<string, UserNotFoundError> = UserNotFoundError.err({
      id: '123',
      source: 'users',
    })

    expectTypeOf(error.id).toEqualTypeOf<string | number | Redacted<unknown>>()
    expectTypeOf(error.source).toEqualTypeOf<string | number | Redacted<unknown>>()
    expectTypeOf(defaultResult).toEqualTypeOf<ErrResult<never, UserNotFoundError>>()
    expectTypeOf(defaultResult.error).toEqualTypeOf<UserNotFoundError>()
    expectTypeOf(defaultTaskResult).toEqualTypeOf<ResultTask<never, UserNotFoundError, never>>()
    if (assignableResult.isErr()) {
      expectTypeOf(assignableResult.error).toEqualTypeOf<UserNotFoundError>()
    }

    const union = error as UserNotFoundError | DatabaseError
    matchError(union, {
      DatabaseError: (err) => {
        expectTypeOf(err.operation).toEqualTypeOf<string | number | Redacted<unknown>>()
        return err.message
      },
      UserNotFoundError: (err) => {
        expectTypeOf(err.id).toEqualTypeOf<string | number | Redacted<unknown>>()
        return err.message
      },
    })
  })

  it('rejects invalid typed usage at compile time', () => {
    if (false) {
      // @ts-expect-error id and source are required by the message template.
      new UserNotFoundError()

      // @ts-expect-error source is required by the message template.
      new UserNotFoundError({ id: '123' })

      // @ts-expect-error id and source are required by the message template.
      void UserNotFoundError.err()

      // @ts-expect-error source is required by the message template.
      void UserNotFoundError.err({ id: '123' })

      // @ts-expect-error id and source are required by the message template.
      void UserNotFoundError.taskErr()

      const union = new UserNotFoundError({ id: '123', source: 'users' }) as
        | UserNotFoundError
        | DatabaseError

      // @ts-expect-error DatabaseError must be handled exhaustively.
      matchError(union, { UserNotFoundError: (err) => err.id })

      matchError(union, {
        DatabaseError: (err) => err.operation,
        // @ts-expect-error UnknownError is not part of this error union.
        UnknownError: () => 'unknown',
        UserNotFoundError: (err) => err.id,
      })

      // @ts-expect-error Reserved template variables are rejected.
      createTaggedError({ message: 'Bad $name', name: 'BadNameError' })

      const unionWithPlainError = union as UserNotFoundError | DatabaseError | Error

      // @ts-expect-error Plain Error must be handled when it is part of the union.
      matchError(unionWithPlainError, {
        DatabaseError: (err) => err.operation,
        UserNotFoundError: (err) => err.id,
      })

      matchError(unionWithPlainError, {
        DatabaseError: (err) => String(err.operation),
        Error: (err) => err.message,
        UserNotFoundError: (err) => String(err.id),
      })
    }
  })
})

it('keeps enum factories awaitable as plain values and copies reserved object keys as data', async () => {
  const variants = taggedEnum<{ Item: { label: string } }>()
  equal(Reflect.get(variants, 'then'), undefined)
  equal(await Promise.resolve(variants), variants)
  const props = Object.defineProperty({ label: 'x' }, '__proto__', {
    value: 'metadata',
    enumerable: true,
  })
  const item = variants.Item(props)
  equal(Object.getPrototypeOf(item), Object.prototype)
  equal(Object.getOwnPropertyDescriptor(item, '__proto__')?.value, 'metadata')
  const record = new StaticMessageError()
  Object.defineProperty(record, 'valueOf', { value: 'extra', enumerable: true })
  deepEqual(Object.getOwnPropertyDescriptor(record.toJSON(), 'valueOf'), {
    value: 'extra',
    enumerable: true,
    writable: true,
    configurable: true,
  })
})

it('uses an overridden toJSON when serializing a tagged cause', () => {
  class CustomCause extends createTaggedError({ name: 'CustomCause', message: 'failure' }) {
    public override toJSON = () => ({ publicMessage: `custom ${this.message}` })
  }
  const cause = new CustomCause()
  const outer = new StaticMessageError({ cause })
  deepEqual(Reflect.get(outer.toJSON(), 'cause'), { publicMessage: 'custom failure' })
})

it('reports the tag or malformed value when no tagged enum handler matches', () => {
  const variants = taggedEnum<{ Item: { label: string } }>()
  const handlers = { Item: () => 'item' }
  throws(() => variants.$match({ _tag: 'Unknown' } as never, handlers), {
    message: 'No tagged enum handler for Unknown',
  })
  throws(() => variants.$match(null as never, handlers), {
    message: 'No tagged enum handler for null',
  })
})

it('invokes synchronous try and generator options with their receiver', () => {
  function recover(this: { marker: number }) {
    return this.marker
  }
  const opts = {
    marker: 7,
    try() {
      return this.marker
    },
    catch: recover,
  }
  equal(Result.try(opts).unwrapOr(0), 7)
  const failed = {
    marker: 7,
    catch: recover,
    try() {
      throw new Error('stop')
    },
  }
  deepEqual(Result.try(failed), Result.err(7))
  const gen = {
    marker: 7,
    catch: recover,
    *try() {
      return yield* Result.ok(this.marker)
    },
  }
  deepEqual(Result.gen(gen), Result.ok(7))
  const broken = {
    marker: 7,
    catch: recover,
    *try() {
      yield* Result.ok(0)
      throw new Error('stop')
    },
  }
  deepEqual(Result.gen(broken), Result.err(7))
})

it('handles default $message template fallbacks and taggedEnum props alongside an ignored _tag', () => {
  const DefaultMessageError = createTaggedError({ name: 'DefaultMessageError' })
  const noArgs = new (DefaultMessageError as unknown as new () => Error)()
  equal(noArgs.message, '$message')
  const missingMessage = new (DefaultMessageError as unknown as new (v: object) => Error)({})
  equal(missingMessage.message, '$message')
  const withMessage = new DefaultMessageError({ message: 'explicit' })
  equal(withMessage.message, 'explicit')

  const extraSym = Symbol('extra')
  const Variants = taggedEnum<{ Item: { readonly label: string; readonly [extraSym]?: number } }>()
  const built = (
    Variants.Item as unknown as (
      props: Record<PropertyKey, unknown>,
    ) => Record<PropertyKey, unknown>
  )({ _tag: 'Ignored', label: 'kept', [extraSym]: 99 })
  equal(built['_tag'], 'Item')
  equal(built['label'], 'kept')
  equal(built[extraSym], 99)
})
