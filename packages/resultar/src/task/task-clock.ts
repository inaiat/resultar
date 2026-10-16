import { hasScheduledTasks } from './task-scheduler.js'

/**
 * Clock and randomness source used by `ResultTask` sleeps, delays, timeouts, `timed`, and retry jitter.
 * By default, `ResultTask` executions use {@link Clock.live}.
 */
export interface TaskClock {
  /** Returns the current monotonic timestamp in milliseconds. */
  readonly now: () => number
  /** Suspends until `milliseconds` have elapsed on this clock or `signal` aborts. */
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Returns a pseudo-random number in `[0, 1]` used for retry jitter calculations. */
  readonly random: () => number
}

const duration = (milliseconds: number): void => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new RangeError('Task duration must be a finite non-negative number')
}

const runSleep = (
  milliseconds: number,
  signal: AbortSignal,
  start: (complete: () => void) => () => void,
): Promise<void> => {
  duration(milliseconds)
  return new Promise((resolve, reject) => {
    const rejectAbort = (): void => {
      reject(new AbortError('Task sleep interrupted', { cause: signal.reason }))
    }
    if (signal.aborted) {
      rejectAbort()
      return
    }
    const cancel = start(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    const onAbort = (): void => {
      cancel()
      signal.removeEventListener('abort', onAbort)
      rejectAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const live: TaskClock = Object.freeze({
  now: () => performance.now(),
  random: () => Math.random(),
  sleep: (milliseconds: number, signal: AbortSignal): Promise<void> =>
    runSleep(milliseconds, signal, (complete) => {
      const deadline = performance.now() + milliseconds
      let timer: ReturnType<typeof setTimeout> | undefined = undefined
      const schedule = (): void => {
        const remaining = deadline - performance.now()
        timer = setTimeout(
          () => {
            if (performance.now() < deadline) schedule()
            else complete()
          },
          Math.min(Math.max(0, remaining), 2_147_483_647),
        )
      }
      schedule()
      return () => {
        clearTimeout(timer)
      }
    }),
})

interface Sleeper {
  readonly at: number
  readonly wake: () => void
}

/**
 * Deterministic virtual clock for testing time-dependent `ResultTask` workflows without wall-clock timers.
 *
 * @example
 * ```ts
 * import { Clock, ResultTask } from 'resultar'
 *
 * const clock = Clock.virtual()
 * const running = ResultTask.sleep(5_000).map(() => clock.now()).run({ clock })
 * await clock.advanceBy(5_000)
 * const elapsed = (await running).unwrap() // 5000
 * ```
 */
export class VirtualClock implements TaskClock {
  private time: number
  private readonly sleepers = new Set<Sleeper>()
  private advancing: Promise<void> = Promise.resolve()
  private flushing: Promise<void> | undefined = undefined
  public readonly random: () => number

  public constructor(startTime = 0, random: () => number = () => 0.5) {
    duration(startTime)
    this.time = startTime
    this.random = random
  }

  /** Returns the current virtual time in milliseconds. */
  public readonly now = (): number => this.time

  /** Registers a virtual sleeper that wakes when virtual time reaches `now() + milliseconds` or `signal` aborts. */
  public readonly sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
    runSleep(milliseconds, signal, (complete) => {
      const sleeper: Sleeper = {
        at: this.time + milliseconds,
        wake: () => {
          this.sleepers.delete(sleeper)
          complete()
        },
      }
      this.sleepers.add(sleeper)
      return () => {
        this.sleepers.delete(sleeper)
      }
    })

  /** Number of active sleepers currently waiting on this virtual clock. */
  public get pending(): number {
    return this.sleepers.size
  }

  /** Drains queued task continuations so newly reached sleeps register before virtual time advances. */
  public flush(): Promise<void> {
    this.flushing ??= new Promise<void>((resolve) => {
      const drained = (): void => {
        if (hasScheduledTasks(this)) {
          setImmediate(drained)
          return
        }
        this.flushing = undefined
        resolve()
      }
      setImmediate(drained)
    })
    return this.flushing
  }

  /** Advances virtual time by `milliseconds`, waking due sleepers in deadline order and flushing cascaded sleeps. */
  public advanceBy(milliseconds: number): Promise<void> {
    duration(milliseconds)
    const advancing = this.advancing.then(() => this.advance(milliseconds))
    this.advancing = advancing.catch(() => undefined)
    return advancing
  }

  private async advance(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds
    duration(target)
    await this.flush()
    let next = this.nextDeadline()
    while (next !== undefined && next <= target) {
      this.time = next
      for (const sleeper of this.sleepers) {
        if (sleeper.at <= this.time) sleeper.wake()
      }
      // eslint-disable-next-line no-await-in-loop
      await this.flush()
      next = this.nextDeadline()
    }
    this.time = target
    await this.flush()
  }

  private nextDeadline(): number | undefined {
    let next: number | undefined = undefined
    for (const sleeper of this.sleepers) {
      if (next === undefined || sleeper.at < next) next = sleeper.at
    }
    return next
  }
}

/**
 * Clock factories for `ResultTask` run options (`run`, `runExit`, `runPromise`, `runFork`).
 *
 * @example
 * ```ts
 * import { Clock, ResultTask } from 'resultar'
 *
 * const clock = Clock.virtual(1_000)
 * const fiber = ResultTask.sleep(250).runFork({ clock })
 * await clock.advanceBy(250)
 * const exit = await fiber.join().runExit()
 * ```
 */
export const Clock: {
  /** Wall-clock implementation backed by `performance.now()`, `setTimeout`, and `Math.random()`. */
  readonly live: TaskClock
  /** Creates a deterministic {@link VirtualClock} starting at `startTime` (default `0`). */
  readonly virtual: (startTime?: number, random?: () => number) => VirtualClock
} = Object.freeze({ live, virtual: (startTime, random) => new VirtualClock(startTime, random) })
import { AbortError } from '../core/abort-error.js'
