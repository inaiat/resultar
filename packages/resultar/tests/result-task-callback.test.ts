import { expect, expectTypeOf, test } from 'vite-plus/test'
import { ResultTask, type ResultTaskCallbackContext } from '../src/index.js'

test('callback tasks are lazy, repeatable and clean synchronous completion before continuation', async () => {
  const events: string[] = []
  const task = ResultTask.fromCallback<number>({
    subscribe: ({ resolve, reject }) => {
      events.push('subscribe')
      resolve(42)
      resolve(99)
      reject(undefined as never)
      return () => {
        events.push('cleanup')
      }
    },
  }).map((value) => {
    events.push('map')
    return value
  })
  expectTypeOf(task).toEqualTypeOf<ResultTask<number>>()
  expect(events).toEqual([])
  expect(await task.runPromise()).toBe(42)
  expect(await task.runPromise()).toBe(42)
  expect(events).toEqual(['subscribe', 'cleanup', 'map', 'subscribe', 'cleanup', 'map'])
})

test('concurrent runs have independent callbacks, signals and cleanup', async () => {
  const subscriptions: ResultTaskCallbackContext<number, string>[] = []
  const cleaned: number[] = []
  const task = ResultTask.fromCallback<number, string>({
    subscribe: (context) => {
      const index = subscriptions.length
      subscriptions.push(context)
      return () => {
        cleaned.push(index)
      }
    },
  })
  const controller = new AbortController()
  const first = task.runExit({ signal: controller.signal })
  const second = task.runExit()
  controller.abort('stop')
  subscriptions[0]?.resolve(1)
  subscriptions[1]?.reject('failed')
  expect(await first).toEqual({ _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop' } })
  expect(await second).toEqual({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'failed' } })
  subscriptions[1]?.resolve(2)
  expect(cleaned).toEqual([0, 1])
})

test('already aborted signals skip subscription; abort during subscription still cleans up', async () => {
  const controller = new AbortController()
  let subscribed = 0
  let cleaned = 0
  const task = ResultTask.fromCallback({
    subscribe: () => {
      subscribed += 1
      controller.abort('during')
      return () => {
        cleaned += 1
      }
    },
  })
  expect(await task.runExit({ signal: controller.signal })).toEqual({
    _tag: 'Failure',
    cause: { _tag: 'Interrupt', reason: 'during' },
  })
  await task.runExit({ signal: controller.signal })
  expect(subscribed).toBe(1)
  expect(cleaned).toBe(1)
})

test('subscription exceptions are defects even after a synchronous callback', async () => {
  const defect = new Error('subscribe')
  for (const complete of [false, true]) {
    const task = ResultTask.fromCallback<number>({
      subscribe: ({ resolve }) => {
        if (complete) resolve(1)
        throw defect
      },
    })
    expect(await task.runExit()).toEqual({ _tag: 'Failure', cause: { _tag: 'Die', defect } })
  }
})

test('cleanup defects preserve preceding typed failures and interruptions', async () => {
  const defect = new Error('cleanup')
  for (const mode of ['success', 'failure', 'abort'] as const) {
    const controller = new AbortController()
    let cleaned = 0
    const task = ResultTask.fromCallback<number, string>({
      subscribe: ({ resolve, reject }) => {
        if (mode === 'success') resolve(1)
        if (mode === 'failure') reject('failed')
        if (mode === 'abort') controller.abort('stop')
        return () => {
          cleaned += 1
          resolve(2)
          throw defect
        }
      },
    })
    const exit = await task.runExit({ signal: controller.signal })
    const right = { _tag: 'Die', defect }
    expect(exit).toEqual({
      _tag: 'Failure',
      cause:
        mode === 'success'
          ? right
          : {
              _tag: 'Sequential',
              left:
                mode === 'failure'
                  ? { _tag: 'Fail', error: 'failed' }
                  : { _tag: 'Interrupt', reason: 'stop' },
              right,
            },
    })
    expect(cleaned).toBe(1)
  }
})

test('asynchronous success without cleanup and cancellation after completion', async () => {
  const controller = new AbortController()
  const task = ResultTask.fromCallback<number>({
    subscribe: ({ resolve, signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      queueMicrotask(() => resolve(42))
    },
  })
  expect(await task.runPromise({ signal: controller.signal })).toBe(42)
  controller.abort()
})

test('callback completion followed by a subscription throw preserves both failures', async () => {
  const defect = new Error('after callback')
  const task = ResultTask.fromCallback<never, string>({
    subscribe: ({ reject }) => {
      reject('original')
      throw defect
    },
  })
  expect(await task.runExit()).toEqual({
    _tag: 'Failure',
    cause: {
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: 'original' },
      right: { _tag: 'Die', defect },
    },
  })
})
