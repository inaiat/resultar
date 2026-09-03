import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Cause, Exit, Result, ResultTaskRunOptions, ResultTaskServices } from '../src/index.js'
import { ResultTask } from '../src/index.js'

describe('ResultTask public types', () => {
  it('infers constructor and execution boundary types', async () => {
    const successful = ResultTask.succeed(1)
    const failed = ResultTask.fail<'not-found'>('not-found')
    const synchronous = ResultTask.sync(() => 'value')
    const caught = ResultTask.try({ try: () => 1, catch: () => 'invalid' as const })
    const promised = ResultTask.tryPromise({
      try: async () => true,
      catch: () => 'offline' as const,
    })

    expectTypeOf(successful).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(failed).toEqualTypeOf<ResultTask<never, 'not-found', never>>()
    expectTypeOf(synchronous).toEqualTypeOf<ResultTask<string, never, never>>()
    expectTypeOf(caught).toEqualTypeOf<ResultTask<number, 'invalid', never>>()
    expectTypeOf(promised).toEqualTypeOf<ResultTask<boolean, 'offline', never>>()

    const exit = await ResultTask.runExit(successful)
    const result = await ResultTask.runResult(successful)
    const value = await ResultTask.runPromise(successful)

    expectTypeOf(exit).toEqualTypeOf<Exit<number, never>>()
    expectTypeOf(result).toEqualTypeOf<Result<number, never>>()
    expectTypeOf(value).toEqualTypeOf<number>()
    const runOptions: ResultTaskRunOptions<never> = {}
    expectTypeOf(runOptions).toExtend<{
      readonly signal?: AbortSignal
      readonly services?: never
    }>()

    if (false) {
      // @ts-expect-error A task without requirements does not accept a service environment.
      void ResultTask.runResult(successful, { services: {} })
      // @ts-expect-error ResultTask is not implicitly awaitable.
      const promiseLike: PromiseLike<number> = successful
      void promiseLike
    }
  })

  it('preserves and combines error and service requirement types', () => {
    interface Logger {
      readonly info: (message: string) => void
    }

    interface Clock {
      readonly now: () => number
    }

    const Logger = ResultTask.service<Logger, 'Logger'>('Logger')
    const Clock = ResultTask.service<Clock, 'Clock'>('Clock')

    if (false) {
      // @ts-expect-error The service identifier must be explicit to preserve named environment keys.
      void ResultTask.service<Logger>('Logger')
    }

    const workflow = ResultTask.gen(function* () {
      const logger = yield* Logger
      const clock = yield* Clock
      const value = yield* ResultTask.try({
        try: () => clock.now(),
        catch: () => 'clock-failed' as const,
      })

      logger.info(String(value))
      return value
    })
    const mapped = workflow.map((value) => value + 1)
    const chained = workflow.flatMap((value) =>
      ResultTask.try({ try: () => String(value), catch: () => 'format-failed' as const }),
    )
    const recovered = workflow.catchAll(() => ResultTask.succeed(0))

    expectTypeOf(workflow).toEqualTypeOf<
      ResultTask<number, 'clock-failed', typeof Logger | typeof Clock>
    >()
    expectTypeOf(mapped).toEqualTypeOf<
      ResultTask<number, 'clock-failed', typeof Logger | typeof Clock>
    >()
    expectTypeOf(chained).toEqualTypeOf<
      ResultTask<string, 'clock-failed' | 'format-failed', typeof Logger | typeof Clock>
    >()
    expectTypeOf(recovered).toEqualTypeOf<ResultTask<number, never, typeof Logger | typeof Clock>>()
    const services: ResultTaskServices<typeof Logger | typeof Clock> = {
      Logger: { info: () => undefined },
      Clock: { now: () => 0 },
    }
    expectTypeOf(services['Logger']).toEqualTypeOf<Logger>()
    expectTypeOf(services['Clock']).toEqualTypeOf<Clock>()

    if (false) {
      // @ts-expect-error A workflow cannot be executed without its required services.
      void ResultTask.runPromise(workflow)
      void ResultTask.runResult<number, 'clock-failed', typeof Logger | typeof Clock>(workflow, {
        // @ts-expect-error Both service requirements must be provided.
        services: { Logger: { info: () => undefined } },
      })
    }
  })

  it('removes requirements through service provisioning', () => {
    interface Logger {
      readonly info: (message: string) => void
    }

    const Logger = ResultTask.service<Logger, 'Logger'>('Logger')
    const workflow = ResultTask.gen(function* () {
      const logger = yield* Logger
      logger.info('started')
      return 1
    })
    const logger: Logger = { info: () => undefined }
    const oneProvided = ResultTask.provideService(workflow, Logger, logger)
    const allProvided = ResultTask.provideServices(workflow, { Logger: logger })

    expectTypeOf(oneProvided).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(allProvided).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(ResultTask.runExit(oneProvided)).toEqualTypeOf<Promise<Exit<number, never>>>()
    expectTypeOf(ResultTask.runResult(allProvided)).toEqualTypeOf<Promise<Result<number, never>>>()

    if (false) {
      const Other = ResultTask.service<{ readonly value: string }, 'Other'>('Other')
      // @ts-expect-error Only services required by the workflow can be provided by token.
      void ResultTask.provideService(workflow, Other, { value: 'invalid' })
    }
  })

  it('keeps public exit and cause types discriminated', () => {
    const success: Exit<number, 'failure'> = { _tag: 'Success', value: 1 }
    const failure: Exit<number, 'failure'> = {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'failure' },
    }
    const defect: Cause<'failure'> = { _tag: 'Die', defect: new Error('bug') }

    expectTypeOf(success.value).toEqualTypeOf<number>()
    expectTypeOf(failure.cause).toEqualTypeOf<Cause<'failure'>>()
    expectTypeOf(defect).toExtend<Cause<'failure'>>()

    const inspectExit = (exit: Exit<number, 'failure'>): void => {
      if (exit._tag === 'Success') {
        expectTypeOf(exit.value).toEqualTypeOf<number>()
      } else {
        expectTypeOf(exit.cause).toEqualTypeOf<Cause<'failure'>>()
      }
    }

    inspectExit(success)
    inspectExit(failure)
  })
})
