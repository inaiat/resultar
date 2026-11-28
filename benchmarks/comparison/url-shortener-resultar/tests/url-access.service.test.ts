import { setTimeout } from 'node:timers/promises'
import { ResultTask } from 'resultar'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  createUrlAccessQueueModule,
  startUrlAccessWorker,
} from '../src/infrastructure/queue/url-access.service.js'

const state = vi.hoisted(() => ({
  createQueue: vi.fn(),
  createWorker: vi.fn(),
  add: vi.fn(),
  run: vi.fn(),
  waitUntilReady: vi.fn(),
  closeQueue: vi.fn(),
  closeWorker: vi.fn(),
  disconnect: vi.fn(),
  workerListeners: new Map<string, (...args: unknown[]) => void>(),
  processor: undefined as
    | undefined
    | ((job: { data: { urlId: string; accessedAt: string } }) => Promise<undefined>),
}))
vi.mock('ioredis', () => ({
  Redis: class {
    disconnect = state.disconnect
    on = vi.fn()
  },
}))
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) {
      state.createQueue(name)
    }
    add = state.add
    close = state.closeQueue
    on = vi.fn()
  },
  Worker: class {
    constructor(name: string, processor: NonNullable<typeof state.processor>) {
      state.createWorker(name)
      state.processor = processor
    }
    waitUntilReady = state.waitUntilReady
    run = state.run
    close = state.closeWorker
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      state.workerListeners.set(event, listener)
    })
  },
}))
describe('URL access queue resources', () => {
  const options = { url: 'redis://localhost:6379', concurrency: 4 }
  const logger = { error: vi.fn<() => void>() }

  beforeEach(() => {
    vi.clearAllMocks()
    state.workerListeners.clear()
    state.add.mockResolvedValue({ id: 'job-1' })
    state.waitUntilReady.mockResolvedValue(undefined)
    state.run.mockResolvedValue(undefined)
  })
  it('enqueues, processes access increments and closes owned resources', async () => {
    const persist = vi.fn(() => ResultTask.ok(undefined))
    const scope = createUrlAccessQueueModule(options, logger, persist).scope()
    try {
      await scope
        .useSingletons(['urlAccessRecorder'], ({ urlAccessRecorder }) =>
          urlAccessRecorder.recordAccess('url-42', new Date('2026-01-01')),
        )
        .runPromise()
      expect(state.createQueue).toHaveBeenCalledExactlyOnceWith('url-shortener-resultar-jobs')
      expect(state.createWorker).toHaveBeenCalledExactlyOnceWith('url-shortener-resultar-jobs')
      expect(state.add).toHaveBeenCalledWith('update-access-count', {
        urlId: 'url-42',
        accessedAt: '2026-01-01T00:00:00.000Z',
      })
      await state.processor?.({ data: { urlId: 'url-42', accessedAt: '2026-01-01T00:00:00.000Z' } })
      expect(persist).toHaveBeenCalledWith('url-42', new Date('2026-01-01'))
      await scope.useSingletons([], () => startUrlAccessWorker(logger)).runPromise()
      await setTimeout(0)
      expect(state.run).toHaveBeenCalledOnce()
      state.add.mockRejectedValueOnce(new Error('Redis unavailable'))
      const failed = await scope
        .useSingletons(['urlAccessRecorder'], ({ urlAccessRecorder }) =>
          urlAccessRecorder.recordAccess('url-99', new Date()),
        )
        .runResult()
      expect(failed.isErr() && failed.error.message).toContain('url-99')
    } finally {
      await scope.close().runPromise()
    }
    expect(state.closeWorker).toHaveBeenCalledExactlyOnceWith()
    expect(state.closeQueue).toHaveBeenCalledOnce()
    expect(state.disconnect).toHaveBeenCalledOnce()
    expect(state.closeWorker).toHaveBeenCalledBefore(state.closeQueue)
    expect(state.closeQueue).toHaveBeenCalledBefore(state.disconnect)
  })

  it('waits for active jobs before closing the queue and disconnecting Redis', async () => {
    const gate: { release?: () => void } = {}
    const writePending = new Promise<undefined>((resolve) => {
      gate.release = () => {
        resolve(undefined)
      }
    })
    let activeJob: Promise<undefined> | undefined = undefined
    state.closeWorker.mockImplementationOnce(async (force?: boolean) => {
      if (force === true) {
        return
      }
      await activeJob
    })

    const scope = createUrlAccessQueueModule(options, logger, () =>
      ResultTask.fromPromise(() => writePending),
    ).scope()
    await scope.useSingletons(['urlAccessRecorder'], () => ResultTask.ok(undefined)).runPromise()

    activeJob = state.processor?.({
      data: { urlId: 'url-in-flight', accessedAt: '2026-01-01T00:00:00.000Z' },
    })
    const closing = scope.close().runPromise()
    await setTimeout(10)

    expect(state.closeWorker).toHaveBeenCalledExactlyOnceWith()
    expect(state.closeQueue).not.toHaveBeenCalled()
    expect(state.disconnect).not.toHaveBeenCalled()

    gate.release?.()
    await Promise.all([activeJob, closing])

    expect(state.closeQueue).toHaveBeenCalledOnce()
    expect(state.disconnect).toHaveBeenCalledOnce()
    expect(state.closeWorker).toHaveBeenCalledBefore(state.closeQueue)
    expect(state.closeQueue).toHaveBeenCalledBefore(state.disconnect)
  })
  it('releases the queue and connection even when closing the worker fails', async () => {
    state.closeWorker.mockRejectedValueOnce(new Error('worker close failed'))
    const scope = createUrlAccessQueueModule(options, logger, () =>
      ResultTask.ok(undefined),
    ).scope()
    await scope.useSingletons(['urlAccessRecorder'], () => ResultTask.ok(undefined)).runPromise()
    await expect(scope.close().runPromise()).rejects.toThrow()
    expect(state.closeQueue).toHaveBeenCalledOnce()
    expect(state.disconnect).toHaveBeenCalledOnce()
  })

  it('keeps every cleanup failure in execution order', async () => {
    const workerFailure = new Error('worker close failed')
    const queueFailure = new Error('queue close failed')
    const redisFailure = new Error('Redis disconnect failed')
    state.closeWorker.mockRejectedValueOnce(workerFailure)
    state.closeQueue.mockRejectedValueOnce(queueFailure)
    state.disconnect.mockImplementationOnce(() => {
      throw redisFailure
    })
    const scope = createUrlAccessQueueModule(options, logger, () =>
      ResultTask.ok(undefined),
    ).scope()
    await scope.useSingletons(['urlAccessRecorder'], () => ResultTask.ok(undefined)).runPromise()
    expect(await scope.close().runExit()).toMatchObject({
      _tag: 'Failure',
      cause: {
        _tag: 'Sequential',
        left: {
          _tag: 'Sequential',
          left: { _tag: 'Die', defect: workerFailure },
          right: { _tag: 'Die', defect: queueFailure },
        },
        right: { _tag: 'Die', defect: redisFailure },
      },
    })
  })

  it('logs failed worker jobs with job identifier, urlId, and failure cause', async () => {
    const scope = createUrlAccessQueueModule(options, logger, () =>
      ResultTask.ok(undefined),
    ).scope()
    try {
      await scope.useSingletons(['urlAccessRecorder'], () => ResultTask.ok(undefined)).runPromise()
      const failedListener = state.workerListeners.get('failed')
      expect(failedListener).toBeTypeOf('function')

      const jobFailure = new Error('MongoDB write failed')
      failedListener?.(
        { id: 'job-42', data: { urlId: 'url-42', accessedAt: '2026-01-01T00:00:00.000Z' } },
        jobFailure,
      )
      expect(logger.error).toHaveBeenCalledWith(
        { err: jobFailure, jobId: 'job-42', urlId: 'url-42' },
        'URL access job failed',
      )

      failedListener?.(undefined, jobFailure)
      expect(logger.error).toHaveBeenCalledWith(
        { err: jobFailure, jobId: undefined, urlId: undefined },
        'URL access job failed',
      )
    } finally {
      await scope.close().runPromise()
    }
  })
})
