import { Buffer } from 'node:buffer'
import { equal } from 'node:assert'

import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import { errAsync, okAsync, ResultAsync } from '../src/entries/async.js'
import { type Result, err, ok } from '../src/index.js'

describe('match object form', () => {
  it('matches sync Ok with labeled handlers', () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = ok<Buffer, Error>(Buffer.from('resultar')).match({
      ok: okHandler,
      err: errorHandler,
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
      err: errorHandler,
    })

    equal(matched, 'boom')
    equal(okHandler.mock.calls.length, 0)
    equal(errorHandler.mock.calls.length, 1)
  })

  it('infers a union when labeled handlers return different types', () => {
    const result: Result<number, string> =
      Math.random() > 0.5 ? ok<number, string>(1) : err<number, string>('bad')

    const matched = result.match({ ok: (value) => value + 1, err: (error) => error.length > 0 })

    expectTypeOf(matched).toEqualTypeOf<number | boolean>()
  })

  it('matches async Ok with labeled handlers', async () => {
    const okHandler = vi.fn((buffer: Buffer) => buffer.toString())
    const errorHandler = vi.fn((error: Error) => error.message)

    const matched = await okAsync<Buffer, Error>(Buffer.from('async resultar')).match({
      ok: okHandler,
      err: errorHandler,
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
      err: errorHandler,
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

  it('reads ResultAsync.match object handlers lazily after settlement (v4 parity)', async () => {
    const { promise, resolve } = Promise.withResolvers<Result<number, string>>()
    const pendingErr = new ResultAsync<number, string>(promise)

    const handlers = { ok: (value: number) => `ok:${value}`, error: (e: string) => `original:${e}` }

    const matchedPromise = pendingErr.match(handlers)
    handlers.error = (e: string) => `updated:${e}`
    resolve(err('boom'))

    equal(await matchedPromise, 'updated:boom')
  })

  it('does not read the unused ResultAsync.match handler branch (throwing getter)', async () => {
    const onErrValue = await errAsync<number, string>('boom').match({
      get ok(): (value: number) => string {
        throw new Error('ok getter should not be accessed on Err')
      },
      err: (e) => `handled:${e}`,
    })
    equal(onErrValue, 'handled:boom')

    const onOkValue = await okAsync<number, string>(42).match({
      ok: (v) => `handled:${v}`,
      get err(): (e: string) => string {
        throw new Error('err getter should not be accessed on Ok')
      },
    })
    equal(onOkValue, 'handled:42')
  })

  it('prefers err over legacy error when both exist on ResultAsync.match handlers', async () => {
    const matched = await errAsync<number, string>('x').match({
      ok: () => 'OK',
      err: () => 'A',
      error: () => 'B',
    })
    equal(matched, 'A')
  })
})
