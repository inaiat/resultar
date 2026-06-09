import assert, { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import { Result, ResultAsync, err, errAsync, ok, okAsync } from '../src/index.js'

const emptyCollectionError = {
  message: 'Received an empty collection of results',
  name: 'IllegalArgumentException',
}

describe('Result.firstSuccessOf', () => {
  it('returns the first sync success and does not call later candidates', () => {
    const first = vi.fn(() => ok<number, string>(1))
    const second = vi.fn(() => ok<number, string>(2))

    const result = Result.firstSuccessOf([first, second])

    equal(result._unsafeUnwrap(), 1)
    equal(first.mock.calls.length, 1)
    equal(second.mock.calls.length, 0)
  })

  it('returns a sync fallback success after earlier failures', () => {
    const calls: string[] = []

    const result = Result.firstSuccessOf([
      () => {
        calls.push('primary')
        return err<number, string>('primary failed')
      },
      () => {
        calls.push('fallback')
        return ok<number, string>(42)
      },
      () => {
        calls.push('unused')
        return ok<number, string>(100)
      },
    ])

    equal(result._unsafeUnwrap(), 42)
    deepEqual(calls, ['primary', 'fallback'])
  })

  it('returns the single sync error when one candidate fails', () => {
    const result = Result.firstSuccessOf([() => err<number, string>('only failure')])

    equal(result._unsafeUnwrapErr(), 'only failure')
  })

  it('returns the last sync error when every candidate fails', () => {
    const result = Result.firstSuccessOf([
      () => err<number, string>('first failure'),
      () => err<number, string>('last failure'),
    ])

    equal(result._unsafeUnwrapErr(), 'last failure')
  })

  it('throws for an empty sync candidate collection', () => {
    assert.throws(() => Result.firstSuccessOf([]), emptyCollectionError)
  })

  it('infers heterogeneous sync ok and error unions', () => {
    const result = Result.firstSuccessOf([
      () => ok<number, 'env-error'>(1),
      () => err<string, 'config-error'>('config-error'),
    ] as const)

    expectTypeOf(result).toEqualTypeOf<Result<number | string, 'env-error' | 'config-error'>>()
  })
})

describe('ResultAsync.firstSuccessOf', () => {
  it('runs async candidates sequentially and stops after the first success', async () => {
    const calls: string[] = []

    const result = await ResultAsync.firstSuccessOf([
      () => {
        calls.push('primary')
        return errAsync<number, string>('primary failed')
      },
      () => {
        calls.push('fallback')
        return okAsync<number, string>(42)
      },
      () => {
        calls.push('unused')
        return okAsync<number, string>(100)
      },
    ])

    equal(result._unsafeUnwrap(), 42)
    deepEqual(calls, ['primary', 'fallback'])
  })

  it('returns the single async error when one candidate fails', async () => {
    const result = await ResultAsync.firstSuccessOf([
      () => errAsync<number, string>('only async failure'),
    ])

    equal(result._unsafeUnwrapErr(), 'only async failure')
  })

  it('returns the last async error when every candidate fails', async () => {
    const result = await ResultAsync.firstSuccessOf([
      () => errAsync<number, string>('first failure'),
      () => errAsync<number, string>('last failure'),
    ])

    equal(result._unsafeUnwrapErr(), 'last failure')
  })

  it('rejects for an empty async candidate collection', async () => {
    await assert.rejects(async () => await ResultAsync.firstSuccessOf([]), emptyCollectionError)
  })

  it('infers heterogeneous async ok and error unions', () => {
    const result = ResultAsync.firstSuccessOf([
      () => okAsync<number, 'primary-error'>(1),
      () => errAsync<string, 'fallback-error'>('fallback-error'),
    ] as const)

    expectTypeOf(result).toEqualTypeOf<
      ResultAsync<number | string, 'primary-error' | 'fallback-error'>
    >()
  })
})
