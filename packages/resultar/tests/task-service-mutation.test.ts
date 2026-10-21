import { describe, expect, it } from 'vite-plus/test'

import { TaskScope } from '../src/task/scope.js'
import { Clock } from '../src/task/task-clock.js'
import {
  Scheduler,
  createScheduling,
  hasScheduledTasks,
  schedulerCheckpoint,
} from '../src/task/task-scheduler.js'
import { normalizeRuntimeContext } from '../src/task/task-service.js'
import type { ResultTaskRuntimeContext } from '../src/task/task-service.js'

type ContextWithoutTime = Omit<ResultTaskRuntimeContext, 'clock' | 'scheduling'>
type LegacyContext = ContextWithoutTime &
  Partial<Pick<ResultTaskRuntimeContext, 'clock' | 'scheduling'>>

const contextWithoutTime = (): ContextWithoutTime => ({
  namedServices: new Map(),
  services: new Map(),
  serviceResolver: undefined,
  signal: new AbortController().signal,
  scope: new TaskScope(),
  cleanup: undefined,
})

// Older internal executors can omit the time policies despite the current context type.
const normalizeLegacyContext = (context: LegacyContext): ResultTaskRuntimeContext =>
  normalizeRuntimeContext(context as ResultTaskRuntimeContext)

describe('runtime context time policies', () => {
  it('preserves supplied time policies and the consumed budget of a complete context', () => {
    const clock = Clock.virtual(100)
    const scheduling = createScheduling(clock, { yieldEvery: 7 })
    scheduling.remaining = 3
    const context: ResultTaskRuntimeContext = Object.assign(contextWithoutTime(), {
      clock,
      scheduling,
    })

    const normalized = normalizeRuntimeContext(context)

    expect(normalized).toBe(context)
    expect(normalized.clock).toBe(clock)
    expect(normalized.scheduling).toBe(scheduling)
    expect(normalized.scheduling.remaining).toBe(3)
  })

  it('supplies live time and independent scheduling budgets when both policies are absent', async () => {
    const context = contextWithoutTime()
    const first = normalizeLegacyContext(context)
    const second = normalizeLegacyContext(context)

    expect(first.clock).toBe(Clock.live)
    expect(first.scheduling.clock).toBe(Clock.live)
    expect(first.scheduling.scheduler).toBe(Scheduler.live)
    expect(first.scheduling).not.toBe(second.scheduling)
    const untouchedBudget = second.scheduling.remaining
    await schedulerCheckpoint(first.scheduling, context.signal)
    expect(second.scheduling.remaining).toBe(untouchedBudget)
    expect(first.scheduling.remaining).toBe(untouchedBudget - 1)
  })

  it('associates default scheduling with the supplied virtual clock', async () => {
    const clock = Clock.virtual(250)
    const context = Object.assign(contextWithoutTime(), { clock })
    const normalized = normalizeLegacyContext(context)

    expect(normalized.clock).toBe(clock)
    expect(normalized.clock.now()).toBe(250)
    normalized.scheduling.remaining = 1
    const yielding = schedulerCheckpoint(normalized.scheduling, context.signal)

    expect(hasScheduledTasks(clock)).toBe(true)
    await yielding
    expect(hasScheduledTasks(clock)).toBe(false)
  })

  it('retains a supplied scheduler and its budget while filling in the missing clock', async () => {
    const signals: AbortSignal[] = []
    const scheduling = createScheduling(Clock.virtual(), {
      scheduler: {
        yield: async (signal) => {
          signals.push(signal)
        },
      },
      yieldEvery: 7,
    })
    scheduling.remaining = 1
    const context = Object.assign(contextWithoutTime(), { scheduling })
    const normalized = normalizeLegacyContext(context)

    expect(normalized.clock).toBe(Clock.live)
    expect(normalized.scheduling).toBe(scheduling)
    await schedulerCheckpoint(normalized.scheduling, context.signal)
    expect(signals).toEqual([context.signal])
    expect(scheduling.remaining).toBe(7)
  })
})
