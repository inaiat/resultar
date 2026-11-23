import type { Exit, ResultTaskRunOptions } from './result-task.js'
import { NEVER_ABORTED_SIGNAL } from './exit.js'
import { hasScheduledTasks, scheduleMacrotask } from './task-scheduler.js'

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
    if (signal === NEVER_ABORTED_SIGNAL) {
      start(resolve)
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
  readonly owner: TaskClock | undefined
  readonly wake: () => void
}

const drainScheduled = (clock: TaskClock, peers?: ReadonlySet<TaskClock>): Promise<void> =>
  new Promise<void>((resolve) => {
    const drained = (): void => {
      if (hasScheduledTasks(clock) || peers?.values().some(hasScheduledTasks) === true)
        scheduleMacrotask(drained)
      else resolve()
    }
    scheduleMacrotask(drained)
  })

/**
 * Deterministic virtual clock for testing time-dependent `ResultTask` workflows without wall-clock timers.
 *
 * @example
 * ```ts
 * import { Clock, ResultTask } from 'resultar'
 *
 * const clock = Clock.virtual()
 * const running = ResultTask.sleep(5_000).map(() => clock.now()).runPromise({ clock })
 * await clock.advanceBy(5_000)
 * const elapsed = await running // 5000
 * ```
 */
export class VirtualClock implements TaskClock {
  private time: number
  private readonly activeOwners = new Set<TaskClock>()
  private readonly sleepers = new Set<Sleeper>()
  private readonly waiters = new Set<() => void>()
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
    this.registerSleep(milliseconds, signal)

  private readonly registerSleep = (
    milliseconds: number,
    signal: AbortSignal,
    owner?: TaskClock,
  ): Promise<void> =>
    runSleep(milliseconds, signal, (complete) => {
      const sleeper: Sleeper = {
        at: this.time + milliseconds,
        owner,
        wake: () => {
          this.sleepers.delete(sleeper)
          complete()
        },
      }
      this.sleepers.add(sleeper)
      this.notifyWaiters()
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
    this.flushing ??= drainScheduled(this, this.activeOwners).finally(() => {
      this.flushing = undefined
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

  /**
   * Advances virtual time directly to the earliest pending sleeper deadline, waking all sleepers
   * due at that instant. Returns `true` if a sleeper was woken or `false` if none are pending.
   */
  public advanceToNext(): Promise<boolean> {
    return this.queueStep()
  }

  private queueStep(owner?: TaskClock): Promise<boolean> {
    const advancing = this.advancing.then(() => this.stepNext(owner))
    this.advancing = advancing.then(
      () => undefined,
      () => undefined,
    )
    return advancing
  }

  /**
   * Runs `task` with this virtual clock and automatically advances through scheduled sleeps until
   * it settles, resuming automatically when new virtual sleeps are scheduled after external async
   * work. Guards against infinite timer loops via `maxSteps`, interrupting the task and awaiting
   * its cleanup if the limit is exceeded.
   */
  public async runToCompletion<A, E, R = never>(
    task: {
      readonly runExit: (
        options: ResultTaskRunOptions<R> & {
          readonly clock: TaskClock
          readonly signal: AbortSignal
        },
      ) => Promise<Exit<A, E>>
    },
    ...args: [ResultTaskRunOptions<R>] extends [{ readonly services: unknown }]
      ? [
          options: ResultTaskRunOptions<R> & {
            readonly maxSteps?: number
            readonly maxCleanupSteps?: number
          },
        ]
      : [
          options?: ResultTaskRunOptions<R> & {
            readonly maxSteps?: number
            readonly maxCleanupSteps?: number
          },
        ]
  ): Promise<Exit<A, E>> {
    const options = args[0]
    const maxSteps = options?.maxSteps ?? 10_000
    const maxCleanupSteps = options?.maxCleanupSteps ?? 100_000
    if (!Number.isSafeInteger(maxCleanupSteps) || maxCleanupSteps < 0)
      throw new RangeError('VirtualClock maxCleanupSteps must be a non-negative safe integer')
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) {
      throw new RangeError(
        'VirtualClock.runToCompletion maxSteps must be a non-negative safe integer',
      )
    }
    const controller = new AbortController()
    let settled = false
    const cleanup = new AbortController()
    const owner: TaskClock = {
      now: this.now,
      random: this.random,
      sleep: (ms, signal) =>
        this.registerSleep(ms, AbortSignal.any([signal, cleanup.signal]), owner),
    }
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal])
    const pending = task
      .runExit(
        Object.assign(Object.create(null) as ResultTaskRunOptions<R>, options, {
          clock: owner,
          signal,
        }),
      )
      .finally(() => {
        this.activeOwners.delete(owner)
        settled = true
        this.notifyWaiters()
      })
    this.activeOwners.add(owner)
    void pending.catch(() => undefined)
    const isSettled = (): boolean => settled
    const limitError = await this.driveUntilSettled(isSettled, maxSteps, owner)
    if (limitError !== undefined) {
      controller.abort(limitError)
      const cleanupError = await this.driveUntilSettled(isSettled, maxCleanupSteps, owner)
      if (cleanupError !== undefined) {
        this.activeOwners.delete(owner)
        cleanup.abort(cleanupError)
        throw cleanupError
      }
      await pending.catch(() => undefined)
      await drainScheduled(owner)
      throw limitError
    }
    return pending
  }

  private async driveUntilSettled(
    isSettled: () => boolean,
    maxSteps: number,
    owner: TaskClock,
  ): Promise<RangeError | undefined> {
    await drainScheduled(owner)
    let steps = 0
    for (;;) {
      if (isSettled()) return undefined
      if (this.nextDeadline(owner) === undefined) {
        // eslint-disable-next-line no-await-in-loop
        await this.waitForSleeperOrSettled(isSettled, owner)
        if (!isSettled()) {
          // eslint-disable-next-line no-await-in-loop
          await drainScheduled(owner)
        }
      } else {
        if (steps >= maxSteps) {
          return new RangeError(
            `VirtualClock.runToCompletion exceeded ${maxSteps} virtual clock steps`,
          )
        }
        // eslint-disable-next-line no-await-in-loop
        const advanced = await this.queueStep(owner)
        if (advanced) steps += 1
      }
    }
  }

  private notifyWaiters(): void {
    if (this.waiters.size === 0) return
    for (const wake of this.waiters) {
      this.waiters.delete(wake)
      wake()
    }
  }

  private waitForSleeperOrSettled(isSettled: () => boolean, owner: TaskClock): Promise<void> {
    if (isSettled() || this.nextDeadline(owner) !== undefined) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.add(resolve)
    })
  }

  private async stepNext(owner?: TaskClock): Promise<boolean> {
    await drainScheduled(owner ?? this, this.activeOwners)
    const next = this.nextDeadline(owner)
    if (next === undefined) return false
    // A peer drives its own timers and step budget. Let it finish the earlier deadline first.
    if (owner !== undefined && this.activeOwners.size > 1 && this.nextDeadline() !== next)
      return false
    this.time = Math.max(this.time, next)
    for (const sleeper of this.sleepers) {
      if (sleeper.at <= this.time && this.canDrive(sleeper, owner)) sleeper.wake()
    }
    await drainScheduled(owner ?? this, this.activeOwners)
    return true
  }

  private async advance(milliseconds: number): Promise<void> {
    const target = this.time + milliseconds
    duration(target)
    await this.flush()
    let next = this.nextDeadline()
    let stagnantSteps = 0
    while (next !== undefined && next <= target) {
      stagnantSteps = next <= this.time ? stagnantSteps + 1 : 0
      if (stagnantSteps > 100_000)
        throw new RangeError('VirtualClock.advanceBy exceeded zero-duration step limit')
      this.time = Math.max(this.time, next)
      for (const sleeper of this.sleepers) {
        if (sleeper.at <= this.time) sleeper.wake()
      }
      // eslint-disable-next-line no-await-in-loop
      await this.flush()
      next = this.nextDeadline()
    }
    this.time = Math.max(this.time, target)
    await this.flush()
  }

  private canDrive(sleeper: Sleeper, owner?: TaskClock): boolean {
    return (
      owner === undefined ||
      sleeper.owner === undefined ||
      sleeper.owner === owner ||
      !this.activeOwners.has(sleeper.owner)
    )
  }

  private nextDeadline(owner?: TaskClock): number | undefined {
    let next: number | undefined = undefined
    for (const sleeper of this.sleepers) {
      if (this.canDrive(sleeper, owner) && (next === undefined || sleeper.at < next))
        next = sleeper.at
    }
    return next
  }
}

/**
 * Clock factories for `ResultTask` run options (`runResult`, `runExit`, `runPromise`, `runFork`).
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
