import { deepEqual, equal, ok as isTrue } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { ResultAsyncRaceTask } from '../src/index.js'

import { Result, ResultAsync, createTaggedError } from '../src/index.js'

class TimeoutError extends createTaggedError({
  message: '$operation timed out after $timeoutMs milliseconds',
  name: 'TimeoutError',
}) {}

const delayedOk =
  <T, E = never>(
    value: T,
    delayMs: number,
    onAbort?: (reason: unknown) => void,
  ): ResultAsyncRaceTask<T, E> =>
  (signal) =>
    new ResultAsync<T, E>(
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(Result.ok<T, E>(value))
        }, delayMs)

        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout)
            onAbort?.(signal.reason)
          },
          { once: true },
        )
      }),
    )

const delayedErr =
  <T = never, E = unknown>(
    error: E,
    delayMs: number,
    onAbort?: (reason: unknown) => void,
  ): ResultAsyncRaceTask<T, E> =>
  (signal) =>
    new ResultAsync<T, E>(
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(Result.err<T, E>(error))
        }, delayMs)

        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout)
            onAbort?.(signal.reason)
          },
          { once: true },
        )
      }),
    )

describe('ResultAsync racing helpers', () => {
  it('race returns the first success and ignores earlier errors', async () => {
    let completedErrorAborted = false

    const result = await ResultAsync.race(
      delayedErr<number, 'primary-error'>('primary-error', 5, () => {
        completedErrorAborted = true
      }),
      delayedOk<string, 'fallback-error'>('fallback', 15),
    )

    isTrue(result.isOk())
    equal(result.value, 'fallback')
    equal(completedErrorAborted, false)
  })

  it('race aborts losers after a success', async () => {
    let loserAbortReason: unknown = undefined

    const result = await ResultAsync.race(
      delayedOk('winner', 5),
      delayedOk('loser', 50, (reason) => {
        loserAbortReason = reason
      }),
    )

    isTrue(result.isOk())
    equal(result.value, 'winner')
    isTrue(loserAbortReason instanceof Error)
    equal(loserAbortReason.name, 'AbortError')
  })

  it('race returns the last completed error when every task fails', async () => {
    const result = await ResultAsync.race(
      delayedErr('first-error', 5),
      delayedErr('last-error', 15),
    )

    isTrue(result.isErr())
    equal(result.error, 'last-error')
  })

  it('raceAll starts all tasks concurrently and returns the first success', async () => {
    const started: string[] = []

    const result = ResultAsync.raceAll([
      (signal) => {
        started.push('a')
        return delayedOk<'a', 'a-error'>('a', 30)(signal)
      },
      (signal) => {
        started.push('b')
        return delayedOk<'b', 'b-error'>('b', 5)(signal)
      },
    ] as const)

    expectTypeOf(result).toExtend<ResultAsync<'a' | 'b', 'a-error' | 'b-error'>>()

    const resolved = await result

    deepEqual(started, ['a', 'b'])
    isTrue(resolved.isOk())
    equal(resolved.value, 'b')
  })

  it('raceFirst returns the first completed error', async () => {
    let loserAborted = false

    const result = await ResultAsync.raceFirst(
      delayedErr('first-error', 5),
      delayedOk('late-success', 30, () => {
        loserAborted = true
      }),
    )

    isTrue(result.isErr())
    equal(result.error, 'first-error')
    equal(loserAborted, true)
  })

  it('raceWith lets the finisher wait for the loser', async () => {
    const result = await ResultAsync.raceWith(
      delayedErr<string, 'left-error'>('left-error', 5),
      delayedOk<string, 'right-error'>('right-success', 15),
      {
        onLeftDone: (_left, right) => right.wait(),
        onRightDone: (right, left) => {
          left.abort()
          return right
        },
      },
    )

    isTrue(result.isOk())
    equal(result.value, 'right-success')
  })

  it('timeout returns timeout errors and aborts the task signal', async () => {
    let abortReason: unknown = undefined

    const result = await ResultAsync.timeout(
      delayedOk('late-success', 50, (reason) => {
        abortReason = reason
      }),
      { onTimeout: () => new TimeoutError({ operation: 'load user', timeoutMs: 5 }), timeoutMs: 5 },
    )

    isTrue(result.isErr())
    isTrue(result.error instanceof TimeoutError)
    equal(result.error.message, 'load user timed out after 5 milliseconds')
    equal(abortReason, result.error)
  })

  it('timeout preserves task errors that finish before the timer', async () => {
    const result = await ResultAsync.timeout(delayedErr('task-error', 5), {
      onTimeout: () => new TimeoutError({ operation: 'load user', timeoutMs: 50 }),
      timeoutMs: 50,
    })

    isTrue(result.isErr())
    equal(result.error, 'task-error')
  })
})
