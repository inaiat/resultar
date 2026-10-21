import { deepEqual, equal } from 'node:assert/strict'
import { describe, it } from 'vite-plus/test'

import { Retry } from '../src/core/retry.js'
import { Cause } from '../src/task/cause.js'
import { Fiber } from '../src/task/fiber.js'
import type { FiberHandle } from '../src/task/fiber.js'
import { ResultTask } from '../src/task/result-task.js'
import type { Exit } from '../src/task/result-task.js'
import { Semaphore } from '../src/task/semaphore.js'
import { Clock } from '../src/task/task-clock.js'
import { Scheduler } from '../src/task/task-scheduler.js'

describe('fiber stress and concurrency suite', () => {
  it('interrupts a 3-level fiber hierarchy (root -> children -> grandchildren) and runs all async finalizers in strict bottom-up LIFO order', async () => {
    const clock = Clock.virtual()
    const CHILD_COUNT = 5
    const GRANDCHILD_COUNT = 4
    const state = {
      events: [] as string[],
      activeResources: 0,
      activeGrandchildren: 0,
      activeChildren: 0,
      grandchildHandles: [] as FiberHandle<void, never>[],
      childHandles: [] as FiberHandle<void, never>[],
    }

    const makeGrandchild = (childIdx: number, grandIdx: number): ResultTask<void, never> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          const id = `c${childIdx}-g${grandIdx}`
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              state.activeResources += 1
              state.activeGrandchildren += 1
              state.events.push(`acquire:${id}:r1`)
              return `${id}:r1`
            }),
            release: () =>
              ResultTask.sleep(1).andThen(() =>
                ResultTask.sync(() => {
                  state.activeResources -= 1
                  state.activeGrandchildren -= 1
                  state.events.push(`release:${id}:r1`)
                }),
              ),
          })

          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              state.activeResources += 1
              state.events.push(`acquire:${id}:r2`)
              return `${id}:r2`
            }),
            release: () =>
              ResultTask.sync(() => {
                state.activeResources -= 1
                state.events.push(`release:${id}:r2`)
              }),
          })

          return yield* ResultTask.sleep(1000).ensuring(() =>
            ResultTask.sync(() => {
              state.events.push(`ensuring:${id}`)
            }),
          )
        }),
      ).onExit((exit) =>
        ResultTask.sync(() => {
          equal(exit._tag, 'Failure')
          state.events.push(`exit:${childIdx}:${grandIdx}`)
        }),
      )

    const makeChild = (childIdx: number): ResultTask<void, never> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          const id = `c${childIdx}`
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              state.activeResources += 1
              state.activeChildren += 1
              state.events.push(`acquire:${id}:r1`)
              return `${id}:r1`
            }),
            release: () =>
              ResultTask.sleep(2).andThen(() =>
                ResultTask.sync(() => {
                  // All grandchildren of this child must already be finalized before child release finishes
                  equal(state.activeGrandchildren, 0)
                  state.activeResources -= 1
                  state.activeChildren -= 1
                  state.events.push(`release:${id}:r1`)
                }),
              ),
          })

          yield* ResultTask.acquireDisposable(
            ResultTask.sync(() => {
              state.activeResources += 1
              state.events.push(`acquire:${id}:disposable`)
              return {
                [Symbol.dispose]: (): void => {
                  state.activeResources -= 1
                  state.events.push(`release:${id}:disposable`)
                },
              }
            }),
          )

          for (let g = 0; g < GRANDCHILD_COUNT; g += 1) {
            state.grandchildHandles.push(yield* ResultTask.forkChild(makeGrandchild(childIdx, g)))
          }

          return yield* ResultTask.sleep(1000)
        }),
      )

    const rootTask = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            state.activeResources += 1
            state.events.push('acquire:root')
            return 'root'
          }),
          release: () =>
            ResultTask.sleep(1).andThen(() =>
              ResultTask.sync(() => {
                // Both grandchildren and children must be fully released before root release completes
                equal(state.activeGrandchildren, 0)
                equal(state.activeChildren, 0)
                state.activeResources -= 1
                state.events.push('release:root')
              }),
            ),
        })

        for (let c = 0; c < CHILD_COUNT; c += 1) {
          state.childHandles.push(yield* ResultTask.forkChild(makeChild(c)))
        }

        return yield* ResultTask.sleep(1000)
      }),
    )

    const rootFiber = ResultTask.runFork(rootTask, { clock })
    await clock.flush()

    // 1 root + 5 children * 2 + 20 grandchildren * 2 = 51 resources active
    equal(state.childHandles.length, CHILD_COUNT)
    equal(state.grandchildHandles.length, CHILD_COUNT * GRANDCHILD_COUNT)
    equal(state.activeResources, 1 + CHILD_COUNT * 2 + CHILD_COUNT * GRANDCHILD_COUNT * 2)
    equal(state.activeChildren, CHILD_COUNT)
    equal(state.activeGrandchildren, CHILD_COUNT * GRANDCHILD_COUNT)
    equal(rootFiber.poll(), undefined)

    // Trigger interruption of the entire tree from the root fiber
    const interruptionPromise = ResultTask.runPromise(Fiber.interrupt(rootFiber, 'kill-tree'), {
      clock,
    })

    // Advance virtual clock through grandchild sleep(1), child sleep(2), and root sleep(1)
    await clock.advanceBy(1)
    equal(state.activeGrandchildren, 0)
    await clock.advanceBy(2)
    equal(state.activeChildren, 0)
    equal(rootFiber.poll(), undefined)
    await clock.advanceBy(1)

    deepEqual(await interruptionPromise, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'kill-tree' },
    })
    equal(
      state.activeResources === 0 && clock.pending === 0 && state.events.at(-1) === 'release:root',
      true,
    )

    // Every child and grandchild fiber must now report a finalized Interrupt exit and LIFO order
    for (const handle of [...state.childHandles, ...state.grandchildHandles]) {
      const polled = handle.poll()
      equal(polled?._tag === 'Failure' && Cause.hasInterrupts(polled.cause), true)
    }

    for (let c = 0; c < CHILD_COUNT; c += 1) {
      const dispRelease = state.events.indexOf(`release:c${c}:disposable`)
      const r1Release = state.events.indexOf(`release:c${c}:r1`)
      equal(dispRelease !== -1 && r1Release !== -1 && dispRelease < r1Release, true)

      for (let g = 0; g < GRANDCHILD_COUNT; g += 1) {
        const gR2 = state.events.indexOf(`release:c${c}-g${g}:r2`)
        const gR1 = state.events.indexOf(`release:c${c}-g${g}:r1`)
        equal(gR2 !== -1 && gR1 !== -1 && gR2 < gR1 && gR1 < dispRelease, true)
      }
    }
  })

  it('maintains Semaphore invariants and zero resource leaks when killing active and queued fibers under heavy contention', async () => {
    const clock = Clock.virtual()
    const MAX_PERMITS = 4
    const TOTAL_FIBERS = 60
    const semaphore = Semaphore.make(MAX_PERMITS)

    const stats = {
      inFlightPermits: 0,
      maxObservedPermits: 0,
      activeResources: 0,
      completedCount: 0,
      interruptedCount: 0,
    }

    const makeWorker = (i: number): ResultTask<number, never> => {
      // Mix 1-permit, 2-permit, and 3-permit tasks to stress queue draining when blockers are killed
      let neededPermits = 1
      if (i % 7 === 0) {
        neededPermits = 3
      } else if (i % 3 === 0) {
        neededPermits = 2
      }

      return semaphore.withPermits(
        neededPermits,
        ResultTask.scoped(
          ResultTask.gen(function* () {
            yield* ResultTask.acquireRelease({
              acquire: ResultTask.sync(() => {
                stats.inFlightPermits += neededPermits
                stats.activeResources += 1
                if (stats.inFlightPermits > stats.maxObservedPermits) {
                  stats.maxObservedPermits = stats.inFlightPermits
                }
                equal(stats.inFlightPermits <= MAX_PERMITS, true)
                return i
              }),
              release: () =>
                ResultTask.sync(() => {
                  stats.inFlightPermits -= neededPermits
                  stats.activeResources -= 1
                  equal(stats.inFlightPermits >= 0, true)
                }),
            })

            yield* ResultTask.sleep(5)
            stats.completedCount += 1
            return i
          }),
        ),
      )
    }

    const program = ResultTask.scoped(
      ResultTask.gen(function* () {
        const fibers: FiberHandle<number, never>[] = []

        for (let i = 0; i < TOTAL_FIBERS; i += 1) {
          const fiber = yield* ResultTask.forkChild(makeWorker(i))
          fibers.push(fiber)
        }

        // Let the first batch acquire permits and the remaining fibers queue up
        yield* ResultTask.sleep(1)
        equal(semaphore.available() < MAX_PERMITS, true)

        // Kill every even-indexed fiber (includes both currently running permit holders and queued waiters)
        const killTasks: ResultTask<Exit<number, never>, never>[] = []
        for (const [i, fiber] of fibers.entries()) {
          if (i % 2 === 0) {
            killTasks.push(Fiber.interrupt(fiber, `killed-${i}`))
          }
        }
        const killedExits = yield* ResultTask.all(killTasks, { concurrency: 'unbounded' })
        for (const exit of killedExits) {
          equal(exit._tag, 'Failure')
          if (exit._tag === 'Failure') {
            equal(Cause.hasInterrupts(exit.cause), true)
            stats.interruptedCount += 1
          }
        }

        // Join all odd-indexed surviving fibers
        const survivors = fibers.filter((_, index) => index % 2 === 1)
        return yield* ResultTask.all(
          survivors.map((fiber) => Fiber.join(fiber)),
          { concurrency: 'unbounded' },
        )
      }),
    )

    const mainFiber = ResultTask.runFork(program, { clock })
    await clock.advanceBy(1000)
    const mainExit = await ResultTask.runPromise(Fiber.await(mainFiber), { clock })

    equal(mainExit._tag, 'Success')
    if (mainExit._tag === 'Success') {
      equal(mainExit.value.length, TOTAL_FIBERS / 2)
    }

    equal(stats.interruptedCount, TOTAL_FIBERS / 2)
    equal(stats.completedCount, TOTAL_FIBERS / 2)
    equal(stats.maxObservedPermits <= MAX_PERMITS, true)
    equal(stats.maxObservedPermits > 0, true)
    equal(stats.inFlightPermits, 0)
    equal(stats.activeResources, 0)
    equal(semaphore.available(), MAX_PERMITS)
    equal(clock.pending, 0)
  })

  it('handles concurrent wait/detach joiners, awaiters, observers, and simultaneous interrupters on a shared fiber', async () => {
    const clock = Clock.virtual()
    const owner = ResultTask.makeScope()
    const state = {
      acquireCount: 0,
      releaseCount: 0,
      bodyCompleted: false,
      succeedingFinalized: false,
      observerExits: [] as Exit<string, never>[],
    }

    const sharedFiber = await ResultTask.runPromise(
      owner.use(
        ResultTask.forkChild(
          ResultTask.gen(function* () {
            yield* ResultTask.acquireRelease({
              acquire: ResultTask.sync(() => {
                state.acquireCount += 1
                return 'shared-resource'
              }),
              release: () =>
                ResultTask.sleep(4).andThen(() =>
                  ResultTask.sync(() => {
                    state.releaseCount += 1
                  }),
                ),
            })
            yield* ResultTask.sleep(20)
            state.bodyCompleted = true
            return 'done'
          }),
        ),
      ),
      { clock },
    )
    for (let i = 0; i < 15; i += 1) {
      sharedFiber.addObserver((exit) => {
        state.observerExits.push(exit)
      })
    }

    // Spawn 10 detach joiners, 10 wait joiners, and 10 awaiters
    const detachJoiners = Array.from({ length: 10 }, () =>
      ResultTask.runFork(Fiber.join(sharedFiber, { interruption: 'detach' }), { clock }),
    )
    const waitJoiners = Array.from({ length: 10 }, () =>
      ResultTask.runFork(Fiber.join(sharedFiber, { interruption: 'wait' }), { clock }),
    )
    const awaiters = Array.from({ length: 10 }, () =>
      ResultTask.runFork(Fiber.await(sharedFiber), { clock }),
    )

    await clock.flush()
    equal(state.acquireCount === 1 && state.releaseCount === 0, true)

    // Interrupt 5 detach joiners early: they must exit immediately without interrupting sharedFiber
    for (const [i, joiner] of detachJoiners.slice(0, 5).entries()) {
      deepEqual(
        await ResultTask.runPromise(Fiber.interrupt(joiner, `detach-cancel-${i}`), { clock }),
        { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: `detach-cancel-${i}` } },
      )
    }

    // Start interrupting 5 wait joiners: they must wait for sharedFiber to finish, NOT kill sharedFiber
    const waitInterruptions = waitJoiners
      .slice(0, 5)
      .map((joiner, i) =>
        ResultTask.runPromise(Fiber.interrupt(joiner, `wait-cancel-${i}`), { clock }),
      )
    await clock.advanceBy(2)
    equal(sharedFiber.poll() === undefined && state.releaseCount === 0, true)

    // Fire 8 concurrent Fiber.interrupt calls against sharedFiber itself (4ms finalizer)
    const concurrentKills = Array.from({ length: 8 }, (_, i) =>
      ResultTask.runPromise(Fiber.interrupt(sharedFiber, `kill-shared-${i}`), { clock }),
    )
    await clock.advanceBy(2)
    equal(sharedFiber.poll() === undefined && state.releaseCount === 0, true)

    await clock.advanceBy(2)
    const killExits = await Promise.all(concurrentKills)
    const waitInterruptedExits = await Promise.all(waitInterruptions)
    equal(
      state.acquireCount === 1 &&
        state.releaseCount === 1 &&
        !state.bodyCompleted &&
        state.observerExits.length === 15,
      true,
    )

    for (const exit of [
      ...killExits,
      ...waitInterruptedExits,
      ...(await Promise.all(
        [...detachJoiners.slice(5), ...waitJoiners.slice(5)].map((joiner) =>
          ResultTask.runExit(Fiber.join(joiner), { clock }),
        ),
      )),
      ...(await Promise.all(
        awaiters.map((awaiter) => ResultTask.runPromise(Fiber.join(awaiter), { clock })),
      )),
    ]) {
      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'kill-shared-0' } })
    }

    // Also verify a wait joiner interrupted while waiting on a fiber that later succeeds
    const succeedingFiber = await ResultTask.runPromise(
      owner.use(
        ResultTask.forkChild(
          ResultTask.sleep(5)
            .as('ok-after-5')
            .ensuring(() =>
              ResultTask.sync(() => {
                state.succeedingFinalized = true
              }),
            ),
        ),
      ),
      { clock },
    )
    const waitOnSuccess = ResultTask.runFork(
      Fiber.join(succeedingFiber, { interruption: 'wait' }),
      { clock },
    )
    await clock.flush()
    const waitOnSuccessInterrupted = ResultTask.runPromise(
      Fiber.interrupt(waitOnSuccess, 'wait-on-success-cancel'),
      { clock },
    )
    await clock.advanceBy(5)
    deepEqual(await waitOnSuccessInterrupted, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'wait-on-success-cancel' },
    })
    deepEqual(await ResultTask.runExit(owner.close(), { clock }), {
      _tag: 'Success',
      value: undefined,
    })
    equal(state.succeedingFinalized && clock.pending === 0, true)
  })

  it('cancels all losing branches and their nested forked child fibers in N-way race and bounded forEach', async () => {
    const clock = Clock.virtual()
    const counters = { activeResources: 0, activeSubFibers: 0, startedItems: 0 }

    const makeSubFiberTask = (label: string): ResultTask<void, never> =>
      ResultTask.scoped(
        ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            counters.activeResources += 1
            counters.activeSubFibers += 1
            return label
          }),
          release: () =>
            ResultTask.sleep(1).andThen(() =>
              ResultTask.sync(() => {
                counters.activeResources -= 1
                counters.activeSubFibers -= 1
              }),
            ),
        }).andThen(() => ResultTask.sleep(1000)),
      )

    const makeRaceBranch = (branchIdx: number): ResultTask<string, never> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              counters.activeResources += 1
              return `branch-${branchIdx}`
            }),
            release: () =>
              ResultTask.sleep(2).andThen(() =>
                ResultTask.sync(() => {
                  counters.activeResources -= 1
                }),
              ),
          })

          for (let c = 0; c < 3; c += 1) {
            yield* ResultTask.forkChild(makeSubFiberTask(`sub-${branchIdx}-${c}`))
          }

          // Branch 7 wins at 5ms; others take 50ms+
          const delay = branchIdx === 7 ? 5 : 50 + branchIdx
          yield* ResultTask.sleep(delay)
          return `winner-${branchIdx}`
        }),
      )

    // Part 1: 12-way race, each branch spawning 3 child fibers with async finalizers
    let racedAll = makeRaceBranch(0)
    for (let branchIdx = 1; branchIdx < 12; branchIdx += 1) {
      racedAll = ResultTask.race(racedAll, makeRaceBranch(branchIdx))
    }
    const raceFiber = ResultTask.runFork(racedAll, { clock })
    await clock.advanceBy(1000)
    const raceExit = await ResultTask.runPromise(Fiber.await(raceFiber), { clock })

    deepEqual(raceExit, { _tag: 'Success', value: 'winner-7' })
    equal(counters.activeSubFibers, 0)
    equal(counters.activeResources, 0)
    equal(clock.pending, 0)

    // Part 2: bounded forEach (concurrency: 6) over 40 items where item 19 fails while siblings have child fibers
    const items = Array.from({ length: 40 }, (_, i) => i)

    // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
    const forEachTask = ResultTask.forEach(
      items,
      (item) =>
        ResultTask.scoped(
          ResultTask.gen(function* () {
            counters.startedItems += 1
            yield* ResultTask.acquireRelease({
              acquire: ResultTask.sync(() => {
                counters.activeResources += 1
                return item
              }),
              release: () =>
                ResultTask.sleep(1).andThen(() =>
                  ResultTask.sync(() => {
                    counters.activeResources -= 1
                  }),
                ),
            })

            yield* ResultTask.forkChild(makeSubFiberTask(`worker-child-${item}`))

            if (item === 19) {
              yield* ResultTask.sleep(2)
              return yield* ResultTask.err('boom-at-19' as const)
            }

            yield* ResultTask.sleep(10)
            return item
          }),
        ),
      { concurrency: 6 },
    )

    const forEachFiber = ResultTask.runFork(forEachTask, { clock })
    await clock.advanceBy(1000)
    const forEachExit = await ResultTask.runPromise(Fiber.await(forEachFiber), { clock })

    deepEqual(forEachExit, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'boom-at-19' } })
    // Stopped scheduling remaining items once item 19 failed
    equal(counters.startedItems < items.length, true)
    equal(counters.activeSubFibers, 0)
    equal(counters.activeResources, 0)
    equal(clock.pending, 0)
  })

  it('preempts CPU-bound parallel fiber loops via yieldEvery and releases all resources on interruption', async () => {
    const MAX_STEPS = 5000
    const FIBER_COUNT = 8
    const stepCounts = Array.from({ length: FIBER_COUNT }, () => 0)
    const state = { activeResources: 0 }

    const yieldToScheduler = ResultTask.tryPromise((signal) => Scheduler.live.yield(signal)).orElse(
      () => ResultTask.ok(undefined),
    )

    const makeCpuWorker = (index: number): ResultTask<number, never> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              state.activeResources += 1
              return index
            }),
            release: () =>
              ResultTask.sync(() => {
                state.activeResources -= 1
              }),
          })

          return yield* ResultTask.iterate(0, {
            while: (n) => n < MAX_STEPS,
            body: (n) =>
              ResultTask.sync(() => {
                stepCounts[index] = (stepCounts[index] ?? 0) + 1
                return n + 1
              }),
          })
        }),
      )

    const program = ResultTask.scoped(
      ResultTask.gen(function* () {
        const fibers: FiberHandle<number, never>[] = []

        for (let i = 0; i < FIBER_COUNT; i += 1) {
          fibers.push(yield* ResultTask.forkChild(makeCpuWorker(i)))
        }

        // Yield a couple of macrotask turns so all 8 CPU fibers make partial progress, then kill the first 4
        yield* yieldToScheduler
        yield* yieldToScheduler

        for (const [i, fiber] of fibers.slice(0, 4).entries()) {
          const exit = yield* Fiber.interrupt(fiber, `cpu-kill-${i}`)
          equal(exit._tag, 'Failure')
          if (exit._tag === 'Failure') {
            equal(Cause.hasInterrupts(exit.cause), true)
          }
        }

        // Join the remaining 4 CPU fibers and let them finish all 5,000 steps
        return yield* ResultTask.all(
          fibers.slice(4).map((fiber) => Fiber.join(fiber)),
          { concurrency: 'unbounded' },
        )
      }),
    )

    const result = await ResultTask.runPromise(program, { yieldEvery: 10 })
    deepEqual(result, [MAX_STEPS, MAX_STEPS, MAX_STEPS, MAX_STEPS])
    equal(state.activeResources, 0)

    // Killed fibers started (> 0 steps) and were preempted well before MAX_STEPS
    for (const count of stepCounts.slice(0, 4)) {
      equal(count > 0, true)
      equal(count < MAX_STEPS, true)
    }
    for (const count of stepCounts.slice(4)) {
      equal(count, MAX_STEPS)
    }
  })

  it('survives live clock concurrency stress with staggered sleeps, timeouts, semaphore permits, and kills', async () => {
    const PERMITS = 5
    const sem = Semaphore.make(PERMITS)
    const stats = { activeResources: 0, activePermits: 0, maxPermits: 0 }

    const makeLiveWorker = (i: number): ResultTask<string, 'timeout'> =>
      sem
        .withPermit(
          ResultTask.scoped(
            ResultTask.gen(function* () {
              yield* ResultTask.acquireRelease({
                acquire: ResultTask.sync(() => {
                  stats.activeResources += 1
                  stats.activePermits += 1
                  if (stats.activePermits > stats.maxPermits) {
                    stats.maxPermits = stats.activePermits
                  }
                  equal(stats.activePermits <= PERMITS, true)
                  return i
                }),
                release: () =>
                  ResultTask.sync(() => {
                    stats.activePermits -= 1
                    stats.activeResources -= 1
                  }),
              })

              yield* ResultTask.sleep((i % 4) + 1)
              return `ok-${i}`
            }),
          ),
        )
        .timeout(i % 5 === 0 ? 1 : 50, () => 'timeout' as const)

    const program = ResultTask.scoped(
      ResultTask.gen(function* () {
        const handles: FiberHandle<string, 'timeout'>[] = []

        for (let i = 0; i < 36; i += 1) {
          handles.push(yield* ResultTask.forkChild(makeLiveWorker(i)))
        }

        // Wait 2ms on live clock and then kill every 3rd fiber
        yield* ResultTask.sleep(2)
        for (const [i, handle] of handles.entries()) {
          if (i % 3 === 0) {
            yield* Fiber.interrupt(handle, `live-kill-${i}`)
          }
        }

        const exits: Exit<string, 'timeout'>[] = []
        for (const handle of handles) {
          exits.push(yield* Fiber.await(handle))
        }
        return { exits, handles }
      }),
    )

    const { exits, handles } = await ResultTask.runPromise(program, { clock: Clock.live })

    equal(exits.length, 36)
    equal(stats.activeResources, 0)
    equal(stats.activePermits, 0)
    equal(stats.maxPermits <= PERMITS, true)
    equal(sem.available(), PERMITS)

    for (const handle of handles) {
      equal(handle.poll() !== undefined, true)
    }
  })

  it('executes every finalizer and losslessly preserves all failures and defects when parallel children fail, die, and fail during cleanup', async () => {
    const clock = Clock.virtual()
    const stats = { activeResources: 0, executedFinalizers: 0 }

    const CHILD_COUNT = 10

    const makeFaultyChild = (
      i: number,
    ): ResultTask<void, `child-fail-${number}` | `child-release-err-${number}`> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              stats.activeResources += 1
              return `child-${i}-r1`
            }),
            release: () =>
              ResultTask.sleep(1).andThen(() => {
                stats.activeResources -= 1
                stats.executedFinalizers += 1
                if (i === 1 || i === 6) {
                  return ResultTask.err(`child-release-err-${i}` as const)
                }
                if (i === 4) {
                  return ResultTask.sync(() => {
                    throw new Error(`child-release-defect-${i}`)
                  })
                }
                return ResultTask.ok(undefined)
              }),
          })

          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              stats.activeResources += 1
              return `child-${i}-r2`
            }),
            release: () =>
              ResultTask.sync(() => {
                stats.activeResources -= 1
                stats.executedFinalizers += 1
              }),
          })

          if (i === 2 || i === 7) {
            yield* ResultTask.sleep(2)
            return yield* ResultTask.err(`child-fail-${i}` as const)
          }
          if (i === 5) {
            yield* ResultTask.sleep(2)
            return yield* ResultTask.sync(() => {
              throw new Error('child-body-defect-5')
            })
          }

          return yield* ResultTask.sleep(1000)
        }),
      )

    const root = ResultTask.scoped(
      ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            stats.activeResources += 1
            return 'root-res'
          }),
          release: () =>
            ResultTask.sleep(1).andThen(() => {
              stats.activeResources -= 1
              stats.executedFinalizers += 1
              return ResultTask.err('root-release-err' as const)
            }),
        })

        for (let i = 0; i < CHILD_COUNT; i += 1) {
          yield* ResultTask.forkChild(makeFaultyChild(i))
        }

        // Wait 5ms so children 2, 5, 7 fail/die while others are still sleeping, then root itself fails
        yield* ResultTask.sleep(5)
        return yield* ResultTask.err('root-body-err' as const)
      }),
    )

    const rootFiber = ResultTask.runFork(root, { clock })
    await clock.advanceBy(1000)
    const exit = await ResultTask.runPromise(Fiber.await(rootFiber), { clock })

    equal(exit._tag, 'Failure')
    equal(stats.activeResources, 0)
    // 1 root finalizer + 10 children * 2 finalizers = 21 finalizers
    equal(stats.executedFinalizers, 1 + CHILD_COUNT * 2)
    equal(clock.pending, 0)

    if (exit._tag === 'Failure') {
      equal(Cause.isCause(exit.cause), true)
      equal(Cause.hasFails(exit.cause), true)
      equal(Cause.hasDies(exit.cause), true)
      const fails = Cause.failures(exit.cause)
      const defects = Cause.defects(exit.cause)
      equal(fails.includes('root-body-err'), true)
      equal(fails.includes('root-release-err'), true)
      equal(fails.includes('child-fail-2'), true)
      equal(fails.includes('child-fail-7'), true)
      equal(fails.includes('child-release-err-1'), true)
      equal(fails.includes('child-release-err-6'), true)
      equal(defects.length, 2)
    }
  })

  it('isolates per-attempt scopes and child fibers across retry + timeout cycles before external fiber kill', async () => {
    const clock = Clock.virtual()
    const stats = {
      activeAttemptResources: 0,
      maxAttemptResources: 0,
      activeAttemptChildren: 0,
      attemptsStarted: 0,
      attemptsCleanedUp: 0,
    }

    const makeAttemptChild = (c: number): ResultTask<void, never> =>
      ResultTask.scoped(
        ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            stats.activeAttemptChildren += 1
            return c
          }),
          release: () =>
            ResultTask.sleep(1).andThen(() =>
              ResultTask.sync(() => {
                stats.activeAttemptChildren -= 1
              }),
            ),
        }).andThen(() => ResultTask.sleep(1000)),
      )

    const singleAttempt = ResultTask.scoped(
      ResultTask.gen(function* () {
        stats.attemptsStarted += 1
        yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            stats.activeAttemptResources += 1
            if (stats.activeAttemptResources > stats.maxAttemptResources) {
              stats.maxAttemptResources = stats.activeAttemptResources
            }
            // Previous attempt's resources must be 100% released before a new attempt starts
            equal(stats.activeAttemptResources, 1)
            equal(stats.activeAttemptChildren, 0)
            return 'attempt-res'
          }),
          release: () =>
            ResultTask.sleep(2).andThen(() =>
              ResultTask.sync(() => {
                stats.activeAttemptResources -= 1
                stats.attemptsCleanedUp += 1
              }),
            ),
        })

        for (let c = 0; c < 3; c += 1) {
          yield* ResultTask.forkChild(makeAttemptChild(c))
        }

        return yield* ResultTask.sleep(50).as('never-reached')
      }),
    )

    const resilientWorkflow = singleAttempt
      .timeout(5, () => 'attempt-timeout' as const)
      .retry(Retry.policy({ times: 5, delayMs: 4 }))

    const fiber = ResultTask.runFork(resilientWorkflow, { clock })

    // Attempt 1: runs 5ms -> times out -> child release (1ms) + attempt release (2ms) = 8ms + 4ms retry delay = 12ms
    // Attempt 2: +12ms = 24ms
    // At t = 27ms, attempt 3 is 3ms into its 5ms body with all 3 child fibers active
    await clock.advanceBy(27)
    equal(stats.attemptsStarted, 3)
    equal(stats.attemptsCleanedUp, 2)
    equal(stats.activeAttemptResources, 1)
    equal(stats.activeAttemptChildren, 3)

    // Kill the retrying fiber while attempt 3 is actively running (before its 5ms timeout at t = 29ms)
    const killPromise = ResultTask.runPromise(Fiber.interrupt(fiber, 'abort-retry-loop'), { clock })
    await clock.advanceBy(100)
    const killExit = await killPromise

    deepEqual(killExit, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'abort-retry-loop' },
    })
    equal(stats.attemptsStarted, 3)
    equal(stats.attemptsCleanedUp, 3)
    equal(stats.maxAttemptResources, 1)
    equal(stats.activeAttemptResources, 0)
    equal(stats.activeAttemptChildren, 0)
    equal(clock.pending, 0)
  })

  it('maintains observer and AbortSignal hygiene across 200 high-churn fibers with mid-flight cancellations', async () => {
    const clock = Clock.virtual()
    const TOTAL = 200
    const stats = { activeResources: 0, activeObserverCalls: 0, disposedObserverCalls: 0 }

    const makeChurnWorker = (i: number): ResultTask<number, never> =>
      ResultTask.scoped(
        ResultTask.gen(function* () {
          yield* ResultTask.acquireRelease({
            acquire: ResultTask.sync(() => {
              stats.activeResources += 1
              return i
            }),
            release: () =>
              ResultTask.sleep(1).andThen(() =>
                ResultTask.sync(() => {
                  stats.activeResources -= 1
                }),
              ),
          })

          yield* ResultTask.sleep((i % 10) + 2)
          return i
        }),
      )

    const entries = Array.from({ length: TOTAL }, (_, i) => {
      const controller = new AbortController()
      const handle = ResultTask.runFork(makeChurnWorker(i), { clock, signal: controller.signal })

      // Register two observers and immediately dispose the first one
      const removeDisposed = handle.addObserver(() => {
        stats.disposedObserverCalls += 1
      })
      removeDisposed()

      handle.addObserver(() => {
        stats.activeObserverCalls += 1
      })

      return { index: i, controller, handle }
    })

    await clock.advanceBy(1)
    equal(stats.activeResources, TOTAL)

    // Abort 1/3 via external AbortController, 1/3 via Fiber.interrupt, and let 1/3 complete naturally
    const interruptPromises: Promise<Exit<number, never>>[] = []
    for (const { index, controller, handle } of entries) {
      if (index % 3 === 0) {
        controller.abort(`signal-abort-${index}`)
      } else if (index % 3 === 1) {
        interruptPromises.push(
          ResultTask.runPromise(Fiber.interrupt(handle, `fiber-kill-${index}`), { clock }),
        )
      }
    }

    await clock.advanceBy(100)
    await Promise.all(interruptPromises)

    let successCount = 0
    let interruptCount = 0
    for (const { index, handle } of entries) {
      const exit = await ResultTask.runPromise(Fiber.await(handle), { clock })
      if (index % 3 === 2) {
        deepEqual(exit, { _tag: 'Success', value: index })
        successCount += 1
      } else {
        equal(exit._tag, 'Failure')
        if (exit._tag === 'Failure') {
          equal(Cause.hasInterrupts(exit.cause), true)
          interruptCount += 1
        }
      }
    }

    equal(successCount + interruptCount, TOTAL)
    equal(stats.activeResources, 0)
    equal(stats.disposedObserverCalls, 0)
    equal(stats.activeObserverCalls, TOTAL)
    equal(clock.pending, 0)
  })
})
