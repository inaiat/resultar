import { describe, expect, expectTypeOf, test } from 'vite-plus/test'
import { ResultTask, type ServiceTag } from '../src/index.js'

describe('service resolver guarantees', () => {
  const Name = ResultTask.service<string, 'name'>('name')
  const External = ResultTask.service<string, 'external'>('external')
  const task = ResultTask.gen(function* readName() {
    return yield* Name
  })

  test('preserves provider errors and external requirements', async () => {
    const resolved = ResultTask.provideServiceResolver(task, {
      name: () =>
        ResultTask.gen(function* provideName() {
          yield* External
          return yield* ResultTask.fail('offline' as const)
        }),
    })
    expectTypeOf(resolved).toEqualTypeOf<
      ResultTask<string, 'offline', ServiceTag<'external', string>>
    >()
    expect(await ResultTask.runExit(resolved, { services: { external: 'ok' } })).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'offline' },
    })
    // @ts-expect-error The provider must return the required contract.
    ResultTask.provideServiceResolver(task, { name: () => ResultTask.succeed(123) })
    // @ts-expect-error Every required service needs a provider.
    ResultTask.provideServiceResolver(task, {})
  })

  test('closes generator finally blocks when a provider throws', async () => {
    let cleaned = false
    const defect = new Error('provider')
    const program = ResultTask.gen(function* read() {
      try {
        return yield* Name
      } finally {
        yield* ResultTask.sync(() => {
          cleaned = true
        })
      }
    })
    const exit = await ResultTask.runExit(
      ResultTask.provideServiceResolver(program, {
        name: () => {
          throw defect
        },
      }),
    )
    expect(cleaned).toBe(true)
    expect(exit).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect } })
  })
})
