import assert, { equal } from 'node:assert'
import { describe, it } from 'vite-plus/test'

import { ResultAsync, createTaggedError, errAsync, ok, okAsync } from '../src/index.js'

class ValidationError extends createTaggedError({
  message: 'Invalid field $field',
  name: 'ValidationError',
}) {}

const thrownError = new Error('callback failed')
const rejectedError = new Error('callback rejected')

describe('ResultAsync callback failures', () => {
  it('rejects when map callback throws or rejects', async () => {
    await assert.rejects(
      async () =>
        await okAsync<number, Error>(1).map(() => {
          throw thrownError
        }),
      thrownError,
    )

    await assert.rejects(
      async () =>
        await okAsync<number, Error>(1).map(async () => await Promise.reject(rejectedError)),
      rejectedError,
    )

    const skipped = await errAsync<number, Error>(new Error('original')).map(() => {
      throw thrownError
    })

    equal(skipped._unsafeUnwrapErr().message, 'original')
  })

  it('rejects when andThen callback throws or returns a rejected ResultAsync', async () => {
    await assert.rejects(
      async () =>
        await okAsync<number, Error>(1).andThen(() => {
          throw thrownError
        }),
      thrownError,
    )

    await assert.rejects(
      async () =>
        await okAsync<number, Error>(1).andThen(
          () => new ResultAsync<number, Error>(Promise.reject(rejectedError)),
        ),
      rejectedError,
    )

    const skipped = await errAsync<number, Error>(new Error('original')).andThen(() => {
      throw thrownError
    })

    equal(skipped._unsafeUnwrapErr().message, 'original')
  })

  it('rejects when orElse callback throws or returns a rejected ResultAsync', async () => {
    await assert.rejects(
      async () =>
        await errAsync<number, Error>(new Error('original')).orElse(() => {
          throw thrownError
        }),
      thrownError,
    )

    await assert.rejects(
      async () =>
        await errAsync<number, Error>(new Error('original')).orElse(
          () => new ResultAsync<number, Error>(Promise.reject(rejectedError)),
        ),
      rejectedError,
    )

    const skipped = await okAsync<number, Error>(1).orElse(() => {
      throw thrownError
    })

    equal(skipped._unsafeUnwrap(), 1)
  })

  it('rejects when match callbacks throw or reject', async () => {
    await assert.rejects(
      async () =>
        await okAsync<number, Error>(1).match(
          () => {
            throw thrownError
          },
          (error) => error.message,
        ),
      thrownError,
    )

    await assert.rejects(
      async () =>
        await errAsync<number, Error>(new Error('original')).match(
          String,
          async () => await Promise.reject(rejectedError),
        ),
      rejectedError,
    )
  })

  it('rejects when catchTag callback throws or returns a rejected ResultAsync', async () => {
    await assert.rejects(
      async () =>
        await errAsync<number, ValidationError>(new ValidationError({ field: 'email' })).catchTag(
          'ValidationError',
          () => {
            throw thrownError
          },
        ),
      thrownError,
    )

    await assert.rejects(
      async () =>
        await errAsync<number, ValidationError>(new ValidationError({ field: 'email' })).catchTag(
          'ValidationError',
          () => new ResultAsync<number, Error>(Promise.reject(rejectedError)),
        ),
      rejectedError,
    )

    const skipped = await errAsync<number, ValidationError | Error>(new Error('plain')).catchTag(
      'ValidationError',
      () => ok(1),
    )

    equal(skipped._unsafeUnwrapErr().message, 'plain')
  })

  it('still flattens successful Result and ResultAsync callbacks', async () => {
    const mapped = await okAsync<number, Error>(1).map((number) => number + 1)
    const chainedResult = await okAsync<number, Error>(1).andThen((number) => ok(number + 1))
    const chainedAsync = await okAsync<number, Error>(1).andThen((number) => okAsync(number + 1))
    const recoveredResult = await errAsync<number, Error>(new Error('original')).orElse(() => ok(2))
    const recoveredAsync = await errAsync<number, Error>(new Error('original')).orElse(() =>
      okAsync(3),
    )

    equal(mapped._unsafeUnwrap(), 2)
    equal(chainedResult._unsafeUnwrap(), 2)
    equal(chainedAsync._unsafeUnwrap(), 2)
    equal(recoveredResult._unsafeUnwrap(), 2)
    equal(recoveredAsync._unsafeUnwrap(), 3)
  })
})
