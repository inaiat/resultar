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
        expectTypeOf(error).toEqualTypeOf<PermissionError>()
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
        expectTypeOf(error).toEqualTypeOf<PermissionError>()
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

describe('remaining tagged errors', () => {
  it('retains optional handlers in the fallback channel and excludes required handlers', () => {
    const handlers: {
      readonly ValidationError?: (error: ValidationError) => string
      readonly PermissionError: (error: PermissionError) => string
    } = { PermissionError: (error) => String(error.permission) }
    const value = err<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    ).matchTagsPartial(String, handlers, (error) => {
      expectTypeOf(error).toEqualTypeOf<ValidationError>()
      return String(error.field)
    })

    expectTypeOf(value).toEqualTypeOf<string>()
    equal(value, 'email')
  })

  it('retains explicit undefined and function-or-undefined handlers', async () => {
    const handlers: {
      readonly ValidationError: ((error: ValidationError) => string) | undefined
      readonly PermissionError: undefined
    } = { ValidationError: undefined, PermissionError: undefined }
    const value = await errAsync<number, ValidationError | PermissionError>(
      new PermissionError({ permission: 'read' }),
    ).matchTagsPartial(String, handlers, (error) => {
      expectTypeOf(error).toEqualTypeOf<ValidationError | PermissionError>()
      return error.message
    })

    expectTypeOf(value).toEqualTypeOf<string>()
    equal(value, 'Missing permission read')
  })

  it('uses required Error as a catchall for all remaining values, including primitives', () => {
    const value = err<number, ValidationError | string>('primitive failure').matchTagsPartial(
      String,
      {
        Error: (error) => {
          expectTypeOf(error).toEqualTypeOf<ValidationError | string>()
          return String(error)
        },
      },
      (remaining) => {
        expectTypeOf(remaining).toEqualTypeOf<never>()
        return 'unreachable'
      },
    )

    equal(value, 'primitive failure')
  })

  it('retains errors when an Error catchall is optional', () => {
    const handlers: { readonly Error?: (error: ValidationError | string) => string } = {}
    const value = err<number, ValidationError | string>('primitive failure').matchTagsPartial(
      String,
      handlers,
      (remaining) => {
        expectTypeOf(remaining).toEqualTypeOf<ValidationError | string>()
        return String(remaining)
      },
    )

    equal(value, 'primitive failure')
  })
})

describe('asynchronous match return contracts', () => {
  it('awaits success and error branches in positional and object match', async () => {
    const positional = okAsync<number, ValidationError>(1).match(
      async (number) => ({ status: 200 as const, id: number }),
      () => ({ status: 400 as const }),
    )
    const object = errAsync<number, ValidationError>(new ValidationError({ field: 'email' })).match(
      {
        ok: () => ({ status: 200 as const }),
        error: async (error) => ({ status: 400 as const, field: error.field }),
      },
    )

    expectTypeOf(positional).toEqualTypeOf<Promise<{ status: 200; id: number } | { status: 400 }>>()
    expectTypeOf(object).toEqualTypeOf<
      Promise<{ status: 200 } | { status: 400; field: string | number }>
    >()
    equal((await positional).status, 200)
    equal((await object).status, 400)
  })

  it('awaits exhaustive tagged-error handlers', async () => {
    const pending = errAsync<number, ValidationError>(
      new ValidationError({ field: 'email' }),
    ).matchTags(async (id) => ({ status: 200 as const, id }), {
      ValidationError: async (error) => ({ status: 400 as const, field: error.field }),
    })

    expectTypeOf(pending).toEqualTypeOf<
      Promise<{ status: 200; id: number } | { status: 400; field: string | number }>
    >()
    equal((await pending).status, 400)
  })

  it('awaits partial handlers and the narrowed fallback', async () => {
    const pending = errAsync<number, ValidationError | PermissionError>(
      new PermissionError({ permission: 'read' }),
    ).matchTagsPartial(
      async (id) => ({ status: 200 as const, id }),
      { ValidationError: async () => ({ status: 400 as const }) },
      async (error) => {
        expectTypeOf(error).toEqualTypeOf<PermissionError>()
        return { status: 403 as const, permission: error.permission }
      },
    )

    expectTypeOf(pending).toEqualTypeOf<
      Promise<
        { status: 200; id: number } | { status: 400 } | { status: 403; permission: string | number }
      >
    >()
    equal((await pending).status, 403)
  })
})

describe('tagged handler precedence over Error catchall', () => {
  it('uses the specific tag first while the catchall covers the remaining union', async () => {
    const handlers = {
      ValidationError: (_error: ValidationError) => 'specific',
      Error: (_error: ValidationError | PermissionError) => 'catchall',
    }
    const fallback = (remaining: never): string => {
      expectTypeOf(remaining).toEqualTypeOf<never>()
      return 'unreachable'
    }
    const tagged = err<number, ValidationError | PermissionError>(
      new ValidationError({ field: 'email' }),
    ).matchTagsPartial(String, handlers, fallback)
    const remaining = await errAsync<number, ValidationError | PermissionError>(
      new PermissionError({ permission: 'read' }),
    ).matchTagsPartial(String, handlers, fallback)

    equal(tagged, 'specific')
    equal(remaining, 'catchall')
  })
})

class ReservedError extends createTaggedError({
  name: 'Error',
  message: 'Reserved error $reason',
}) {}

describe('exhaustive Error fallback contracts', () => {
  it('requires Error for primitive errors and narrows it to their concrete union', async () => {
    const input = err<number, ValidationError | string>('primitive failure')
    const value = input.matchTags(String, {
      ValidationError: (error) => {
        expectTypeOf(error).toEqualTypeOf<ValidationError>()
        return String(error.field)
      },
      Error: (error) => {
        expectTypeOf(error).toEqualTypeOf<string>()
        return error.toUpperCase()
      },
    })
    const asyncValue = await errAsync<number, ValidationError | string>(
      'primitive failure',
    ).matchTags(String, {
      ValidationError: (error) => String(error.field),
      Error: async (error) => {
        expectTypeOf(error).toEqualTypeOf<string>()
        return error.toUpperCase()
      },
    })

    equal(value, 'PRIMITIVE FAILURE')
    equal(asyncValue, 'PRIMITIVE FAILURE')
    if (false) {
      // @ts-expect-error A tag table alone cannot cover primitive errors.
      input.matchTags(String, { ValidationError: (error) => error.field })
      // @ts-expect-error Primitive-only error unions still need a catchall.
      err<number, string>('failure').matchTags(String, {})
      // @ts-expect-error Async primitive errors require the same catchall.
      void errAsync<number, string>('failure').matchTags(String, {})
    }
  })

  it('includes plain objects and nullish values in the required fallback', () => {
    type OtherFailure = { readonly reason: string } | null | undefined
    const input = err<number, ValidationError | OtherFailure>({ reason: 'other' })
    const value = input.matchTags(String, {
      ValidationError: (error) => String(error.field),
      Error: (error) => {
        expectTypeOf(error).toEqualTypeOf<OtherFailure>()
        return error?.reason ?? 'missing'
      },
    })

    equal(value, 'other')
  })

  it('reserves Error for both its literal tag and the remaining non-tagged values', async () => {
    const reserved = new ReservedError({ reason: 'tagged' })
    type Failures = ReservedError | PermissionError | string
    const handlers = {
      PermissionError: (error: PermissionError) => String(error.permission),
      Error: (error: ReservedError | string) =>
        typeof error === 'string' ? error : String(error.reason),
    }
    const tagged = err<number, Failures>(reserved).matchTags(String, handlers)
    const fallback = await errAsync<number, Failures>('primitive').matchTags(String, handlers)
    const contextual = err<number, Failures>(reserved).matchTags(String, {
      PermissionError: (error) => String(error.permission),
      Error: (error) => {
        expectTypeOf(error).toEqualTypeOf<ReservedError | string>()
        return typeof error === 'string' ? error : String(error.reason)
      },
    })

    equal(tagged, 'tagged')
    equal(fallback, 'primitive')
    equal(contextual, 'tagged')
  })
})

describe('open error tags at exhaustive boundaries', () => {
  it('requires a catchall when the error tag is widened to string', () => {
    type OpenError = Error & { readonly _tag: string }
    const open: OpenError = Object.assign(new Error('open failure'), { _tag: 'Unknown' })
    const value = err<number, OpenError>(open).matchTags(String, {
      Error: (error) => {
        expectTypeOf(error).toEqualTypeOf<OpenError>()
        return error.message
      },
    })

    equal(value, 'open failure')
    if (false) {
      // @ts-expect-error A finite table cannot exhaust an open string discriminator.
      err<number, OpenError>(open).matchTags(String, {})
    }
  })
})
