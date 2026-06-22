import { deepEqual, equal, ok as isTrue, rejects } from 'node:assert'

import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import type { ResultAsyncRetryContext, ResultAsyncRetryTask, AbortError } from '../src/index.js'

import { Result, ResultAsync, isAbortError } from '../src/index.js'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const okTask =
  <T, E = never>(value: T): ResultAsyncRetryTask<T, E> =>
  () =>
    ResultAsync.okAsync<T, E>(value)

describe('ResultAsync retry helpers', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const attempts: number[] = []
    const result = await ResultAsync.retry(
      (attempt) => {
        attempts.push(attempt)
        return ResultAsync.okAsync<string, 'transient'>('ok')
      },
      { times: 3 },
    )

    isTrue(result.isOk())
    equal(result.value, 'ok')
    deepEqual(attempts, [0])
  })

  it('retries until an eventual success', async () => {
    const contexts: ResultAsyncRetryContext[] = []
    let calls = 0

    const result = ResultAsync.retry(
      (attempt) => {
        calls += 1

        if (attempt < 2) {
          return ResultAsync.errAsync<string, 'transient'>('transient')
        }

        return ResultAsync.okAsync<string, 'transient'>('ok')
      },
      {
        onRetry: (_error, context) => {
          contexts.push(context)
        },
        times: 5,
      },
    )

    expectTypeOf(result).toExtend<ResultAsync<string, 'transient' | AbortError>>()

    const resolved = await result

    isTrue(resolved.isOk())
    equal(resolved.value, 'ok')
    equal(calls, 3)
    deepEqual(contexts, [
      { attempt: 0, nextAttempt: 1, retriesRemaining: 5 },
      { attempt: 1, nextAttempt: 2, retriesRemaining: 4 },
    ])
  })

  it('returns the last typed error when retries are exhausted', async () => {
    const result = await ResultAsync.retry(
      (attempt) => ResultAsync.errAsync<number, `error-${number}`>(`error-${attempt}`),
      { times: 2 },
    )

    isTrue(result.isErr())
    equal(result.error, 'error-2')
  })

  it('does not retry when the error predicate rejects the error', async () => {
    const attempts: number[] = []

    const result = await ResultAsync.retry(
      (attempt) => {
        attempts.push(attempt)
        return ResultAsync.errAsync<number, 'fatal'>('fatal')
      },
      { times: 5, while: (error) => error !== 'fatal' },
    )

    isTrue(result.isErr())
    equal(result.error, 'fatal')
    deepEqual(attempts, [0])
  })

  it('recovers with retryOrElse after exhaustion', async () => {
    const result = ResultAsync.retryOrElse(
      () => ResultAsync.errAsync<number, 'transient'>('transient'),
      { orElse: (error, context) => Result.ok(`fallback:${error}:${context.attempt}`), times: 1 },
    )

    expectTypeOf(result).toExtend<ResultAsync<number | string, AbortError>>()

    const resolved = await result

    isTrue(resolved.isOk())
    equal(resolved.value, 'fallback:transient:1')
  })

  it('supports async retryOrElse failures with fallback error inference', async () => {
    const result = ResultAsync.retryOrElse(okTask<number, 'task-error'>(1), {
      orElse: () => ResultAsync.errAsync<string, 'fallback-error'>('fallback-error'),
      times: 1,
    })

    expectTypeOf(result).toExtend<ResultAsync<number | string, 'fallback-error' | AbortError>>()

    const resolved = await result

    isTrue(resolved.isOk())
    equal(resolved.value, 1)
  })

  it('honors numeric and context-derived retry delays', async () => {
    const delays: number[] = []
    const startedAt = Date.now()

    const result = await ResultAsync.retry(
      (attempt) =>
        attempt < 2
          ? ResultAsync.errAsync<string, 'transient'>('transient')
          : ResultAsync.okAsync<string, 'transient'>('ok'),
      {
        delayMs: (context) => {
          const delay = context.nextAttempt
          delays.push(delay)
          return delay
        },
        times: 2,
      },
    )

    isTrue(result.isOk())
    equal(result.value, 'ok')
    deepEqual(delays, [1, 2])
    isTrue(Date.now() - startedAt >= 2)
  })

  it('applies jittered retry delays', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.75)
    let calls = 0

    try {
      const resultPromise = ResultAsync.retry(
        () => {
          calls += 1

          return calls === 1
            ? ResultAsync.errAsync<string, 'transient'>('transient')
            : ResultAsync.okAsync<string, 'transient'>('ok')
        },
        { delayMs: 100, jittered: 0.5, times: 1 },
      )

      await vi.advanceTimersByTimeAsync(124)
      equal(calls, 1)

      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise

      isTrue(result.isOk())
      equal(result.value, 'ok')
      equal(calls, 2)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not apply jitter when jittered is zero', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random')
    let calls = 0

    try {
      const resultPromise = ResultAsync.retry(
        () => {
          calls += 1

          return calls === 1
            ? ResultAsync.errAsync<string, 'transient'>('transient')
            : ResultAsync.okAsync<string, 'transient'>('ok')
        },
        { delayMs: 100, jittered: 0, times: 1 },
      )

      await vi.advanceTimersByTimeAsync(99)
      equal(calls, 1)

      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise

      isTrue(result.isOk())
      equal(result.value, 'ok')
      equal(calls, 2)
      equal(randomSpy.mock.calls.length, 0)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('ignores onRetry callback failures', async () => {
    const result = await ResultAsync.retry(
      (attempt) =>
        attempt === 0
          ? ResultAsync.errAsync<string, 'transient'>('transient')
          : ResultAsync.okAsync<string, 'transient'>('ok'),
      {
        onRetry: () => {
          throw new Error('diagnostic failed')
        },
        times: 1,
      },
    )

    isTrue(result.isOk())
    equal(result.value, 'ok')
  })

  it('rejects invalid retry options with IllegalArgumentException', async () => {
    await rejects(
      async () => await ResultAsync.retry(okTask('ok'), { times: -1 }),
      (error) => error instanceof Error && error.name === 'IllegalArgumentException',
    )
    await rejects(
      async () =>
        await ResultAsync.retry(okTask('ok'), { delayMs: Number.POSITIVE_INFINITY, times: 1 }),
      (error) => error instanceof Error && error.name === 'IllegalArgumentException',
    )
    await rejects(
      async () =>
        await ResultAsync.retry(() => ResultAsync.errAsync<string, 'transient'>('transient'), {
          delayMs: () => -1,
          times: 1,
        }),
      (error) => error instanceof Error && error.name === 'IllegalArgumentException',
    )
    await rejects(
      async () => await ResultAsync.retry(okTask('ok'), { jittered: Number.NaN, times: 1 }),
      (error) => error instanceof Error && error.name === 'IllegalArgumentException',
    )
    await rejects(
      async () => await ResultAsync.retry(okTask('ok'), { jittered: -1, times: 1 }),
      (error) => error instanceof Error && error.name === 'IllegalArgumentException',
    )
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(2)

    try {
      await rejects(
        async () =>
          await ResultAsync.retry(() => ResultAsync.errAsync<string, 'transient'>('transient'), {
            delayMs: 1,
            jittered: 0.5,
            times: 1,
          }),
        (error) => error instanceof Error && error.name === 'IllegalArgumentException',
      )
    } finally {
      randomSpy.mockRestore()
    }
  })

  it('returns AbortError when aborted before the first attempt', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already aborted'))

    const result = await ResultAsync.retry(() => ResultAsync.okAsync<string, 'transient'>('ok'), {
      signal: controller.signal,
      times: 1,
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
  })

  it('returns AbortError when aborted before retry delay completes', async () => {
    const controller = new AbortController()
    const resultPromise = ResultAsync.retry(
      () => ResultAsync.errAsync<string, 'transient'>('transient'),
      { delayMs: 50, signal: controller.signal, times: 2 },
    )

    await sleep(5)
    controller.abort(new Error('stop retrying'))

    const result = await resultPromise

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
  })
})
