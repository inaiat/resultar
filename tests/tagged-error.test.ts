import { deepEqual, equal, ok as isTrue, throws } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { ErrResult, TaggedEnum } from '../src/index.js'

import {
  createTaggedError,
  findCause,
  isError,
  matchError,
  matchErrorPartial,
  Result,
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

class AppError extends Error {
  statusCode = 500
}

class ForbiddenError extends createTaggedError({
  extends: AppError,
  message: 'Missing permission $permission',
  name: 'ForbiddenError',
}) {
  statusCode = 403
}

const createKnownTaggedError = (): UserNotFoundError | DatabaseError =>
  new UserNotFoundError({ id: '789', source: 'users' })

const createUnknownTaggedError = (): UserNotFoundError | DatabaseError =>
  new DatabaseError({ operation: 'write' })

describe('tagged errors', async () => {
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

  it('matches tagged error unions exhaustively', () => {
    const error = createKnownTaggedError()

    const message = matchError(error, {
      DatabaseError: (err) => `database: ${err.operation}`,
      UserNotFoundError: (err) => `user: ${err.id}`,
    })

    equal(message, 'user: 789')
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

  it('uses static guards and serializes predictable metadata', () => {
    const cause = new Error('root')
    const error = new UserNotFoundError({ cause, id: '123', source: 'users' })
    const spoofed = new Error('spoofed')

    Object.defineProperty(spoofed, '_tag', { configurable: true, value: 'UserNotFoundError' })

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
  })

  it('rejects reserved template variables and ignores reserved runtime props', () => {
    const unsafeCreateTaggedError = createTaggedError as unknown as (options: {
      readonly message: string
      readonly name: string
    }) => unknown

    throws(
      () => unsafeCreateTaggedError({ message: 'Bad $name', name: 'BadNameError' }),
      /reserved template variable \$name/,
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
    const assignableResult: Result<string, UserNotFoundError> = UserNotFoundError.err({
      id: '123',
      source: 'users',
    })

    expectTypeOf(error.id).toEqualTypeOf<string | number>()
    expectTypeOf(error.source).toEqualTypeOf<string | number>()
    expectTypeOf(defaultResult).toEqualTypeOf<ErrResult<never, UserNotFoundError>>()
    expectTypeOf(defaultResult.error).toEqualTypeOf<UserNotFoundError>()
    if (assignableResult.isErr()) {
      expectTypeOf(assignableResult.error).toEqualTypeOf<UserNotFoundError>()
    }

    const union = error as UserNotFoundError | DatabaseError
    matchError(union, {
      DatabaseError: (err) => {
        expectTypeOf(err.operation).toEqualTypeOf<string | number>()
        return err.message
      },
      UserNotFoundError: (err) => {
        expectTypeOf(err.id).toEqualTypeOf<string | number>()
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
      UserNotFoundError.err()

      // @ts-expect-error source is required by the message template.
      UserNotFoundError.err({ id: '123' })

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
