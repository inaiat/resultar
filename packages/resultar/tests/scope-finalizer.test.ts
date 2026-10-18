import { describe, expect, it } from 'vite-plus/test'
import { ResultTask } from '../src/index.js'

describe('scope finalizer registration', () => {
  it('rejects finalizer registration as soon as closing starts', async () => {
    const scope = ResultTask.makeScope()
    const closing = ResultTask.runExit(scope.close())
    expect(() => scope.addFinalizer(() => ResultTask.succeed(undefined))).toThrow('closing')
    expect(await closing).toEqual({ _tag: 'Success', value: undefined })
  })

  it('mixes synchronous and task acquisitions in reverse registration order exactly once', async () => {
    const scope = ResultTask.makeScope()
    const events: string[] = []
    scope.addFinalizer(() =>
      ResultTask.sync(() => {
        events.push('first')
      }),
    )
    await ResultTask.runPromise(
      scope.use(
        ResultTask.acquireRelease({
          acquire: ResultTask.succeed('second'),
          release: (value) =>
            ResultTask.sync(() => {
              events.push(value)
            }),
        }),
      ),
    )
    scope.addFinalizer(() =>
      ResultTask.sync(() => {
        events.push('third')
      }),
    )
    expect(events).toEqual([])
    await ResultTask.runPromise(scope.close())
    await ResultTask.runPromise(scope.close())
    expect(events).toEqual(['third', 'second', 'first'])
    expect(() => scope.addFinalizer(() => ResultTask.succeed(undefined))).toThrow('closing')
  })

  it('retains typed cleanup failures and thrown defects while draining all finalizers', async () => {
    const scope = ResultTask.makeScope()
    const failure = new Error('typed failure')
    const defect = new Error('defect')
    let released = false
    scope.addFinalizer(() =>
      ResultTask.sync(() => {
        released = true
      }),
    )
    scope.addFinalizer(() => ResultTask.fail(failure))
    scope.addFinalizer(() => {
      throw defect
    })
    const exit = await ResultTask.runExit(scope.close())
    expect(exit).toEqual({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect },
        right: { _tag: 'Fail', error: failure },
      },
    })
    expect(released).toBe(true)
  })
})
