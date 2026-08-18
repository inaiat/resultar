import { deepEqual, equal, ok as isTrue, rejects } from 'node:assert'

import { describe, expectTypeOf, it, vi } from 'vite-plus/test'

import type {
  ResultAsyncAbortSignal,
  ResultAsyncRetryContext,
  ResultAsyncRetryTask,
  AbortError,
} from '../src/index.js'

import { Result, ResultAsync, isAbortError } from '../src/index.js'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const okTask =
  <T, E = never>(value: T): ResultAsyncRetryTask<T, E> =>
  () =>
    ResultAsync.okAsync<T, E>(value)

const illegalArgument = (message: string) => (error: unknown) =>
  error instanceof Error && error.name === 'IllegalArgumentException' && error.message === message

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

  it('does not retry when times is zero', async () => {
    const attempts: number[] = []
    const result = await ResultAsync.retry(
      (attempt) => {
        attempts.push(attempt)
        return ResultAsync.errAsync<number, `error-${number}`>(`error-${attempt}`)
      },
      { times: 0 },
    )

    isTrue(result.isErr())
    equal(result.error, 'error-0')
    deepEqual(attempts, [0])
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

  it('does not apply jitter when delay is zero', async () => {
    const randomSpy = vi.spyOn(Math, 'random')
    let calls = 0

    try {
      const result = await ResultAsync.retry(
        () => {
          calls += 1

          return calls === 1
            ? ResultAsync.errAsync<string, 'transient'>('transient')
            : ResultAsync.okAsync<string, 'transient'>('ok')
        },
        { delayMs: 0, jittered: 0.5, times: 1 },
      )

      isTrue(result.isOk())
      equal(result.value, 'ok')
      equal(randomSpy.mock.calls.length, 0)
    } finally {
      randomSpy.mockRestore()
    }

    const negativeRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(-0.1)

    try {
      await rejects(
        async () =>
          await ResultAsync.retry(() => ResultAsync.errAsync<string, 'transient'>('transient'), {
            delayMs: 1,
            jittered: 0.5,
            times: 1,
          }),
        illegalArgument(
          'ResultAsync retry jitter random value must be a finite number between 0 and 1',
        ),
      )
    } finally {
      negativeRandomSpy.mockRestore()
    }
  })

  it('does not subscribe to abort when retry delay is zero', async () => {
    let calls = 0
    const signal: ResultAsyncAbortSignal = {
      aborted: false,
      addEventListener: () => {
        throw new Error('Zero retry delay should not subscribe to abort')
      },
      removeEventListener: () => undefined,
    }

    const result = await ResultAsync.retry(
      () => {
        calls += 1

        return calls === 1
          ? ResultAsync.errAsync<string, 'transient'>('transient')
          : ResultAsync.okAsync<string, 'transient'>('ok')
      },
      { delayMs: 0, signal, times: 1 },
    )

    isTrue(result.isOk())
    equal(result.value, 'ok')
    equal(calls, 2)
  })

  it('accepts the upper random jitter boundary', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
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

      await vi.advanceTimersByTimeAsync(149)
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

  it('accepts the lower random jitter boundary', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
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

      await vi.advanceTimersByTimeAsync(49)
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
      illegalArgument('ResultAsync retry times must be a non-negative integer'),
    )
    await rejects(
      async () =>
        await ResultAsync.retry(okTask('ok'), { delayMs: Number.POSITIVE_INFINITY, times: 1 }),
      illegalArgument('ResultAsync retry delayMs must be a non-negative finite number'),
    )
    await rejects(
      async () =>
        await ResultAsync.retry(() => ResultAsync.errAsync<string, 'transient'>('transient'), {
          delayMs: () => -1,
          times: 1,
        }),
      illegalArgument('ResultAsync retry delayMs must be a non-negative finite number'),
    )
    await rejects(
      async () => await ResultAsync.retry(okTask('ok'), { jittered: Number.NaN, times: 1 }),
      illegalArgument('ResultAsync retry jittered must be a non-negative finite number'),
    )
    await rejects(
      async () => await ResultAsync.retry(okTask('ok'), { jittered: -1, times: 1 }),
      illegalArgument('ResultAsync retry jittered must be a non-negative finite number'),
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
        illegalArgument(
          'ResultAsync retry jitter random value must be a finite number between 0 and 1',
        ),
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
    equal(result.error.message, 'ResultAsync retry aborted')
    equal(result.error.cause, controller.signal.reason)
  })

  it('returns AbortError without cause when a custom signal has no reason', async () => {
    const signal = {
      aborted: true,
      addEventListener: () => undefined,
      reason: undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal
    const result = await ResultAsync.retry(() => ResultAsync.okAsync<string, 'transient'>('ok'), {
      signal,
      times: 1,
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.message, 'ResultAsync retry aborted')
    equal('cause' in result.error, false)
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
    equal(result.error.message, 'ResultAsync retry aborted')
    equal(result.error.cause, controller.signal.reason)
  })

  it('does not start a retry delay when onRetry aborts the signal', async () => {
    let aborted = false
    const reason = new Error('stop before wait')
    const signal: ResultAsyncAbortSignal = {
      get aborted() {
        return aborted
      },
      get reason() {
        return reason
      },
      addEventListener: () => {
        throw new Error('Aborted retry delay should not subscribe to abort')
      },
      removeEventListener: () => undefined,
    }

    const result = await ResultAsync.retry(
      () => ResultAsync.errAsync<string, 'transient'>('transient'),
      {
        delayMs: 50,
        onRetry: () => {
          aborted = true
        },
        signal,
        times: 1,
      },
    )

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.message, 'ResultAsync retry aborted')
    equal(result.error.cause, reason)
  })

  it('removes the retry abort listener after a completed delay', async () => {
    vi.useFakeTimers()
    let calls = 0
    let abortListener = (): void => {
      throw new Error('Abort listener was not registered')
    }
    const addEventListener = vi.fn<ResultAsyncAbortSignal['addEventListener']>(
      (eventName, listener, options) => {
        abortListener = listener
        equal(eventName, 'abort')
        deepEqual(options, { once: true })
      },
    )
    const removeEventListener = vi.fn<ResultAsyncAbortSignal['removeEventListener']>(
      (eventName, listener) => {
        equal(eventName, 'abort')
        equal(listener, abortListener)
      },
    )
    const signal: ResultAsyncAbortSignal = { aborted: false, addEventListener, removeEventListener }

    try {
      const resultPromise = ResultAsync.retry(
        () => {
          calls += 1

          return calls === 1
            ? ResultAsync.errAsync<string, 'transient'>('transient')
            : ResultAsync.okAsync<string, 'transient'>('ok')
        },
        { delayMs: 20, signal, times: 1 },
      )

      await vi.advanceTimersByTimeAsync(19)
      equal(calls, 1)

      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise

      isTrue(result.isOk())
      equal(result.value, 'ok')
      equal(calls, 2)
      equal(addEventListener.mock.calls.length, 1)
      equal(removeEventListener.mock.calls.length, 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the retry abort listener to stop a pending delay', async () => {
    vi.useFakeTimers()
    const reason = new Error('stop retrying now')
    let abortListener = (): void => {
      throw new Error('Abort listener was not registered')
    }
    const signal: ResultAsyncAbortSignal = {
      aborted: false,
      get reason() {
        return reason
      },
      addEventListener: vi.fn<ResultAsyncAbortSignal['addEventListener']>(
        (_eventName, listener) => {
          abortListener = listener
        },
      ),
      removeEventListener: vi.fn<ResultAsyncAbortSignal['removeEventListener']>(),
    }

    try {
      const resultPromise = ResultAsync.retry(
        () => ResultAsync.errAsync<string, 'transient'>('transient'),
        { delayMs: 50, signal, times: 1 },
      )

      await vi.advanceTimersByTimeAsync(0)
      abortListener()
      equal(vi.getTimerCount(), 0)
      const result = await resultPromise

      isTrue(result.isErr())
      isTrue(isAbortError(result.error))
      equal(result.error.message, 'ResultAsync retry aborted')
      equal(result.error.cause, reason)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns AbortError when aborted before waiting for retry delay', async () => {
    const controller = new AbortController()
    const reason = new Error('stop before wait')
    const result = await ResultAsync.retry(
      () => ResultAsync.errAsync<string, 'transient'>('transient'),
      {
        delayMs: 50,
        onRetry: () => {
          controller.abort(reason)
        },
        signal: controller.signal,
        times: 2,
      },
    )

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.message, 'ResultAsync retry aborted')
    equal(result.error.cause, reason)
  })
})
