import { equal, ok as isTrue, rejects } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  AbortError,
  ResultAsync as ResultAsyncType,
  ResultAsyncAbortSignal,
  ResultAsyncCallbackCleanup,
  ResultAsyncFromCallbackOptions,
} from '../src/index.js'

import { ResultAsync, fromCallback, isAbortError } from '../src/index.js'

class CallbackError extends Error {
  public constructor(cause: unknown) {
    super('Callback operation failed', { cause })
  }
}

const toCallbackError = (cause: unknown) => new CallbackError(cause)

describe('ResultAsync callback helpers', () => {
  it('resolves synchronous callbacks and runs returned cleanup once', async () => {
    let cleanupCalls = 0
    let callbackAborted: boolean | undefined = undefined

    const result = await fromCallback<number, CallbackError>({
      catch: toCallbackError,
      subscribe: (context) => {
        callbackAborted = context.signal.aborted
        context.resolve(42)

        return () => {
          cleanupCalls += 1
        }
      },
    })

    isTrue(result.isOk())
    equal(result.value, 42)
    equal(callbackAborted, false)
    equal(cleanupCalls, 1)
  })

  it('maps callback rejection and runs cleanup', async () => {
    const cause = new Error('subscription failed')
    let cleanupCalls = 0

    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      subscribe: ({ reject }) => {
        queueMicrotask(() => reject(cause))

        return () => {
          cleanupCalls += 1
        }
      },
    })

    isTrue(result.isErr())
    isTrue(result.error instanceof CallbackError)
    equal(result.error.cause, cause)
    equal(cleanupCalls, 1)
  })

  it('maps synchronous subscription throws', async () => {
    const cause = new Error('registration failed')
    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      subscribe: () => {
        throw cause
      },
    })

    isTrue(result.isErr())
    isTrue(result.error instanceof CallbackError)
    equal(result.error.cause, cause)
  })

  it('does not subscribe when the incoming signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('already stopped')
    let subscribed = false

    controller.abort(reason)

    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      signal: controller.signal,
      subscribe: () => {
        subscribed = true
      },
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.message, 'ResultAsync callback aborted')
    equal(result.error.cause, reason)
    equal(subscribed, false)
  })

  it('returns the default AbortError when cancellation has no reason', async () => {
    const signal: ResultAsyncAbortSignal = {
      aborted: true,
      addEventListener: () => undefined,
      reason: undefined,
      removeEventListener: () => undefined,
    }
    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      signal,
      subscribe: () => undefined,
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.message, 'ResultAsync callback aborted')
    equal('cause' in result.error, false)
  })

  it('aborts an active subscription and runs cleanup', async () => {
    const controller = new AbortController()
    const reason = new Error('stop waiting')
    let cleanupCalls = 0

    const pending = ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      signal: controller.signal,
      subscribe: () => () => {
        cleanupCalls += 1
      },
    })

    controller.abort(reason)

    const result = await pending

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(result.error.cause, reason)
    equal(cleanupCalls, 1)
  })

  it('keeps the first settlement and ignores cleanup throws', async () => {
    let mappedErrors = 0
    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: (cause) => {
        mappedErrors += 1
        return toCallbackError(cause)
      },
      subscribe: ({ reject, resolve }) => {
        resolve(7)
        reject(new Error('late failure'))

        return () => {
          throw new Error('cleanup failed')
        }
      },
    })

    isTrue(result.isOk())
    equal(result.value, 7)
    equal(mappedErrors, 0)
  })

  it('keeps the first value when resolve is called repeatedly', async () => {
    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      subscribe: ({ resolve }) => {
        resolve(7)
        resolve(8)
      },
    })

    isTrue(result.isOk())
    equal(result.value, 7)
  })

  it('unsubscribes when the error mapper throws', async () => {
    const mapperError = new Error('mapper failed')
    let cleanupCalls = 0
    const pending = ResultAsync.fromCallback<number, CallbackError>({
      catch: () => {
        throw mapperError
      },
      subscribe: ({ reject }) => {
        queueMicrotask(() => reject(new Error('callback failed')))

        return () => {
          cleanupCalls += 1
        }
      },
    })

    await rejects(async () => await pending, mapperError)
    equal(cleanupCalls, 1)
  })

  it('normalizes non-Error values thrown by the error mapper', async () => {
    const mapperFailure = 'mapper failed'
    const pending = ResultAsync.fromCallback<number, CallbackError>({
      catch: () => {
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- verifies unknown JavaScript throws.
        throw mapperFailure
      },
      subscribe: ({ reject }) => {
        queueMicrotask(() => reject(new Error('callback failed')))
      },
    })

    await rejects(
      async () => await pending,
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'ResultAsync callback error mapper threw a non-Error value' &&
        error.cause === mapperFailure,
    )
  })

  it('removes the exact abort listener after settlement', async () => {
    let addedListener: (() => void) | undefined = undefined
    let removeCalls = 0
    let removedListener: (() => void) | undefined = undefined
    let removedType: 'abort' | undefined = undefined
    const signal: ResultAsyncAbortSignal = {
      aborted: false,
      addEventListener: (_type, listener) => {
        addedListener = listener
      },
      reason: undefined,
      removeEventListener: (type, listener) => {
        removeCalls += 1
        removedListener = listener
        removedType = type
      },
    }
    const result = await ResultAsync.fromCallback<number, CallbackError>({
      catch: toCallbackError,
      signal,
      subscribe: ({ resolve }) => resolve(1),
    })

    isTrue(result.isOk())
    equal(removeCalls, 1)
    equal(removedType, 'abort')
    equal(removedListener, addedListener)
  })

  it('exports callback helper types and infers AbortError', () => {
    const cleanup: ResultAsyncCallbackCleanup = () => undefined
    const options: ResultAsyncFromCallbackOptions<number, CallbackError> = {
      catch: toCallbackError,
      subscribe: ({ resolve }) => {
        resolve(1)
        return cleanup
      },
    }
    const result = ResultAsync.fromCallback(options)

    expectTypeOf(result).toExtend<ResultAsyncType<number, CallbackError | AbortError>>()
  })
})
