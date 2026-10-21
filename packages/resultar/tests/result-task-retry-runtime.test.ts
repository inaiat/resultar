import { deepEqual, equal } from 'node:assert/strict'
import { describe, it, vi } from 'vite-plus/test'
import { Retry } from '../src/core/retry.js'
import { err, ok } from '../src/result/result.js'
import { ResultTask } from '../src/task/result-task.js'

describe('ResultTask retry runtime boundaries', () => {
  it.each(['synchronous', 'asynchronous'] as const)(
    'isolates concurrent and repeated runs with Promise attempts and %s release',
    async (releaseMode) => {
      const held = new Set<number>()
      const releases: number[] = []
      const retryAttempts: number[] = []
      let acquisitions = 0
      const release = (resource: number): void => {
        equal(held.delete(resource), true)
        releases.push(resource)
      }
      const task = ResultTask.gen(function* () {
        const resource = yield* ResultTask.acquireRelease({
          acquire: ResultTask.fromResultAsync(async () => {
            await Promise.resolve()
            acquisitions += 1
            held.add(acquisitions)
            return ok(acquisitions)
          }),
          release: (resource) =>
            releaseMode === 'synchronous'
              ? ResultTask.sync(() => {
                  release(resource)
                })
              : ResultTask.fromResultAsync(async () => {
                  await Promise.resolve()
                  release(resource)
                  return ok(undefined)
                }),
        })
        return yield* ResultTask.err(resource)
      }).retry(
        Retry.policy({
          times: 2,
          while: (resource, context) => {
            equal(held.has(resource), false)
            retryAttempts.push(context.attempt)
            return true
          },
        }),
      )

      const concurrent = await Promise.all([ResultTask.runResult(task), ResultTask.runResult(task)])
      equal(
        concurrent.every((result) => result.isErr()),
        true,
      )
      equal(acquisitions, 6)
      equal(held.size, 0)
      deepEqual(
        retryAttempts.toSorted((left, right) => left - right),
        [0, 0, 1, 1],
      )
      deepEqual(await ResultTask.runResult(task), err(9))
      equal(acquisitions, 9)
      equal(held.size, 0)
      deepEqual(retryAttempts.slice(4), [0, 1])
      deepEqual(
        releases.toSorted((left, right) => left - right),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      )
    },
  )

  it('yields immediate retries to event-loop peers without an external signal', async () => {
    let attempts = 0
    let finished = false
    let peerBeforeCompletion = false
    let attemptsAtPeer = 0
    const peer = new Promise<void>((resolve) => {
      setImmediate(() => {
        peerBeforeCompletion = !finished
        attemptsAtPeer = attempts
        resolve()
      })
    })
    const task = ResultTask.sync(() => {
      attempts += 1
    })
      .andThen(() => ResultTask.err('offline'))
      .retry(Retry.policy({ times: 10_000 }))
    const running = ResultTask.runResult(task, { yieldEvery: 32 }).then((result) => {
      finished = true
      return result
    })

    const [result] = await Promise.all([running, peer])
    deepEqual(result, err('offline'))
    equal(attempts, 10_001)
    equal(peerBeforeCompletion, true)
    equal(attemptsAtPeer > 0, true)
    equal(attemptsAtPeer < attempts, true)
  })

  it('keeps long synchronous retries stack safe when automatic yields are disabled', async () => {
    const dispatch = vi.fn(() => Promise.resolve())
    let attempts = 0
    let observations = 0
    const task = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
      .andThen((attempt) => ResultTask.err(attempt))
      .retry(
        Retry.policy({
          times: 10_000,
          onRetry: () => {
            observations += 1
          },
        }),
      )

    deepEqual(
      await ResultTask.runResult(task, { yieldEvery: Infinity, scheduler: { yield: dispatch } }),
      err(10_001),
    )
    equal(attempts, 10_001)
    equal(observations, 10_000)
    equal(dispatch.mock.calls.length, 0)
  })

  it.each(['runExit', 'runResult'] as const)(
    'allows cancellation immediately after %s starts a synchronous failed attempt',
    async (runner) => {
      const controller = new AbortController()
      const predicate = vi.fn(() => true)
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(Retry.policy({ times: 10, while: predicate }))

      const running =
        runner === 'runExit'
          ? ResultTask.runExit(task, { signal: controller.signal })
          : ResultTask.runResult(task, { signal: controller.signal })
      equal(attempts, 1)
      controller.abort('cancel before retry')
      if (runner === 'runExit') {
        deepEqual(await running, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'offline' } })
      } else {
        deepEqual(await running, err('offline'))
      }
      equal(attempts, 1)
      equal(predicate.mock.calls.length, 0)
    },
  )

  it('keeps callbacks within the retry budget and skips them after synchronous success', async () => {
    const observed: number[] = []
    const inspected: number[] = []
    const delay = vi.fn(() => 0)
    const policy = Retry.policy<number>({
      times: 2,
      while: (error, context) => {
        inspected.push(error)
        equal(context.attempt, error - 1)
        return true
      },
      onRetry: (error) => {
        observed.push(error)
      },
      delayMs: delay,
    })
    deepEqual(await ResultTask.runResult(ResultTask.ok(42).retry(policy)), ok(42))
    deepEqual(inspected, [])
    let attempts = 0
    const task = ResultTask.sync(() => {
      attempts += 1
      return attempts
    })
      .andThen((attempt) => ResultTask.err(attempt))
      .retry(policy)

    deepEqual(await ResultTask.runResult(task), err(3))
    deepEqual(inspected, [1, 2])
    deepEqual(observed, [1, 2])
    equal(delay.mock.calls.length, 2)
    equal(attempts, 3)
  })

  it('waits for a pending release before synchronous hooks and the next attempt', async () => {
    const releaseStarted = Promise.withResolvers<void>()
    const releaseFinished = Promise.withResolvers<void>()
    const events: string[] = []
    let attempts = 0
    const task = ResultTask.gen(function* () {
      const attempt = yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempts += 1
          events.push(`attempt:${attempts}`)
          return attempts
        }),
        release: (attempt) =>
          ResultTask.tryPromise(async () => {
            events.push(`release:start:${attempt}`)
            if (attempt === 1) {
              releaseStarted.resolve()
              await releaseFinished.promise
            }
            events.push(`release:end:${attempt}`)
          }),
      })
      if (attempt === 1) return yield* ResultTask.err('offline')
      return attempt
    }).retry(
      Retry.policy({
        times: 1,
        while: () => {
          events.push('while')
          return true
        },
        onRetry: () => {
          events.push('onRetry')
        },
      }),
    )

    const running = ResultTask.runResult(task)
    await releaseStarted.promise
    deepEqual(events, ['attempt:1', 'release:start:1'])
    releaseFinished.resolve()
    deepEqual(await running, ok(2))
    deepEqual(events, [
      'attempt:1',
      'release:start:1',
      'release:end:1',
      'while',
      'onRetry',
      'attempt:2',
      'release:start:2',
      'release:end:2',
    ])
  })

  it('does not retry after a pending release adds a failure to the body failure', async () => {
    const releaseStarted = Promise.withResolvers<void>()
    const releaseFinished = Promise.withResolvers<void>()
    const predicate = vi.fn(() => true)
    const observer = vi.fn()
    let attempts = 0
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => {
          attempts += 1
        }),
        release: () =>
          ResultTask.tryPromise(() => {
            releaseStarted.resolve()
            return releaseFinished.promise
          }).andThen(() => ResultTask.err('release')),
      })
      return yield* ResultTask.err('body')
    }).retry(Retry.policy({ times: 2, while: predicate, onRetry: observer }))

    const running = ResultTask.runExit(task)
    await releaseStarted.promise
    equal(attempts, 1)
    equal(predicate.mock.calls.length, 0)
    releaseFinished.resolve()
    deepEqual(await running, {
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: { _tag: 'Fail', error: 'body' },
        right: { _tag: 'Fail', error: 'release' },
      },
    })
    equal(attempts, 1)
    equal(predicate.mock.calls.length, 0)
    equal(observer.mock.calls.length, 0)
  })

  it.each(['throw', 'reject'] as const)(
    'preserves a synchronous predicate %s as a defect before observer and delay',
    async (mode) => {
      const defect = new Error('predicate failed')
      const observer = vi.fn()
      const delay = vi.fn(() => 0)
      const task = ResultTask.err('offline').retry(
        Retry.policy({
          times: 1,
          while: () => {
            if (mode === 'throw') throw defect
            return Promise.reject(defect)
          },
          onRetry: observer,
          delayMs: delay,
        }),
      )

      deepEqual(await ResultTask.runExit(task), { _tag: 'Failure', cause: { _tag: 'Die', defect } })
      equal(observer.mock.calls.length, 0)
      equal(delay.mock.calls.length, 0)
    },
  )

  it.each(['throw', 'reject'] as const)(
    'ignores an observer %s and continues the next attempt',
    async (mode) => {
      const defect = new Error('observer failed')
      const observer = vi.fn(() => {
        if (mode === 'throw') throw defect
        return Promise.reject(defect)
      })
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
        return attempts
      })
        .andThen((attempt) => (attempt === 1 ? ResultTask.err('offline') : ResultTask.ok(attempt)))
        .retry(Retry.policy({ times: 1, onRetry: observer }))

      deepEqual(await ResultTask.runResult(task), ok(2))
      equal(attempts, 2)
      equal(observer.mock.calls.length, 1)
    },
  )

  it.each(['throw', 'reject'] as const)(
    'preserves a delay defect after ignoring an observer %s',
    async (mode) => {
      const observerDefect = new Error('observer failed')
      const delayDefect = new Error('delay failed')
      const observer = vi.fn(() => {
        if (mode === 'throw') throw observerDefect
        return Promise.reject(observerDefect)
      })
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(
          Retry.policy({
            times: 1,
            onRetry: observer,
            delayMs: () => {
              throw delayDefect
            },
          }),
        )

      deepEqual(await ResultTask.runExit(task), {
        _tag: 'Failure',
        cause: { _tag: 'Die', defect: delayDefect },
      })
      equal(attempts, 1)
      equal(observer.mock.calls.length, 1)
    },
  )

  it.each(['while', 'onRetry'] as const)(
    'stops before delay and the next body when synchronous %s cancels',
    async (hook) => {
      const controller = new AbortController()
      const events: string[] = []
      const delay = vi.fn(() => 0)
      const task = ResultTask.sync(() => {
        events.push('attempt')
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(
          Retry.policy({
            times: 2,
            while: () => {
              events.push('while')
              if (hook === 'while') controller.abort('stop in hook')
              return true
            },
            onRetry: () => {
              events.push('onRetry')
              if (hook === 'onRetry') controller.abort('stop in hook')
            },
            delayMs: delay,
          }),
        )

      deepEqual(await ResultTask.runExit(task, { signal: controller.signal }), {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'stop in hook' },
      })
      deepEqual(events, hook === 'while' ? ['attempt', 'while'] : ['attempt', 'while', 'onRetry'])
      equal(delay.mock.calls.length, 0)
    },
  )

  it.each(['while', 'onRetry'] as const)(
    'consumes a late %s rejection after external interruption',
    async (hook) => {
      const controller = new AbortController()
      const started = Promise.withResolvers<void>()
      const decision = Promise.withResolvers<boolean>()
      const observation = Promise.withResolvers<void>()
      const delay = vi.fn(() => 0)
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
      })
        .andThen(() => ResultTask.err('offline'))
        .retry(
          Retry.policy({
            times: 2,
            while: () => {
              if (hook !== 'while') return true
              started.resolve()
              return decision.promise
            },
            onRetry: () => {
              started.resolve()
              return observation.promise
            },
            delayMs: delay,
          }),
        )

      const running = ResultTask.runExit(task, { signal: controller.signal })
      await started.promise
      controller.abort('stop pending hook')
      deepEqual(await running, {
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', reason: 'stop pending hook' },
      })
      if (hook === 'while') decision.reject(new Error('late predicate rejection'))
      else observation.reject(new Error('late observer rejection'))
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
      equal(attempts, 1)
      equal(delay.mock.calls.length, 0)
    },
  )

  it.each(['while', 'onRetry'] as const)(
    'adopts a native %s Promise without reading its poisoned own then',
    async (hook) => {
      const predicate = Promise.resolve(true)
      const observer = Promise.resolve()
      const poisoned = hook === 'while' ? predicate : observer
      let reads = 0
      void Object.defineProperty(poisoned, 'then', {
        get: () => {
          reads += 1
          throw new Error('own then must not be read by await')
        },
      })
      let attempts = 0
      const task = ResultTask.sync(() => {
        attempts += 1
        return attempts
      })
        .andThen((attempt) => (attempt === 1 ? ResultTask.err('offline') : ResultTask.ok(attempt)))
        .retry(Retry.policy({ times: 1, while: () => predicate, onRetry: () => observer }))

      deepEqual(await ResultTask.runResult(task), ok(2))
      equal(attempts, 2)
      equal(reads, 0)
    },
  )
})
