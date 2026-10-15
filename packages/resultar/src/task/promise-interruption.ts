import type { Exit } from './result-task.js'
import { died, failed, interrupted, success } from './exit.js'

export const detachedPromise = <A, E>(
  signal: AbortSignal,
  run: () => PromiseLike<A>,
  mapError: (error: unknown) => E,
): Promise<Exit<A, E>> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (exit: Exit<A, E>): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
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
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    // Native await safely adopts thenables and ignores poisoned own Promise.then properties.
    // Both handlers stay attached after interruption, consuming late rejection as well.
    void (async (): Promise<A> => {
      const value = await run()
      return value
    })().then((value) => {
      finish(success(value))
    }, onFailure)
  })
