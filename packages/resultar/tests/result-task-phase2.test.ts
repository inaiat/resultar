import { deepEqual, equal } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'
import {
  err,
  isResultTask,
  isServiceTag,
  MissingServiceError,
  ok,
  ResultTask,
  ResultTaskTypeId,
  ResultTaskYieldTypeId,
  serviceTag,
  ServiceTagTypeId,
  type Exit,
  type Result,
  type ResultTaskServices,
} from '../src/index.js'

describe('ResultTask — Phase 2: Generators and Services', () => {
  describe('Nominal Yieldable & ServiceTag Contract', () => {
    it('defines unique symbols for ServiceTagTypeId and ResultTaskYieldTypeId', () => {
      equal(typeof ServiceTagTypeId, 'symbol')
      equal(typeof ResultTaskYieldTypeId, 'symbol')
      equal(ServiceTagTypeId, Symbol.for('resultar/ServiceTag'))
      equal(ResultTaskYieldTypeId, Symbol.for('resultar/ResultTaskYield'))
    })

    it('creates branded service tags with serviceTag and ResultTask.service', () => {
      const Tag1 = serviceTag<string, 'Tag1'>('Tag1')
      const Tag2 = ResultTask.service<number, 'Tag2'>('Tag2')

      equal(Tag1.identifier, 'Tag1')
      equal(Tag1._tag, 'ServiceTag')
      equal(Tag1[ServiceTagTypeId], ServiceTagTypeId)
      equal(typeof Tag1.key, 'symbol')

      equal(Tag2.identifier, 'Tag2')
      equal(Tag2._tag, 'ServiceTag')
      equal(Tag2[ServiceTagTypeId], ServiceTagTypeId)
      equal(typeof Tag2.key, 'symbol')
    })

    it('identifies service tags using isServiceTag and rejects unbranded objects', () => {
      const Tag = serviceTag<string, 'Service'>('Service')
      equal(isServiceTag(Tag), true)

      equal(isServiceTag(null), false)
      equal(isServiceTag(undefined), false)
      equal(isServiceTag({}), false)
      equal(isServiceTag({ _tag: 'ServiceTag' }), false)
      equal(isServiceTag({ _tag: 'ServiceTag', identifier: 'Test' }), true)
    })

    it('identifies tasks using isResultTask', () => {
      const task = ResultTask.succeed(10)
      equal(isResultTask(task), true)
      equal(isResultTask({ [ResultTaskTypeId]: true }), true)
      equal(isResultTask({}), false)
      equal(isResultTask(null), false)
      equal(isResultTask(undefined), false)
    })

    it('attaches ResultTaskYieldTypeId to yielded values from ResultTask and ServiceTag', () => {
      const task = ResultTask.succeed('val')
      const taskGen = task[Symbol.iterator]()
      const taskYield = taskGen.next()
      equal(taskYield.done, false)
      if (!taskYield.done) {
        equal(taskYield.value._tag, 'ResultTask')
        equal(taskYield.value[ResultTaskYieldTypeId], ResultTaskYieldTypeId)
      }

      const Tag = serviceTag<string, 'Config'>('Config')
      const tagGen = Tag[Symbol.iterator]()
      const tagYield = tagGen.next()
      equal(tagYield.done, false)
      if (!tagYield.done) {
        equal(tagYield.value._tag, 'Service')
        equal(tagYield.value[ResultTaskYieldTypeId], ResultTaskYieldTypeId)
      }
    })
  })

  describe('Result Interoperability inside ResultTask.gen', () => {
    it('unwraps ok(T) directly with yield* without pausing execution', async () => {
      const task = ResultTask.gen(function* () {
        const x = yield* ok(10)
        const y = yield* ok(20)
        return x + y
      })

      expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, never>>()

      const result = await ResultTask.runResult(task)
      deepEqual(result, { value: 30 })
    })

    it('short-circuits on err(E) with yield* and propagates E to error channel', async () => {
      let reached = false
      const badInput: Result<number, 'bad-input'> = err('bad-input')
      const task = ResultTask.gen(function* () {
        const x = yield* ok(10)
        const y = yield* badInput
        reached = true
        return x + y
      })

      expectTypeOf(task).toEqualTypeOf<ResultTask<number, 'bad-input', never>>()

      const result = await ResultTask.runResult(task)
      deepEqual(result, { error: 'bad-input' })
      equal(reached, false)
    })

    it('executes generator finally blocks when yield* err short-circuits', async () => {
      const cleanups: string[] = []
      const task = ResultTask.gen(function* () {
        try {
          yield* ok(1)
          yield* err('error-with-cleanup' as const)
          return 100
        } finally {
          cleanups.push('generator-cleanup')
        }
      })

      const exit = await ResultTask.runExit(task)
      deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'error-with-cleanup' } })
      deepEqual(cleanups, ['generator-cleanup'])
    })

    it('combines Result and ResultTask error types in union', async () => {
      const okResult: Result<number, 'ok-err'> = ok(10)
      const failedTask: ResultTask<number, 'task-err', never> = ResultTask.fail('task-err')
      const task = ResultTask.gen(function* () {
        const a = yield* ok(5)
        const b = yield* ResultTask.succeed(15)
        const c = yield* okResult
        const d = yield* failedTask
        return a + b + c + d
      })

      expectTypeOf(task).toEqualTypeOf<ResultTask<number, 'ok-err' | 'task-err', never>>()

      const result = await ResultTask.runResult(task)
      deepEqual(result, { error: 'task-err' })
    })
  })

  describe('MissingServiceError and Defect Handling', () => {
    interface Clock {
      readonly now: () => number
    }
    const Clock = serviceTag<Clock, 'Clock'>('Clock')

    it('produces Die with MissingServiceError when service is omitted in runtime', async () => {
      const task = ResultTask.gen(function* () {
        const clock = yield* Clock
        return clock.now()
      })

      const exit = await ResultTask.runExit(task, {
        services: {} as ResultTaskServices<typeof Clock>,
      })

      equal(exit._tag, 'Failure')
      if (exit._tag === 'Failure') {
        equal(exit.cause._tag, 'Die')
        if (exit.cause._tag === 'Die') {
          equal(exit.cause.defect instanceof MissingServiceError, true)
          const error = exit.cause.defect as MissingServiceError
          equal(error.name, 'MissingServiceError')
          equal(error.serviceIdentifier, 'Clock')
          equal(error.message, 'Missing ResultTask service: Clock')
        }
      }
    })

    it('executes finally block in generator when service is missing', async () => {
      const traces: string[] = []
      const task = ResultTask.gen(function* () {
        try {
          traces.push('start')
          const clock = yield* Clock
          return clock.now()
        } finally {
          traces.push('cleaned-up')
        }
      })

      const exit = await ResultTask.runExit(task, {
        services: {} as ResultTaskServices<typeof Clock>,
      })

      equal(exit._tag, 'Failure')
      deepEqual(traces, ['start', 'cleaned-up'])
    })
  })

  describe('Service Provision APIs (Instance & Dual-API for Pipe)', () => {
    interface Database {
      readonly query: (sql: string) => Promise<string[]>
    }
    interface Logger {
      readonly log: (msg: string) => void
    }

    const Database = serviceTag<Database, 'Database'>('Database')
    const Logger = serviceTag<Logger, 'Logger'>('Logger')

    const dbLive: Database = { query: async (sql) => [`result-for:${sql}`] }
    const logs: string[] = []
    const loggerLive: Logger = {
      log: (msg) => {
        logs.push(msg)
      },
    }

    const workflow = ResultTask.gen(function* () {
      const db = yield* Database
      const logger = yield* Logger
      logger.log('querying')
      const rows = yield* ResultTask.tryPromise({
        try: () => db.query('SELECT 1'),
        catch: () => 'db-fail' as const,
      })
      logger.log('done')
      return rows[0]
    })

    it('provides services using instance method provideService sequentially', async () => {
      logs.length = 0
      const runnable = workflow.provideService(Database, dbLive).provideService(Logger, loggerLive)

      expectTypeOf(workflow).toEqualTypeOf<
        ResultTask<string | undefined, 'db-fail', typeof Database | typeof Logger>
      >()
      expectTypeOf(runnable).toEqualTypeOf<ResultTask<string | undefined, 'db-fail', never>>()

      const result = await ResultTask.runResult(runnable)
      deepEqual(result, { value: 'result-for:SELECT 1' })
      deepEqual(logs, ['querying', 'done'])
    })

    it('provides services using instance method provideServices in bulk', async () => {
      logs.length = 0
      const runnable = workflow.provideServices({ Database: dbLive, Logger: loggerLive })

      expectTypeOf(runnable).toEqualTypeOf<ResultTask<string | undefined, 'db-fail', never>>()

      const value = await ResultTask.runPromise(runnable)
      equal(value, 'result-for:SELECT 1')
      deepEqual(logs, ['querying', 'done'])
    })

    it('provides services using pipe with curried ResultTask.provideService', async () => {
      logs.length = 0
      const runnable = workflow
        .pipe(ResultTask.provideService(Database, dbLive))
        .pipe(ResultTask.provideService(Logger, loggerLive))

      expectTypeOf(runnable).toEqualTypeOf<ResultTask<string | undefined, 'db-fail', never>>()

      const result = await ResultTask.runResult(runnable)
      deepEqual(result, { value: 'result-for:SELECT 1' })
      deepEqual(logs, ['querying', 'done'])
    })

    it('provides services using pipe with curried ResultTask.provideServices', async () => {
      logs.length = 0
      const runnable = workflow.pipe(
        ResultTask.provideServices({ Database: dbLive, Logger: loggerLive }),
      )

      expectTypeOf(runnable).toEqualTypeOf<ResultTask<string | undefined, 'db-fail', never>>()

      const result = await ResultTask.runResult(runnable)
      deepEqual(result, { value: 'result-for:SELECT 1' })
      deepEqual(logs, ['querying', 'done'])
    })

    it('resolves services lazily using instance provideServiceResolver', async () => {
      let resolvedCount = 0
      const lazyWorkflow = ResultTask.gen(function* () {
        const db = yield* Database
        return yield* ResultTask.tryPromise({
          try: () => db.query('COUNT'),
          catch: () => 'err' as const,
        })
      })

      const resolved = lazyWorkflow.provideServiceResolver({
        Database: () => {
          resolvedCount += 1
          return ResultTask.succeed<Database>({ query: async () => ['resolved-db'] })
        },
      })

      expectTypeOf(resolved).toEqualTypeOf<ResultTask<string[], 'err', never>>()
      equal(resolvedCount, 0) // lazy, not called yet

      const res = await ResultTask.runResult(resolved)
      equal(resolvedCount, 1)
      deepEqual(res, { value: ['resolved-db'] })
    })
  })

  describe('Composite Requirements Inference ($R$)', () => {
    interface ServiceA {
      readonly a: number
    }
    interface ServiceB {
      readonly b: string
    }
    interface ServiceC {
      readonly c: boolean
    }

    const TagA = serviceTag<ServiceA, 'ServiceA'>('ServiceA')
    const TagB = serviceTag<ServiceB, 'ServiceB'>('ServiceB')
    const TagC = serviceTag<ServiceC, 'ServiceC'>('ServiceC')

    const taskA = ResultTask.gen(function* () {
      const s = yield* TagA
      return s.a
    })
    const taskB = ResultTask.gen(function* () {
      const s = yield* TagB
      return s.b
    })
    const taskC = ResultTask.gen(function* () {
      const s = yield* TagC
      return s.c
    })

    it('accumulates multiple service requirements into a union', () => {
      const combined = ResultTask.gen(function* () {
        const a = yield* taskA
        const b = yield* taskB
        const c = yield* taskC
        return `${a}-${b}-${c}`
      })

      expectTypeOf(combined).toEqualTypeOf<
        ResultTask<string, never, typeof TagA | typeof TagB | typeof TagC>
      >()
    })

    it('eliminates requirements one by one via provideService', async () => {
      const combined = ResultTask.gen(function* () {
        const a = yield* taskA
        const b = yield* taskB
        const c = yield* taskC
        return `${a}-${b}-${c}`
      })

      const step1 = combined.provideService(TagA, { a: 1 })
      expectTypeOf(step1).toEqualTypeOf<ResultTask<string, never, typeof TagB | typeof TagC>>()

      const step2 = step1.provideService(TagB, { b: 'hello' })
      expectTypeOf(step2).toEqualTypeOf<ResultTask<string, never, typeof TagC>>()

      const runnable = step2.provideService(TagC, { c: true })
      expectTypeOf(runnable).toEqualTypeOf<ResultTask<string, never, never>>()

      // When R is never, run boundaries accept zero arguments
      const val = await ResultTask.runPromise(runnable)
      equal(val, '1-hello-true')
      deepEqual(await ResultTask.runResult(runnable), { value: '1-hello-true' })
      deepEqual(await ResultTask.runExit(runnable), {
        _tag: 'Success',
        value: '1-hello-true',
      } satisfies Exit<string, never>)
    })

    it('enforces compile-time errors when running without all required services', () => {
      const taskNeedsA = ResultTask.gen(function* () {
        const s = yield* TagA
        return s.a
      })

      if (false) {
        // @ts-expect-error Task with requirement TagA cannot be run without arguments
        void ResultTask.runResult(taskNeedsA)
        // @ts-expect-error Incomplete service environment fails compilation
        void ResultTask.runResult(taskNeedsA, { services: {} })
      }
    })
  })
})
