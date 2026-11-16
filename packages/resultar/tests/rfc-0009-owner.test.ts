import { expect, expectTypeOf, test } from 'vite-plus/test'
import { ResultTask, type ResultTaskScope, type ResultTaskScopeOwner } from '../src/index.js'

const checkTypes = () => {
  const opaque: ResultTask<number, never, unknown> = ResultTask.ok(1)
  expectTypeOf(ResultTask.makeScope().use(opaque)).toEqualTypeOf<
    ResultTask<number, unknown, unknown>
  >()
  // @ts-expect-error Erased cleanup requirements cannot prove a narrow close bound.
  ResultTask.makeScope<never>().use(opaque)
  const nested = ResultTask.acquireRelease({
    acquire: ResultTask.ok(1),
    release: () =>
      ResultTask.acquireRelease({
        acquire: ResultTask.ok(2),
        release: () => ResultTask.err('nested' as const),
      }).map(() => undefined),
  })
  // @ts-expect-error Nested release errors must fit the bound too.
  ResultTask.makeScope<'close'>().use(nested)
  ResultTask.makeScope<'nested'>().use(nested)
  const owner = ResultTask.makeScope<'close' | 'nested'>()
  owner.addFinalizer(() => ResultTask.err('close' as const))
  expectTypeOf(owner.close()).toEqualTypeOf<ResultTask<void, 'close' | 'nested'>>()
  const resource = ResultTask.acquireRelease({
    acquire: ResultTask.ok(42),
    release: () => ResultTask.err('close' as const),
  })
  expectTypeOf(owner.use(resource)).toEqualTypeOf<
    ResultTask<number, 'close', ResultTaskScope<'close'>>
  >()
  expectTypeOf(owner.use(resource.andThen(() => ResultTask.err('body' as const)))).toEqualTypeOf<
    ResultTask<never, 'body' | 'close', ResultTaskScope<'close'>>
  >()
  // @ts-expect-error Cleanup errors cannot widen a mutable owner's declared bound.
  owner.addFinalizer(() => ResultTask.err('other' as const))
  owner.use(
    // @ts-expect-error All adoption paths enforce cleanup bounds.
    ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () => ResultTask.err('other' as const),
    }),
  )
  // @ts-expect-error A broad owner cannot masquerade as a narrow one.
  const narrow: ResultTaskScopeOwner<'close'> = ResultTask.makeScope<unknown>()
  // @ts-expect-error A narrow mutable owner cannot be widened to accept more finalizers.
  const broad: ResultTaskScopeOwner<unknown> = owner
  void narrow
  void broad
  const service = ResultTask.service<number, 'number'>('number')
  owner.addFinalizer(() =>
    // @ts-expect-error Finalizers retain the requirement-free boundary.
    ResultTask.gen(function* () {
      yield* service
    }),
  )
  ResultTask.makeScope<never>().addFinalizer(() => ResultTask.ok(undefined))
  expectTypeOf(ResultTask.makeScope().close()).toEqualTypeOf<ResultTask<void, unknown>>()
}
expectTypeOf(checkTypes).toBeFunction()

test('typed closure shares pending cleanup and continues after failures and defects', async () => {
  const owner = ResultTask.makeScope<'close'>()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  owner.addFinalizer(() =>
    ResultTask.sync(() => {
      events.push('first')
    }),
  )
  owner.addFinalizer(() => ResultTask.err('close' as const))
  owner.addFinalizer(() =>
    ResultTask.fromPromise(async () => {
      entered.resolve()
      await release.promise
      events.push('last')
      throw new Error('defect')
    }),
  )
  const first = owner.close().runExit()
  await entered.promise
  const second = owner.close().runExit()
  expect(() => owner.addFinalizer(() => ResultTask.ok(undefined))).toThrow()
  release.resolve()
  expect(await second).toEqual(await first)
  expect(events).toEqual(['last', 'first'])
  expect(await owner.close().runExit()).toEqual(await first)
  expect((await owner.use(ResultTask.ok(1)).runExit())._tag).toBe('Failure')
})

test('failed use includes release failures and closing body outcomes are context only', async () => {
  const owner = ResultTask.makeScope<'close'>()
  const used = owner.use(
    ResultTask.acquireRelease({
      acquire: ResultTask.ok(1),
      release: () => ResultTask.err('close' as const),
    }).andThen(() => ResultTask.err('body')),
  )
  expect(await used.runExit()).toEqual({
    _tag: 'Failure',
    cause: {
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: 'body' },
      right: { _tag: 'Fail', error: 'close' },
    },
  })
  const outcome = { _tag: 'Failure', cause: { _tag: 'Fail', error: 'external' } } as const
  owner.addFinalizer((exit) =>
    ResultTask.sync(() => {
      expect(exit).toEqual(outcome)
    }),
  )
  expect(await owner.close(outcome).runExit()).toEqual({ _tag: 'Success', value: undefined })
})

test('closing waits for late acquisition and releases it once under cancellation', async () => {
  const owner = ResultTask.makeScope<never>()
  const started = Promise.withResolvers<void>()
  const acquire = Promise.withResolvers<number>()
  let releases = 0
  const used = owner
    .use(
      ResultTask.acquireRelease({
        acquire: ResultTask.fromPromise(() => {
          started.resolve()
          return acquire.promise
        }),
        release: () =>
          ResultTask.sync(() => {
            releases += 1
          }),
      }),
    )
    .runExit()
  await started.promise
  let closed = false
  const closing = owner
    .close()
    .runExit()
    .then((exit) => {
      closed = true
      return exit
    })
  expect(closed).toBe(false)
  acquire.resolve(1)
  await used
  await closing
  expect(releases).toBe(1)
})
