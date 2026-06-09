import { equal, ok as isTrue } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Result, StrictResult, StrictResultAsync } from '../src/index.js'

import { createTaggedError, err, errAsync, ok, okAsync } from '../src/index.js'

class DomainError extends createTaggedError({
  message: 'Domain failure $code',
  name: 'DomainError',
}) {}

class InfrastructureError extends Error {}

describe('StrictResult', () => {
  it('is a type-only Result alias that keeps normal runtime behavior', () => {
    const success: StrictResult<number, DomainError> = ok(123)
    const failure: StrictResult<number, DomainError> = DomainError.err({ code: 'invalid' })

    isTrue(success.isOk())
    equal(success.value, 123)
    isTrue(failure.isErr())
    isTrue(failure.error instanceof DomainError)
    equal(failure.error.code, 'invalid')
  })

  it('accepts regular Error subclasses and the default Error channel', () => {
    const domainFailure: StrictResult<number, DomainError> = err(
      new DomainError({ code: 'domain' }),
    )
    const infrastructureFailure: StrictResult<number, InfrastructureError> = err(
      new InfrastructureError('database unavailable'),
    )
    const genericFailure: StrictResult<number> = err(new Error('generic'))

    expectTypeOf(domainFailure).toExtend<Result<number, Error>>()
    expectTypeOf(infrastructureFailure).toExtend<Result<number, Error>>()
    expectTypeOf(genericFailure).toExtend<Result<number, Error>>()
  })

  it('rejects non-Error failure channels at compile time', () => {
    if (false) {
      // @ts-expect-error StrictResult error types must extend Error.
      const stringFailure: StrictResult<number, string> = err('invalid')
      // @ts-expect-error StrictResult error types must extend Error.
      const objectFailure: StrictResult<number, { readonly code: string }> = err({
        code: 'invalid',
      })
      // @ts-expect-error Result with a string error channel is not assignable to StrictResult.
      const fromGenericResult: StrictResult<number, Error> = err<number, string>('invalid')

      equal(stringFailure, undefined)
      equal(objectFailure, undefined)
      equal(fromGenericResult, undefined)
    }
  })

  it('catches mixed chains that introduce non-Error failures', () => {
    const strictResult: StrictResult<number, DomainError> = ok(1)
    const stillStrict: StrictResult<string, DomainError | InfrastructureError> =
      strictResult.andThen(() => err(new InfrastructureError('unavailable')))

    expectTypeOf(stillStrict).toExtend<Result<string, Error>>()

    if (false) {
      // @ts-expect-error The chain introduced a string error, so it is not StrictResult-compatible.
      const mixedFailure: StrictResult<string, DomainError> = strictResult.andThen(() =>
        err('invalid'),
      )

      equal(mixedFailure, undefined)
    }
  })
})

describe('StrictResultAsync', () => {
  it('is a type-only ResultAsync alias that keeps normal runtime behavior', async () => {
    const success: StrictResultAsync<number, DomainError> = okAsync(123)
    const failure: StrictResultAsync<number, DomainError> = errAsync(
      new DomainError({ code: 'invalid' }),
    )

    const successResult = await success
    const failureResult = await failure

    isTrue(successResult.isOk())
    equal(successResult.value, 123)
    isTrue(failureResult.isErr())
    isTrue(failureResult.error instanceof DomainError)
    equal(failureResult.error.code, 'invalid')
  })

  it('accepts regular Error subclasses and the default Error channel', () => {
    const domainFailure: StrictResultAsync<number, DomainError> = errAsync(
      new DomainError({ code: 'domain' }),
    )
    const infrastructureFailure: StrictResultAsync<number, InfrastructureError> = errAsync(
      new InfrastructureError('database unavailable'),
    )
    const genericFailure: StrictResultAsync<number> = errAsync(new Error('generic'))

    expectTypeOf(domainFailure).toExtend<StrictResultAsync<number, Error>>()
    expectTypeOf(infrastructureFailure).toExtend<StrictResultAsync<number, Error>>()
    expectTypeOf(genericFailure).toExtend<StrictResultAsync<number, Error>>()
  })

  it('rejects non-Error async failure channels at compile time', () => {
    if (false) {
      // @ts-expect-error StrictResultAsync error types must extend Error.
      const stringFailure: StrictResultAsync<number, string> = errAsync('invalid')
      // @ts-expect-error StrictResultAsync error types must extend Error.
      const objectFailure: StrictResultAsync<number, { readonly code: string }> = errAsync({
        code: 'invalid',
      })
      // @ts-expect-error ResultAsync with a string error channel is not assignable to StrictResultAsync.
      const fromGenericResult: StrictResultAsync<number, Error> = errAsync<number, string>(
        'invalid',
      )

      equal(stringFailure, undefined)
      equal(objectFailure, undefined)
      equal(fromGenericResult, undefined)
    }
  })
})
