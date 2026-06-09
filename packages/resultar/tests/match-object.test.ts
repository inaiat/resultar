import { Buffer } from 'node:buffer'
import { equal } from 'node:assert'

import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import { type Result, err, errAsync, ok, okAsync } from '../src/index.js'

describe('match object form', () => {
  it('matches sync Ok with labeled handlers', () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = ok<Buffer, Error>(Buffer.from('resultar')).match({
      ok: okHandler,
      error: errorHandler,
    })

    equal(matched, 'resultar')
    equal(okHandler.mock.calls.length, 1)
    equal(errorHandler.mock.calls.length, 0)
  })

  it('matches sync Err with labeled handlers', () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = err<Buffer, Error>(new Error('boom')).match({
      ok: okHandler,
      error: errorHandler,
    })

    equal(matched, 'boom')
    equal(okHandler.mock.calls.length, 0)
    equal(errorHandler.mock.calls.length, 1)
  })

  it('infers a union when labeled handlers return different types', () => {
    const result: Result<number, string> =
      Math.random() > 0.5 ? ok<number, string>(1) : err<number, string>('bad')

    const matched = result.match({ ok: (value) => value + 1, error: (error) => error.length > 0 })

    expectTypeOf(matched).toEqualTypeOf<number | boolean>()
  })

  it('matches async Ok with labeled handlers', async () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = await okAsync<Buffer, Error>(Buffer.from('async resultar')).match({
      ok: okHandler,
      error: errorHandler,
    })

    equal(matched, 'async resultar')
    equal(okHandler.mock.calls.length, 1)
    equal(errorHandler.mock.calls.length, 0)
  })

  it('matches async Err with labeled handlers', async () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = await errAsync<Buffer, Error>(new Error('async boom')).match({
      ok: okHandler,
      error: errorHandler,
    })

    equal(matched, 'async boom')
    equal(okHandler.mock.calls.length, 0)
    equal(errorHandler.mock.calls.length, 1)
  })

  it('keeps the sync positional form', () => {
    const matched = ok<number, string>(1).match(
      (value) => value + 1,
      (error) => error.length,
    )

    equal(matched, 2)
  })

  it('keeps the async positional form', async () => {
    const matched = await errAsync<number, string>('bad').match(
      (value) => value + 1,
      (error) => error.length,
    )

    equal(matched, 3)
  })
})
