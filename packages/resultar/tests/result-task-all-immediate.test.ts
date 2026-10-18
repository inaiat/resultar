import { deepEqual, equal } from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, it } from 'vite-plus/test'
import { err, ok } from '../src/result/result.js'
import { ResultTask } from '../src/task/result-task.js'

describe('ResultTask.all with immediate successes', () => {
  it('stays lazy and observes array changes on each execution', async () => {
    let executions = 0
    const tasks = [
      ResultTask.sync(() => {
        executions += 1
        return executions
      }),
      ResultTask.ok(2),
    ]
    const collected = ResultTask.all(tasks, { concurrency: 'unbounded' })

    equal(executions, 0)
    deepEqual(await ResultTask.runResult(collected), ok([1, 2]))
    tasks[1] = ResultTask.ok(3)
    deepEqual(await ResultTask.runResult(collected), ok([2, 3]))
    equal(executions, 2)
  })

  it('reads successful array entries once per execution', async () => {
    const reads = [0, 0, 0]
    const tasks: ResultTask<number>[] = []
    for (let index = 0; index < reads.length; index += 1)
      Object.defineProperty(tasks, index, {
        configurable: true,
        get: () => {
          reads[index] = (reads[index] ?? 0) + 1
          return ResultTask.ok(index)
        },
      })
    const collected = ResultTask.all(tasks, { concurrency: 'unbounded' })

    deepEqual(reads, [0, 0, 0])
    deepEqual(await ResultTask.runResult(collected), ok([0, 1, 2]))
    deepEqual(reads, [1, 1, 1])
    deepEqual(await ResultTask.runResult(collected), ok([0, 1, 2]))
    deepEqual(reads, [2, 2, 2])
  })

  it('does not reread earlier array entries or read past a sequential failure', async () => {
    const reads = [0, 0, 0]
    const tasks: ResultTask<number, string>[] = []
    for (let index = 0; index < reads.length; index += 1)
      Object.defineProperty(tasks, index, {
        get: () => {
          reads[index] = (reads[index] ?? 0) + 1
          return index === 1 ? ResultTask.err('failed') : ResultTask.ok(index)
        },
      })

    deepEqual(await ResultTask.runResult(ResultTask.all(tasks)), err('failed'))
    deepEqual(reads, [1, 1, 0])
  })

  it.each([2, 'unbounded'] as const)(
    'preserves observable start and cleanup order with concurrency %s',
    async (concurrency) => {
      const events: string[] = []
      const started = (name: string) =>
        ResultTask.sync(() => {
          events.push(name)
          return name
        })
      const resource = ResultTask.acquireRelease({
        acquire: started('acquire'),
        release: () =>
          ResultTask.sync(() => {
            events.push('release')
          }),
      })
      const tasks = [
        started('first'),
        ResultTask.ok('immediate'),
        started('second'),
        resource,
        started('third'),
      ]

      deepEqual(
        await ResultTask.runResult(ResultTask.all(tasks, { concurrency })),
        ok(['first', 'immediate', 'second', 'acquire', 'third']),
      )
      deepEqual(events, ['first', 'second', 'acquire', 'third', 'release'])
    },
  )

  it('awaits asynchronous item cleanup before the next sequential item', async () => {
    const events: string[] = []
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        events.push('acquire')
        return 1
      }),
      release: () =>
        ResultTask.tryPromise(async () => {
          events.push('release:start')
          await Promise.resolve()
          events.push('release:end')
        }),
    })
    const next = ResultTask.sync(() => {
      events.push('next')
      return 2
    })

    deepEqual(
      await ResultTask.runResult(ResultTask.all([ResultTask.ok(0), resource, next])),
      ok([0, 1, 2]),
    )
    deepEqual(events, ['acquire', 'release:start', 'release:end', 'next'])
  })

  it('respects an overridden executor on an originally successful task', async () => {
    let executions = 0
    const task = ResultTask.ok(1)
    ;(task as unknown as { execute: () => unknown }).execute = () => {
      executions += 1
      return { _tag: 'Success', value: 42 }
    }

    deepEqual(
      await ResultTask.runResult(
        ResultTask.all([ResultTask.ok(0), task], { concurrency: 'unbounded' }),
      ),
      ok([0, 42]),
    )
    equal(executions, 1)
  })

  it('honors a scheduler budget even when every item succeeds immediately', async () => {
    const tasks = Array.from({ length: 8 }, (_unused, index) => ResultTask.ok(index))
    let yields = 0

    deepEqual(
      await ResultTask.runPromise(ResultTask.all(tasks, { concurrency: 'unbounded' }), {
        yieldEvery: 1,
        scheduler: {
          yield: async () => {
            yields += 1
          },
        },
      }),
      [0, 1, 2, 3, 4, 5, 6, 7],
    )
    equal(yields >= tasks.length, true)
  })

  it('stops reading new items when a scheduler yield interrupts the collection', async () => {
    const controller = new AbortController()
    const reads: number[] = []
    const tasks: ResultTask<number>[] = []
    for (let index = 0; index < 3; index += 1)
      Object.defineProperty(tasks, index, {
        get: () => {
          reads.push(index)
          return ResultTask.ok(index)
        },
      })
    let yields = 0

    deepEqual(
      await ResultTask.runExit(ResultTask.all(tasks, { concurrency: 'unbounded' }), {
        signal: controller.signal,
        yieldEvery: 1,
        scheduler: {
          yield: async () => {
            yields += 1
            if (yields === 2) controller.abort('stop-collection')
          },
        },
      }),
      { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'stop-collection' } },
    )
    deepEqual(reads, [0])
  })

  it('propagates a scheduler defect instead of returning immediate successes', async () => {
    let yields = 0
    const defect = new Error('collection-scheduler-defect')
    deepEqual(
      await ResultTask.runExit(ResultTask.all([ResultTask.ok(1), ResultTask.ok(2)]), {
        yieldEvery: 1,
        scheduler: {
          yield: async () => {
            yields += 1
            if (yields === 2) throw defect
          },
        },
      }),
      { _tag: 'Failure', cause: { _tag: 'Die', defect } },
    )
  })

  it.each([false, true])('removes parent abort listeners after failure=%s', async (fails) => {
    const controller = new AbortController()
    const initialListeners = getEventListeners(controller.signal, 'abort')
    const tasks = [ResultTask.ok(1), fails ? ResultTask.err('failed') : ResultTask.ok(2)]

    for (let execution = 0; execution < 3; execution += 1) {
      deepEqual(
        await ResultTask.runResult(ResultTask.all(tasks, { concurrency: 'unbounded' }), {
          signal: controller.signal,
        }),
        fails ? err('failed') : ok([1, 2]),
      )
      deepEqual(getEventListeners(controller.signal, 'abort'), initialListeners)
    }
  })

  it('does not start a later synchronous task after a concurrent failure', async () => {
    let started = false
    const later = ResultTask.sync(() => {
      started = true
      return 2
    })

    deepEqual(
      await ResultTask.runResult(
        ResultTask.all([ResultTask.err('failed'), ResultTask.ok(1), later], { concurrency: 2 }),
      ),
      err('failed'),
    )
    equal(started, false)
  })

  it('observes array mutations queued by an earlier getter before scheduling later items', async () => {
    const tasks: ResultTask<number, string>[] = [
      ResultTask.ok(0),
      ResultTask.ok(1),
      ResultTask.ok(2),
    ]
    let reads = 0
    Object.defineProperty(tasks, 0, {
      get: () => {
        reads += 1
        queueMicrotask(() => {
          tasks[2] = ResultTask.err('mutated')
        })
        return ResultTask.ok(0)
      },
    })

    deepEqual(await ResultTask.runResult(ResultTask.all(tasks, { concurrency: 2 })), err('mutated'))
    equal(reads, 1)
  })

  it('observes cancellation queued by a successful mapper before scheduling later items', async () => {
    const controller = new AbortController()
    const visits: number[] = []
    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask collection API.
    const task = ResultTask.forEach(
      [0, 1, 2],
      (index) => {
        visits.push(index)
        if (index === 0) queueMicrotask(() => controller.abort('queued-stop'))
        return ResultTask.ok(index)
      },
      { concurrency: 2 },
    )

    deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'queued-stop' },
    })
    deepEqual(visits, [0, 1])
  })

  it('keeps the remaining scheduling budget when immediate successes precede a complex item', async () => {
    const controller = new AbortController()
    let started = false
    const later = ResultTask.sync(() => {
      started = true
      return 2
    })

    deepEqual(
      await ResultTask.runExit(ResultTask.all([ResultTask.ok(0), ResultTask.ok(1), later]), {
        signal: controller.signal,
        yieldEvery: 3,
        scheduler: {
          yield: async () => {
            controller.abort('budget-exhausted')
          },
        },
      }),
      { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'budget-exhausted' } },
    )
    equal(started, false)
  })
})
