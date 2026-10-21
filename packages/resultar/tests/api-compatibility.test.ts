import { equal, strictEqual } from 'node:assert'
import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import { Result, err, ok, okAsync, safeTry } from '../src/index.js'

describe('additive API compatibility', () => {
  it('wraps plain values in Result.gen and preserves returned Result identity in safeTry', async () => {
    const value = { id: 'user-1' }
    const returned = ok(value)
    const syncGen = Result.gen(function* () {
      yield* ok(1)
      return value
    })
    const asyncGen = Result.gen(async function* () {
      yield* okAsync(1)
      return value
    })
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Verify legacy safeTry returned Result identity.
    const syncLegacy = safeTry(function* () {
      yield* ok(1)
      return returned
    })
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Verify legacy safeTry returned Result identity.
    const asyncLegacy = safeTry(async function* () {
      yield* okAsync(1)
      return returned
    })

    strictEqual(syncGen._unsafeUnwrap(), value)
    strictEqual((await asyncGen)._unsafeUnwrap(), value)
    strictEqual(syncLegacy, returned)
    strictEqual(await asyncLegacy, returned)
  })

  it('keeps old void taps and new inspectors equivalent, including skipped callbacks', () => {
    const original = ok<number, string>(1)
    const defect = new Error('observer')
    const observer = vi.fn((): void => {
      throw defect
    })
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Verify the original callback and return contract.
    const old = original.tap(observer)
    const recommended = original.inspect(observer)

    expectTypeOf(old).toEqualTypeOf<typeof original>()
    expectTypeOf(recommended).toEqualTypeOf<typeof original>()
    strictEqual(old, original)
    strictEqual(recommended, original)
    equal(observer.mock.calls.length, 2)
    const skipped = vi.fn((): void => {
      throw defect
    })
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy success error observers must still be skipped.
    strictEqual(original.tapError(skipped), original)
    const failed = err<number, string>('original')
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy error success observers must still be skipped.
    strictEqual(failed.tap(skipped), failed)
    equal(skipped.mock.calls.length, 0)
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy error observation must remain best-effort.
    strictEqual(failed.tapError(observer), failed)
    strictEqual(failed.inspectError(observer), failed)
  })
})
