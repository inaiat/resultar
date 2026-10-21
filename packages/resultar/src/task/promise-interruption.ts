import type { Exit } from './result-task.js'
import { died, failed, interrupted, NEVER_ABORTED_SIGNAL, success } from './exit.js'

export { NEVER_ABORTED_SIGNAL } from './exit.js'

export const detachedPromise = <A, E>(
  signal: AbortSignal,
  run: () => PromiseLike<A>,
  mapError: (error: unknown) => E,
): Promise<Exit<A, E>> =>
  new Promise((resolve) => {
    let settled = false
    const trackSignal = signal !== NEVER_ABORTED_SIGNAL
    const finish = (exit: Exit<A, E>): void => {
      if (settled) return
      settled = true
      if (trackSignal) {
        signal.removeEventListener('abort', onAbort)
      }
      resolve(exit)
    }
    const onAbort = (): void => {
      finish(interrupted(signal))
    }
    const onFailure = (cause: unknown): void => {
      if (settled) return
      if (signal.aborted) {
        onAbort()
        return
      }
      try {
        finish(failed(mapError(cause)))
      } catch (error) {
        finish(died(error))
      }
    }
    if (trackSignal) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
    }
    try {
      const thenable = run()
      if (thenable instanceof Promise && !Object.hasOwn(thenable, 'then')) {
        thenable.then((value) => {
          finish(success(value))
        }, onFailure)
        return
      }
      // Native await safely adopts thenables and ignores poisoned own Promise.then properties.
      // Both handlers stay attached after interruption, consuming late rejection as well.
      void (async (): Promise<A> => {
        const value = await (thenable as PromiseLike<A>)
        return value
      })().then((value) => {
        finish(success(value))
      }, onFailure)
    } catch (error) {
      onFailure(error)
    }
  })
