import { hasScheduledTasks } from './task-scheduler.js'

/** Time and randomness used by task policies. A run uses the live clock by default. */
export interface TaskClock {
  readonly now: () => number
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly random: () => number
}

const duration = (milliseconds: number): void => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new RangeError('Task duration must be a finite non-negative number')
}

const live: TaskClock = Object.freeze({
  now: () => performance.now(),
  random: () => Math.random(),
  sleep: (milliseconds: number, signal: AbortSignal): Promise<void> => {
    duration(milliseconds)
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError('Task sleep interrupted', { cause: signal.reason }))
        return
      }
      const deadline = performance.now() + milliseconds
      let timer: ReturnType<typeof setTimeout> | undefined = undefined
      const onAbort = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(new AbortError('Task sleep interrupted', { cause: signal.reason }))
      }
      const schedule = (): void => {
        const remaining = deadline - performance.now()
        timer = setTimeout(
          () => {
            if (performance.now() < deadline) schedule()
            else {
              signal.removeEventListener('abort', onAbort)
              resolve()
            }
          },
          Math.min(Math.max(0, remaining), 2_147_483_647),
        )
      }
      schedule()
      signal.addEventListener('abort', onAbort, { once: true })
    })
  },
})

interface Sleeper {
  readonly at: number
  readonly wake: () => void
}

/** A deterministic task clock. Advance it explicitly; no wall-clock timers are created. */
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

  public readonly now = (): number => this.time

  public readonly sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    duration(milliseconds)
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError('Task sleep interrupted', { cause: signal.reason }))
        return
      }
      const sleeper: Sleeper = {
        at: this.time + milliseconds,
        wake: () => {
          this.sleepers.delete(sleeper)
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = (): void => {
        this.sleepers.delete(sleeper)
        signal.removeEventListener('abort', onAbort)
        reject(new AbortError('Task sleep interrupted', { cause: signal.reason }))
      }
      this.sleepers.add(sleeper)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  public get pending(): number {
    return this.sleepers.size
  }

  /** Lets already queued task continuations register their next virtual sleeps. */
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

  /** Wakes due sleepers in deadline order, including sleeps scheduled by awakened work. */
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

/** Clock implementations usable in ResultTask run options. */
export const Clock: {
  readonly live: TaskClock
  readonly virtual: (startTime?: number, random?: () => number) => VirtualClock
} = Object.freeze({ live, virtual: (startTime, random) => new VirtualClock(startTime, random) })
import { AbortError } from '../core/abort-error.js'
