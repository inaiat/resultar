import { equal } from 'node:assert'
import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import type { Result } from '../src/index.js'

import { createTaggedError, err, errAsync, ok, okAsync } from '../src/index.js'

class ValidationError extends createTaggedError({
  message: 'Invalid field $field',
  name: 'ValidationError',
}) {}

class PermissionError extends createTaggedError({
  message: 'Missing permission $permission',
  name: 'PermissionError',
}) {}

describe('Result.matchTagsPartial', () => {
  it('maps Ok values with the Ok handler and skips error handlers', () => {
    const validationHandler = vi.fn((error: ValidationError) => `validation:${error.field}`)
    const fallback = vi.fn((error: ValidationError) => `fallback:${error.message}`)

    const value = ok<number, ValidationError>(123).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: validationHandler },
      fallback,
    )

    equal(value, 'ok:123')
    equal(validationHandler.mock.calls.length, 0)
    equal(fallback.mock.calls.length, 0)
  })

  it('maps handled tagged errors with the matching handler', () => {
    const fallback = vi.fn(
      (error: ValidationError | PermissionError) => `fallback:${error.message}`,
    )

    const value = err<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    ).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: (error) => `validation:${error.field}` },
      fallback,
    )

    equal(value, 'validation:email')
    equal(fallback.mock.calls.length, 0)
  })

  it('maps unhandled tagged errors with fallback', () => {
    const value = err<number, ValidationError | PermissionError>(
      new PermissionError({ permission: 'admin:write' }),
    ).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: (error) => `validation:${error.field}` },
      (error) => `fallback:${error.message}`,
    )

    equal(value, 'fallback:Missing permission admin:write')
  })

  it('uses the Error handler for untagged errors before fallback', () => {
    const fallback = vi.fn((error: ValidationError | Error) => `fallback:${error.message}`)

    const value = err<number, ValidationError | Error>(new Error('plain failure')).matchTagsPartial(
      (number) => `ok:${number}`,
      { Error: (error) => `error:${error.message}` },
      fallback,
    )

    equal(value, 'error:plain failure')
    equal(fallback.mock.calls.length, 0)
  })

  it('infers handler, fallback, and return types', () => {
    const result = err<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    )

    const value = result.matchTagsPartial(
      (number) => {
        expectTypeOf(number).toEqualTypeOf<number>()
        return String(number)
      },
      {
        ValidationError: (error) => {
          expectTypeOf(error).toEqualTypeOf<ValidationError>()
          return error.field
        },
      },
      (error) => {
        expectTypeOf(error).toEqualTypeOf<ValidationError | PermissionError>()
        return false
      },
    )

    expectTypeOf(value).toEqualTypeOf<string | number | boolean>()
  })

  it('rejects handlers for tags outside the error union', () => {
    const result: Result<number, ValidationError> = err(new ValidationError({ field: 'email' }))

    if (false) {
      result.matchTagsPartial(
        String,
        {
          // @ts-expect-error PermissionError is not part of this error union.
          PermissionError: () => 'permission',
        },
        (error) => error.message,
      )
    }

    equal(result.isErr(), true)
  })
})

describe('ResultAsync.matchTagsPartial', () => {
  it('maps Ok values with the Ok handler and skips error handlers', async () => {
    const validationHandler = vi.fn((error: ValidationError) => `validation:${error.field}`)
    const fallback = vi.fn((error: ValidationError) => `fallback:${error.message}`)

    const value = await okAsync<number, ValidationError>(123).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: validationHandler },
      fallback,
    )

    equal(value, 'ok:123')
    equal(validationHandler.mock.calls.length, 0)
    equal(fallback.mock.calls.length, 0)
  })

  it('maps handled tagged errors with the matching handler', async () => {
    const fallback = vi.fn(
      (error: ValidationError | PermissionError) => `fallback:${error.message}`,
    )

    const value = await errAsync<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    ).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: (error) => `validation:${error.field}` },
      fallback,
    )

    equal(value, 'validation:email')
    equal(fallback.mock.calls.length, 0)
  })

  it('maps unhandled tagged errors with fallback', async () => {
    const value = await errAsync<number, ValidationError | PermissionError>(
      new PermissionError({ permission: 'admin:write' }),
    ).matchTagsPartial(
      (number) => `ok:${number}`,
      { ValidationError: (error) => `validation:${error.field}` },
      (error) => `fallback:${error.message}`,
    )

    equal(value, 'fallback:Missing permission admin:write')
  })

  it('uses the Error handler for untagged errors before fallback', async () => {
    const fallback = vi.fn((error: ValidationError | Error) => `fallback:${error.message}`)

    const value = await errAsync<number, ValidationError | Error>(
      new Error('plain failure'),
    ).matchTagsPartial(
      (number) => `ok:${number}`,
      { Error: (error) => `error:${error.message}` },
      fallback,
    )

    equal(value, 'error:plain failure')
    equal(fallback.mock.calls.length, 0)
  })

  it('infers async handler, fallback, and return types', async () => {
    const result = errAsync<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    )

    const value = await result.matchTagsPartial(
      (number) => {
        expectTypeOf(number).toEqualTypeOf<number>()
        return String(number)
      },
      {
        ValidationError: (error) => {
          expectTypeOf(error).toEqualTypeOf<ValidationError>()
          return error.field
        },
      },
      (error) => {
        expectTypeOf(error).toEqualTypeOf<ValidationError | PermissionError>()
        return false
      },
    )

    expectTypeOf(value).toEqualTypeOf<string | number | boolean>()
  })

  it('rejects handlers for tags outside the async error union', async () => {
    const result = errAsync<number, ValidationError>(new ValidationError({ field: 'email' }))

    if (false) {
      await result.matchTagsPartial(
        String,
        {
          // @ts-expect-error PermissionError is not part of this error union.
          PermissionError: () => 'permission',
        },
        (error) => error.message,
      )
    }

    const resolved = await result
    equal(resolved.isErr(), true)
  })
})
