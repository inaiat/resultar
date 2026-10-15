import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  Exit,
  Result,
  ResultTaskGenerator,
  ResultTaskRunOptions,
  ResultTaskServices,
  ResultTaskYieldable,
  ResultTaskYieldOf,
  ServiceTag,
} from '../src/index.js'
import {
  Cause,
  createTaggedError,
  err,
  ok,
  pipe,
  ResultTask,
  ResultTaskTypeId,
  Semaphore,
} from '../src/index.js'

describe('ResultTask public types', () => {
  it('infers constructor and execution boundary types', async () => {
    const successful = ResultTask.ok(1)
    const failed = ResultTask.err<'not-found'>('not-found')
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
    const chained = workflow.andThen((value) =>
      ResultTask.try({ try: () => String(value), catch: () => 'format-failed' as const }),
    )
    const recovered = workflow.orElse(() => ResultTask.ok(0))

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
      // @ts-expect-error Both service requirements must be provided.
      void ResultTask.runResult<number, 'clock-failed', typeof Logger | typeof Clock>(workflow, {
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

  it('infers literal identifiers with curried and inline requirements', () => {
    const Cache = ResultTask.service<ReadonlyMap<string, number>>()('cache')
    expectTypeOf(Cache).toEqualTypeOf<ServiceTag<'cache', ReadonlyMap<string, number>>>()
    const task = ResultTask.gen(function* () {
      const cache = yield* ResultTask.service<ReadonlyMap<string, number>>()('cache')
      return cache.get('answer')
    })
    expectTypeOf(task).toEqualTypeOf<ResultTask<number | undefined, never, typeof Cache>>()
    const provided = task.provideServices({ cache: new Map([['answer', 42]]) })
    expectTypeOf(provided).toEqualTypeOf<ResultTask<number | undefined>>()
    if (false) {
      // @ts-expect-error Inline requirements must still be supplied.
      void ResultTask.runPromise(task)
      // @ts-expect-error Named provisioning preserves the exact identifier.
      void task.provideServices({ other: new Map<string, number>() })
      // @ts-expect-error Named provisioning checks the service contract.
      void task.provideServices({ cache: new Map<string, string>() })
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

  it('preserves nominal ResultTaskTypeId and type covariance', () => {
    type BaseUser = { readonly id: string }
    type AdminUser = BaseUser & { readonly role: 'admin' }

    const adminTask = ResultTask.ok<AdminUser>({ id: 'u1', role: 'admin' })

    expectTypeOf(adminTask[ResultTaskTypeId]).toEqualTypeOf<{
      readonly success: (_: never) => AdminUser
      readonly error: (_: never) => never
      readonly requirements: (_: never) => never
    }>()

    // Covariance in success type A: AdminUser -> BaseUser
    expectTypeOf(adminTask).toExtend<ResultTask<BaseUser>>()

    // Covariance in error type E: 'narrow' -> string
    const narrowErrorTask = ResultTask.err<'narrow'>('narrow')
    expectTypeOf(narrowErrorTask).toExtend<ResultTask<never, string>>()
  })

  it('infers synchronous Result returns in andThen, orElse, catchTag, and catchTags', () => {
    class MissingError extends createTaggedError({
      name: 'Missing',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class InvalidError extends createTaggedError({
      name: 'Invalid',
      message: 'Invalid $reason',
    }).withProps<{ readonly reason: string }>() {}

    const base = ResultTask.ok(10) as ResultTask<number, MissingError | InvalidError, never>

    const chainedOk = base.andThen((n) => ok(String(n)))
    const chainedErr = base.andThen(() => err('bad' as const))
    const chainedMixed = base.andThen((n) =>
      n > 0 ? ResultTask.ok(String(n)) : err('non-positive' as const),
    )

    expectTypeOf(chainedOk).toEqualTypeOf<ResultTask<string, MissingError | InvalidError, never>>()
    expectTypeOf(chainedErr).toEqualTypeOf<
      ResultTask<never, MissingError | InvalidError | 'bad', never>
    >()
    expectTypeOf(chainedMixed).toEqualTypeOf<
      ResultTask<string, MissingError | InvalidError | 'non-positive', never>
    >()

    const recoveredOk = base.orElse(() => ok(0))
    const recoveredErr = base.orElse(() => err('fatal' as const))
    expectTypeOf(recoveredOk).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(recoveredErr).toEqualTypeOf<ResultTask<number, 'fatal', never>>()

    const caughtOne = base.catchTag('Missing', (e) => ok(e.id.length))
    const caughtAll = base.catchTags({
      Missing: (e) => ok(e.id.length),
      Invalid: (e) => err(e.reason),
    })
    const piped = pipe(
      base,
      ResultTask.andThen((n) => (n > 0 ? ok(n * 2) : InvalidError.err({ reason: 'le-zero' }))),
      ResultTask.catchTag('Missing', () => ok(0)),
      ResultTask.catchTags({ Invalid: () => ResultTask.ok(-1) }),
    )

    expectTypeOf(caughtOne).toEqualTypeOf<ResultTask<number, InvalidError, never>>()
    expectTypeOf(caughtAll).toEqualTypeOf<ResultTask<number, string, never>>()
    expectTypeOf(piped).toEqualTypeOf<ResultTask<number, never, never>>()

    // @ts-expect-error catchTags handlers must return ResultTask or Result
    base.catchTags({ Missing: (e) => e.id.length })
  })

  it('infers ResultTask.fn post-body pipeline operators and filterOrElse / matchTags / matchTagsPartial types', () => {
    class MissingError extends createTaggedError({
      name: 'Missing',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}
    class InvalidError extends createTaggedError({
      name: 'Invalid',
      message: 'Invalid $reason',
    }).withProps<{ readonly reason: string }>() {}
    class TimeoutError extends createTaggedError({
      name: 'Timeout',
      message: 'Timed out after $ms',
    }).withProps<{ readonly ms: number }>() {}

    interface AuditService {
      readonly record: (msg: string) => void
    }
    const Audit = ResultTask.service<AuditService, 'Audit'>('Audit')

    const loadAndFormat = ResultTask.fn(
      function* (id: string, _minLen: number) {
        const audit = yield* Audit
        audit.record(id)
        if (id.length === 0) {
          return yield* ResultTask.err(new MissingError({ id }))
        }
        return id as string | number
      },
      ResultTask.filterOrElse(
        (v): v is string => typeof v === 'string',
        () => new InvalidError({ reason: 'not-string' }),
      ),
      (task, _id, minLen) =>
        task.filterOrElse(
          (s) => s.length >= minLen,
          () => new InvalidError({ reason: 'too-short' }),
        ),
      ResultTask.timeout(1000, () => new TimeoutError({ ms: 1000 })),
    )

    expectTypeOf(loadAndFormat).toEqualTypeOf<
      (
        id: string,
        minLen: number,
      ) => ResultTask<string, MissingError | InvalidError | TimeoutError, typeof Audit>
    >()

    const task = loadAndFormat('abc', 2)

    const exhaustive = task.matchTags((value) => ({ status: 200 as const, body: value }), {
      Missing: (e) => ({ status: 404 as const, body: e.id }),
      Invalid: (e) => ({ status: 400 as const, body: e.reason }),
      Timeout: (e) => ({ status: 504 as const, body: String(e.ms) }),
    })
    expectTypeOf(exhaustive).toEqualTypeOf<
      ResultTask<
        | { status: 200; body: string }
        | { status: 404; body: string }
        | { status: 400; body: string }
        | { status: 504; body: string },
        never,
        typeof Audit
      >
    >()

    const pipedExhaustive = pipe(
      task,
      ResultTask.matchTags((value) => `ok:${value}` as const, {
        Missing: (e) => `missing:${e.id}` as const,
        Invalid: (e) => `invalid:${e.reason}` as const,
        Timeout: (e) => `timeout:${e.ms}` as const,
      }),
    )
    expectTypeOf(pipedExhaustive).toEqualTypeOf<
      ResultTask<
        `ok:${string}` | `missing:${string}` | `invalid:${string}` | `timeout:${number}`,
        never,
        typeof Audit
      >
    >()

    const partial = pipe(
      task,
      ResultTask.matchTagsPartial(
        (value) => `ok:${value}` as const,
        { Missing: (e) => `missing:${e.id}` as const },
        (remaining) => {
          expectTypeOf(remaining).toEqualTypeOf<InvalidError | TimeoutError>()
          return `other:${remaining._tag}` as const
        },
      ),
    )
    expectTypeOf(partial).toEqualTypeOf<
      ResultTask<
        `ok:${string}` | `missing:${string}` | `other:Invalid` | `other:Timeout`,
        never,
        typeof Audit
      >
    >()

    // @ts-expect-error matchTags requires all tags in the error union to be handled
    task.matchTags((v) => v, { Missing: (e) => e.id, Invalid: (e) => e.reason })

    const inspectedInstance = task.inspectBoth({
      ok: (value) => {
        expectTypeOf(value).toEqualTypeOf<string>()
      },
      error: (error) => {
        expectTypeOf(error).toEqualTypeOf<MissingError | InvalidError | TimeoutError>()
      },
    })
    const inspectedPipe = pipe(
      task,
      ResultTask.inspectBoth(
        (value) => {
          expectTypeOf(value).toEqualTypeOf<string>()
        },
        (error) => {
          expectTypeOf(error).toEqualTypeOf<MissingError | InvalidError | TimeoutError>()
        },
      ),
    )
    expectTypeOf(inspectedInstance).toEqualTypeOf<
      ResultTask<string, MissingError | InvalidError | TimeoutError, typeof Audit>
    >()
    expectTypeOf(inspectedPipe).toEqualTypeOf<
      ResultTask<string, MissingError | InvalidError | TimeoutError, typeof Audit>
    >()
  })

  it('infers ensuring, delay, timed, asVoid, zip, firstSuccessOf, if/when/unless, loop, and iterate types', () => {
    const Logger = ResultTask.service<{ readonly log: (m: string) => void }, 'Logger'>('Logger')
    const Metrics = ResultTask.service<{ readonly inc: () => void }, 'Metrics'>('Metrics')

    const base = ResultTask.ok(1) as ResultTask<number, 'primary', typeof Logger>
    const ensured = base.ensuring((exit) => {
      expectTypeOf(exit).toEqualTypeOf<Exit<number, 'primary'>>()
      return ResultTask.ok(undefined) as ResultTask<void, 'cleanup', typeof Metrics>
    })
    expectTypeOf(ensured).toEqualTypeOf<
      ResultTask<number, 'primary' | 'cleanup', typeof Logger | typeof Metrics>
    >()

    const delayed = pipe(base, ResultTask.delay(100))
    const timed = delayed.timed()
    const voided = base.asVoid()

    expectTypeOf(delayed).toEqualTypeOf<ResultTask<number, 'primary', typeof Logger>>()
    expectTypeOf(timed).toEqualTypeOf<
      ResultTask<[durationMs: number, value: number], 'primary', typeof Logger>
    >()
    expectTypeOf(voided).toEqualTypeOf<ResultTask<void, 'primary', typeof Logger>>()

    const right = ResultTask.ok('ok') as ResultTask<string, 'secondary', typeof Metrics>
    const zipped = base.zip(right)
    const pipedZip = pipe(base, ResultTask.zip(ok<boolean, 'sync-err'>(true)))

    expectTypeOf(zipped).toEqualTypeOf<
      ResultTask<[number, string], 'primary' | 'secondary', typeof Logger | typeof Metrics>
    >()
    expectTypeOf(pipedZip).toEqualTypeOf<
      ResultTask<[number, boolean], 'primary' | 'sync-err', typeof Logger>
    >()

    const first = ResultTask.firstSuccessOf([base, right, () => err<boolean, 'e3'>('e3')])
    expectTypeOf(first).toEqualTypeOf<
      ResultTask<
        number | string | boolean,
        'primary' | 'secondary' | 'e3',
        typeof Logger | typeof Metrics
      >
    >()

    const condTask = ResultTask.ok(true) as ResultTask<boolean, 'cond-err', typeof Logger>
    const branched = ResultTask.if(condTask, {
      onTrue: () => right,
      onFalse: () => ok<number, 'false-err'>(0),
    })
    expectTypeOf(branched).toEqualTypeOf<
      ResultTask<
        string | number,
        'cond-err' | 'secondary' | 'false-err',
        typeof Logger | typeof Metrics
      >
    >()

    const metricsCond = ResultTask.ok(true) as ResultTask<boolean, 'cond-err', typeof Metrics>
    const gated = base.when(metricsCond)
    const unlessGated = pipe(
      base,
      ResultTask.unless(() => ok<boolean, 'sync-cond'>(false)),
    )
    expectTypeOf(gated).toEqualTypeOf<
      ResultTask<number | undefined, 'primary' | 'cond-err', typeof Logger | typeof Metrics>
    >()
    expectTypeOf(unlessGated).toEqualTypeOf<
      ResultTask<number | undefined, 'primary' | 'sync-cond', typeof Logger>
    >()

    const looped = ResultTask.loop(0 as number | null, {
      while: (s): s is number => s !== null && s < 3,
      step: (s) => (s === null ? null : s + 1),
      body: (s) => {
        expectTypeOf(s).toEqualTypeOf<number>()
        return base
      },
    })
    const loopedDiscard = ResultTask.loop(0, {
      while: (s) => s < 3,
      step: (s) => s + 1,
      discard: true,
      body: () => base,
    })
    const iterated = ResultTask.iterate(0, {
      while: (s) => s < 10,
      body: (s) => {
        expectTypeOf(s).toEqualTypeOf<number>()
        return base
      },
    })

    expectTypeOf(looped).toEqualTypeOf<ResultTask<readonly number[], 'primary', typeof Logger>>()
    expectTypeOf(loopedDiscard).toEqualTypeOf<ResultTask<void, 'primary', typeof Logger>>()
    expectTypeOf(iterated).toEqualTypeOf<ResultTask<number, 'primary', typeof Logger>>()
  })

  it('rejects non-ResultTaskYieldable values in ResultTask.gen and ResultTask.fn at compile time', () => {
    const validYield = ResultTask.ok(1)[Symbol.iterator]().next()
    if (!validYield.done) {
      expectTypeOf(validYield.value).toExtend<ResultTaskYieldable>()
    }

    if (false) {
      // @ts-expect-error Arbitrary numbers cannot be yielded inside ResultTask.gen
      void ResultTask.gen(function* () {
        yield 123
        return 1
      })

      // @ts-expect-error Raw Promises cannot be yielded inside ResultTask.gen
      void ResultTask.gen(function* () {
        yield Promise.resolve(1)
        return 1
      })

      // @ts-expect-error Unbranded objects cannot be yielded inside ResultTask.fn
      void ResultTask.fn(function* (id: string) {
        yield { _tag: 'ResultTask', id }
        return id
      })
    }
  })

  it('supports explicit ResultTaskGenerator and ResultTaskYieldOf annotations for gen, fn, and composable sub-generators', async () => {
    const Logger = ResultTask.service<{ readonly log: (m: string) => void }, 'Logger'>('Logger')
    const Repo = ResultTask.service<
      { readonly find: (id: string) => ResultTask<string, 'not-found', never> },
      'Repo'
    >('Repo')

    function* loadWithAudit(
      id: string,
    ): ResultTaskGenerator<string, 'not-found' | 'invalid-id', typeof Logger | typeof Repo> {
      if (id.length === 0) {
        return yield* ResultTask.err('invalid-id' as const)
      }
      const logger = yield* Logger
      const repo = yield* Repo
      const value = yield* repo.find(id)
      logger.log(value)
      return value
    }

    const fromFn = ResultTask.fn(
      function* (
        id: string,
      ): Generator<
        ResultTaskYieldOf<'not-found' | 'invalid-id', typeof Logger | typeof Repo>,
        string,
        never
      > {
        const value = yield* loadWithAudit(id)
        return value.toUpperCase()
      },
      (task) => task.provideService(Logger, { log: (m) => void m }),
    )

    const fromGen = ResultTask.gen(function* (): ResultTaskGenerator<
      string,
      'not-found' | 'invalid-id',
      typeof Logger | typeof Repo
    > {
      return yield* loadWithAudit('abc')
    })

    expectTypeOf(fromFn).toEqualTypeOf<
      (id: string) => ResultTask<string, 'not-found' | 'invalid-id', typeof Repo>
    >()
    expectTypeOf(fromGen).toEqualTypeOf<
      ResultTask<string, 'not-found' | 'invalid-id', typeof Logger | typeof Repo>
    >()

    const provided = fromFn('abc').provideService(Repo, {
      find: (id) => ResultTask.ok(`item:${id}`),
    })
    const result = await ResultTask.runResult(provided)
    expectTypeOf(result).toEqualTypeOf<Result<string, 'not-found' | 'invalid-id'>>()
  })

  it('infers catchCause, tapCause, inspectCause, sandbox, unsandbox, onExit, concurrent zip, and Semaphore types', () => {
    const Logger = ResultTask.service<{ readonly log: (m: string) => void }, 'Logger'>('Logger')
    const Metrics = ResultTask.service<{ readonly inc: () => void }, 'Metrics'>('Metrics')

    const base = ResultTask.ok(1) as ResultTask<number, 'primary', typeof Logger>

    const caughtCause = base.catchCause((cause) => {
      expectTypeOf(cause).toEqualTypeOf<Cause<'primary'>>()
      expectTypeOf(Cause.failures(cause)).toEqualTypeOf<readonly 'primary'[]>()
      expectTypeOf(Cause.defects(cause)).toEqualTypeOf<readonly unknown[]>()
      return ResultTask.ok('fallback' as const) as ResultTask<
        'fallback',
        'recovered-err',
        typeof Metrics
      >
    })
    expectTypeOf(caughtCause).toEqualTypeOf<
      ResultTask<number | 'fallback', 'recovered-err', typeof Logger | typeof Metrics>
    >()

    const sandboxed = base.sandbox()
    expectTypeOf(sandboxed).toEqualTypeOf<ResultTask<number, Cause<'primary'>, typeof Logger>>()

    const unsandboxed = pipe(sandboxed, ResultTask.unsandbox())
    expectTypeOf(unsandboxed).toEqualTypeOf<ResultTask<number, 'primary', typeof Logger>>()

    const tappedCause = pipe(
      base,
      ResultTask.tapCause((cause) => {
        expectTypeOf(cause).toEqualTypeOf<Cause<'primary'>>()
        return ResultTask.ok(undefined) as ResultTask<void, 'tap-err', typeof Metrics>
      }),
      ResultTask.inspectCause((cause) => {
        expectTypeOf(cause).toEqualTypeOf<Cause<'primary' | 'tap-err'>>()
      }),
    )
    expectTypeOf(tappedCause).toEqualTypeOf<
      ResultTask<number, 'primary' | 'tap-err', typeof Logger | typeof Metrics>
    >()

    const exited = pipe(
      base,
      ResultTask.onExit((exit) => {
        expectTypeOf(exit).toEqualTypeOf<Exit<number, 'primary'>>()
        return ResultTask.ok(undefined) as ResultTask<void, 'exit-err', typeof Metrics>
      }),
    )
    expectTypeOf(exited).toEqualTypeOf<
      ResultTask<number, 'primary' | 'exit-err', typeof Logger | typeof Metrics>
    >()

    const right = ResultTask.ok('b') as ResultTask<string, 'secondary', typeof Metrics>
    const concurrentZipped = base.zip(right, { concurrent: true })
    const pipedConcurrentZipped = pipe(base, ResultTask.zip(right, { concurrent: true }))
    expectTypeOf(concurrentZipped).toEqualTypeOf<
      ResultTask<[number, string], 'primary' | 'secondary', typeof Logger | typeof Metrics>
    >()
    expectTypeOf(pipedConcurrentZipped).toEqualTypeOf<
      ResultTask<[number, string], 'primary' | 'secondary', typeof Logger | typeof Metrics>
    >()

    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.ok(1) as ResultTask<number, 'acquire-err', typeof Logger>,
      release: () => ResultTask.err('cleanup' as const),
    })
    const staticResourceZipped = ResultTask.zip(resource, right, { concurrent: true })
    const curriedResourceZipped = pipe(resource, ResultTask.zip(right, { concurrent: true }))
    expectTypeOf(staticResourceZipped).toEqualTypeOf<
      ResultTask<
        [number, string],
        'acquire-err' | 'secondary' | 'cleanup',
        typeof Logger | typeof Metrics
      >
    >()
    expectTypeOf(curriedResourceZipped).toEqualTypeOf<
      ResultTask<
        [number, string],
        'acquire-err' | 'secondary' | 'cleanup',
        typeof Logger | typeof Metrics
      >
    >()

    const sem = ResultTask.makeSemaphore(2)
    expectTypeOf(sem).toEqualTypeOf<Semaphore>()
    const permitted = sem.withPermit(base)
    const multiPermitted = pipe(base, Semaphore.withPermits(sem, 2))
    expectTypeOf(permitted).toEqualTypeOf<ResultTask<number, 'primary', typeof Logger>>()
    expectTypeOf(multiPermitted).toEqualTypeOf<ResultTask<number, 'primary', typeof Logger>>()
  })
})
