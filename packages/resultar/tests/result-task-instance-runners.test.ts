import { deepEqual, equal, ok as assertOk, rejects } from 'node:assert/strict'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  AbortError,
  Cause,
  Clock,
  Fiber,
  ResultAsync,
  ResultTask,
  ResultTaskCauseError,
  createTaggedError,
  err,
  ok,
} from '../src/index.js'
import type { Exit, FiberHandle, Result, ResultTaskScope, StrictResultAsync } from '../src/index.js'

describe('ResultTask instance runners', () => {
  it('starts a fresh execution for each runner and stores methods on the prototype', async () => {
    let executions = 0
    const task = ResultTask.sync(() => {
      executions += 1
      return executions
    })
    equal(executions, 0)
    for (const method of ['runResult', 'runPromise', 'runExit', 'runFork']) {
      equal(Object.hasOwn(task, method), false)
    }
    equal(Reflect.has(task, 'then'), false)

    deepEqual(await task.runResult(), ok(1))
    equal(await task.runPromise(), 2)
    deepEqual(await task.runExit(), { _tag: 'Success', value: 3 })
    const fiber = task.runFork()
    equal(executions, 4)
    deepEqual(await Fiber.await(fiber).runPromise(), { _tag: 'Success', value: 4 })
  })

  it('retains the static runners and starts fresh asynchronous work on repeated runs', async () => {
    let executions = 0
    const task = ResultTask.tryPromise({
      try: () => {
        executions += 1
        return Promise.resolve(executions)
      },
      catch: () => 'unavailable' as const,
    })
    deepEqual(await task.runResult(), ok(1))
    deepEqual(await ResultTask.runResult(task), ok(2))
    equal(await task.runPromise(), 3)
    equal(await ResultTask.runPromise(task), 4)
    deepEqual(await task.runExit(), { _tag: 'Success', value: 5 })
    deepEqual(await ResultTask.runExit(task), { _tag: 'Success', value: 6 })
    const instanceFiber = task.runFork()
    const staticFiber = ResultTask.runFork(task)
    equal(instanceFiber === staticFiber, false)
    deepEqual(await Fiber.await(instanceFiber).runPromise(), { _tag: 'Success', value: 7 })
    deepEqual(await Fiber.await(staticFiber).runPromise(), { _tag: 'Success', value: 8 })
  })

  it('distinguishes typed failures from native Promise rejection', async () => {
    const error = new Error('not found')
    const task = ResultTask.err(error)
    deepEqual(await task.runResult(), err(error))
    await rejects(task.runPromise(), (caught: unknown) => caught === error)
    deepEqual(await task.runExit(), { _tag: 'Failure', cause: { _tag: 'Fail', error } })
    deepEqual(await Fiber.await(task.runFork()).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error },
    })
  })

  it('rejects defects at Result and Promise boundaries but preserves them in exits', async () => {
    const defect = new Error('programmer defect')
    const task = ResultTask.sync((): never => {
      throw defect
    })
    await rejects(
      async () => await task.runResult(),
      (caught: unknown) => caught === defect,
    )
    await rejects(task.runPromise(), (caught: unknown) => caught === defect)
    deepEqual(await task.runExit(), { _tag: 'Failure', cause: { _tag: 'Die', defect } })
    deepEqual(await Fiber.await(task.runFork()).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('closes scopes and preserves release errors at every boundary', async () => {
    const releaseError = new Error('close failed')
    let releases = 0
    const task = ResultTask.acquireRelease({
      acquire: ResultTask.ok('connection'),
      release: () =>
        ResultTask.sync(() => {
          releases += 1
        }).andThen(() => ResultTask.err(releaseError)),
    })
    deepEqual(await task.runResult(), err(releaseError))
    await rejects(task.runPromise(), (caught: unknown) => caught === releaseError)
    deepEqual(await task.runExit(), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: releaseError },
    })
    deepEqual(await Fiber.await(task.runFork()).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: releaseError },
    })
    equal(releases, 4)
  })

  it('preserves composite use and release failures instead of collapsing them into an Err', async () => {
    const useError = new Error('use failed')
    const releaseError = new Error('release failed')
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(undefined),
        release: () => ResultTask.err(releaseError),
      })
      return yield* ResultTask.err(useError)
    })
    await rejects(async () => await task.runResult(), ResultTaskCauseError)
    await rejects(task.runPromise(), ResultTaskCauseError)
    for (const exit of [await task.runExit(), await Fiber.await(task.runFork()).runPromise()]) {
      assertOk(exit._tag === 'Failure')
      deepEqual(Cause.failures(exit.cause), [useError, releaseError])
      equal(exit.cause._tag, 'Sequential')
    }
  })

  it('honors pre-aborted run options without executing the task', async () => {
    const controller = new AbortController()
    controller.abort('already stopped')
    let executions = 0
    const task = ResultTask.sync(() => {
      executions += 1
      return executions
    })
    const options = { signal: controller.signal }
    await rejects(async () => await task.runResult(options), AbortError)
    await rejects(task.runPromise(options), AbortError)
    const expected = { _tag: 'Failure', cause: { _tag: 'Interrupt', reason: 'already stopped' } }
    deepEqual(await task.runExit(options), expected)
    deepEqual(await Fiber.await(task.runFork(options)).runPromise(), expected)
    equal(executions, 0)
  })

  it('forwards clock and cancellation to a fiber and awaits asynchronous cleanup', async () => {
    const clock = Clock.virtual()
    const controller = new AbortController()
    const events: string[] = []
    const task = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => events.push('acquire')),
        release: () => ResultTask.sleep(2).inspect(() => events.push('release')),
      })
      yield* ResultTask.sleep(100)
      return 'done'
    })
    const fiber = task.runFork({ clock, signal: controller.signal })
    await clock.flush()
    deepEqual(events, ['acquire'])
    controller.abort('shutdown')
    await clock.flush()
    equal(Fiber.poll(fiber), undefined)
    await clock.advanceBy(2)
    deepEqual(await Fiber.await(fiber).runPromise(), {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'shutdown' },
    })
    deepEqual(events, ['acquire', 'release'])
    equal(clock.pending, 0)
  })

  it('forwards required services and retains deferred release errors in public types', async () => {
    const Config = ResultTask.service<{ readonly value: number }>()('config')
    const workflow = ResultTask.gen(function* () {
      const config = yield* Config
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(config.value),
        release: () => ResultTask.err('release failed' as const),
      })
      return config.value
    })
    const options = { services: { config: { value: 42 } } }
    const result = await workflow.runResult(options)
    const exit = await workflow.runExit(options)
    const fiber = workflow.runFork(options)
    expectTypeOf(result).toEqualTypeOf<Result<number, 'release failed'>>()
    expectTypeOf(exit).toEqualTypeOf<Exit<number, 'release failed'>>()
    expectTypeOf(fiber).toEqualTypeOf<FiberHandle<number, 'release failed'>>()
    deepEqual(result, err('release failed'))
    deepEqual(exit, { _tag: 'Failure', cause: { _tag: 'Fail', error: 'release failed' } })
    deepEqual(await Fiber.await(fiber).runPromise(), exit)
    const supplied = ResultTask.gen(function* () {
      const config = yield* Config
      return config.value
    })
    equal(await supplied.runPromise(options), 42)

    if (false) {
      expectTypeOf(workflow.runPromise(options)).toEqualTypeOf<Promise<number>>()
      // @ts-expect-error Required services cannot be omitted.
      void workflow.runResult()
      // @ts-expect-error Required services cannot be omitted.
      void workflow.runPromise()
      // @ts-expect-error Required services cannot be omitted.
      void workflow.runExit()
      // @ts-expect-error Required services cannot be omitted.
      void workflow.runFork()
      // @ts-expect-error Options cannot widen the task's required service contract.
      void workflow.runResult({ services: { config: { value: 'wrong' } } })
      // @ts-expect-error Options cannot widen the task's required service contract.
      void workflow.runPromise({ services: { config: { value: 'wrong' } } })
      // @ts-expect-error Options cannot widen the task's required service contract.
      void workflow.runExit({ services: { config: { value: 'wrong' } } })
      // @ts-expect-error Options cannot widen the task's required service contract.
      void workflow.runFork({ services: { config: { value: 'wrong' } } })
    }
  })

  it('preserves covariance and requires a receiver without becoming PromiseLike', () => {
    const narrow = ResultTask.ok<'ready', 'missing'>('ready')
    const wide: ResultTask<string, string> = narrow
    const Config = ResultTask.service<{ readonly value: number }>()('config')
    const Logger = ResultTask.service<{ readonly log: () => void }>()('logger')
    const required = ResultTask.gen(function* () {
      const config = yield* Config
      return config.value
    })
    const widenedRequirements: ResultTask<number, string, typeof Config | typeof Logger> = required
    expectTypeOf(wide).toEqualTypeOf<ResultTask<string, string>>()
    expectTypeOf(widenedRequirements).toEqualTypeOf<
      ResultTask<number, string, typeof Config | typeof Logger>
    >()

    if (false) {
      expectTypeOf(narrow.runResult()).toEqualTypeOf<ResultAsync<'ready', 'missing'>>()
      expectTypeOf(narrow.runPromise()).toEqualTypeOf<Promise<'ready'>>()
      expectTypeOf(narrow.runExit()).toEqualTypeOf<Promise<Exit<'ready', 'missing'>>>()
      expectTypeOf(narrow.runFork()).toEqualTypeOf<FiberHandle<'ready', 'missing'>>()
      const scoped: ResultTask<
        number,
        'acquire',
        ResultTaskScope<'release'>
      > = ResultTask.acquireRelease({
        acquire: ResultTask.ok<number, 'acquire'>(1),
        release: () => ResultTask.err('release' as const),
      })
      expectTypeOf(scoped.runResult()).toEqualTypeOf<ResultAsync<number, 'acquire' | 'release'>>()
      expectTypeOf(scoped.runExit()).toEqualTypeOf<Promise<Exit<number, 'acquire' | 'release'>>>()
      expectTypeOf(scoped.runFork()).toEqualTypeOf<FiberHandle<number, 'acquire' | 'release'>>()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Intentionally verify calls without a receiver fail type checking.
      const { runResult, runPromise, runExit, runFork } = narrow
      // @ts-expect-error Unbound execution has no Task receiver.
      void runResult()
      // @ts-expect-error Unbound execution has no Task receiver.
      void runPromise()
      // @ts-expect-error Unbound execution has no Task receiver.
      void runExit()
      // @ts-expect-error Unbound execution has no Task receiver.
      void runFork()
      // @ts-expect-error Task remains a blueprint, not a PromiseLike.
      const promiseLike: PromiseLike<unknown> = narrow
      void promiseLike
      // @ts-expect-error The interpreter's run method remains private.
      void narrow.run()
      // @ts-expect-error Tasks with no requirements cannot accept unrelated services.
      void narrow.runResult({ services: { config: { value: 1 } } })
      // @ts-expect-error Tasks with no requirements cannot accept unrelated services.
      void narrow.runPromise({ services: { config: { value: 1 } } })
      // @ts-expect-error Tasks with no requirements cannot accept unrelated services.
      void narrow.runExit({ services: { config: { value: 1 } } })
      // @ts-expect-error Tasks with no requirements cannot accept unrelated services.
      void narrow.runFork({ services: { config: { value: 1 } } })
    }
  })

  it('supports binding instance runners and single-callback ResultAsync.then inference', async () => {
    const task = ResultTask.ok<'ready', 'missing'>('ready')
    const boundRunResult = task.runResult.bind(task)
    const boundRunPromise = task.runPromise.bind(task)
    const boundRunExit = task.runExit.bind(task)
    const boundRunFork = task.runFork.bind(task)
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Verify retained toResultAsync alias also binds cleanly.
    const boundToResultAsync = task.toResultAsync.bind(task)

    expectTypeOf(boundRunResult()).toEqualTypeOf<ResultAsync<'ready', 'missing'>>()
    expectTypeOf(boundRunPromise()).toEqualTypeOf<Promise<'ready'>>()
    expectTypeOf(boundRunExit()).toEqualTypeOf<Promise<Exit<'ready', 'missing'>>>()
    expectTypeOf(boundRunFork()).toEqualTypeOf<FiberHandle<'ready', 'missing'>>()
    expectTypeOf(boundToResultAsync()).toEqualTypeOf<ResultAsync<'ready', 'missing'>>()

    deepEqual(await boundRunResult(), ok('ready'))
    equal(await boundRunPromise(), 'ready')
    deepEqual(await boundRunExit(), { _tag: 'Success', value: 'ready' })
    deepEqual(await Fiber.await(boundRunFork()).runPromise(), { _tag: 'Success', value: 'ready' })
    deepEqual(await boundToResultAsync(), ok('ready'))

    const singleCallbackThen = task.runResult().then((res) => (res.isOk() ? res.value.length : 0))
    expectTypeOf(singleCallbackThen).toEqualTypeOf<PromiseLike<number>>()
    equal(await singleCallbackThen, 5)
    const noCallbackThen = task.runResult().then()
    expectTypeOf(noCallbackThen).toEqualTypeOf<PromiseLike<Result<'ready', 'missing'>>>()
    deepEqual(await noCallbackThen, ok('ready'))
  })

  it('supports binding instance runners for service-requiring tasks', async () => {
    const Config = ResultTask.service<{ readonly port: number }>()('config')
    const serviceWorkflow = ResultTask.gen(function* () {
      const config = yield* Config
      return config.port
    })
    const boundServiceRunResult = serviceWorkflow.runResult.bind(serviceWorkflow)
    const boundServiceRunPromise = serviceWorkflow.runPromise.bind(serviceWorkflow)
    const boundServiceRunExit = serviceWorkflow.runExit.bind(serviceWorkflow)
    const boundServiceRunFork = serviceWorkflow.runFork.bind(serviceWorkflow)
    const serviceOptions = { services: { config: { port: 8080 } } }

    deepEqual(await boundServiceRunResult(serviceOptions), ok(8080))
    equal(await boundServiceRunPromise(serviceOptions), 8080)
    deepEqual(await boundServiceRunExit(serviceOptions), { _tag: 'Success', value: 8080 })
    deepEqual(await Fiber.await(boundServiceRunFork(serviceOptions)).runPromise(), {
      _tag: 'Success',
      value: 8080,
    })

    if (false) {
      // @ts-expect-error Bound runner for a service-requiring task still requires options.
      void boundServiceRunResult()
      // @ts-expect-error Bound runner for a service-requiring task still requires options.
      void boundServiceRunPromise()
      // @ts-expect-error Bound runner for a service-requiring task still requires options.
      void boundServiceRunExit()
      // @ts-expect-error Bound runner for a service-requiring task still requires options.
      void boundServiceRunFork()
    }
  })

  it('returns a fluent ResultAsync from runResult and supports toResultAsync / ResultAsync.fromTask aliases', async () => {
    class MissingError extends createTaggedError({
      name: 'Missing',
      message: 'Missing $id',
    }).withProps<{ readonly id: string }>() {}

    class ForbiddenError extends createTaggedError({
      name: 'Forbidden',
      message: 'Forbidden $id',
    }).withProps<{ readonly id: string }>() {}

    let runs = 0
    const countTask = ResultTask.sync(() => {
      runs += 1
      return runs
    })

    const instanceRun = countTask.runResult()
    const staticRun = ResultTask.runResult(countTask)
    /* eslint-disable @typescript-eslint/no-deprecated -- Verify retained alias methods delegate to runResult(). */
    const instanceAlias = countTask.toResultAsync()
    const staticAlias = ResultTask.toResultAsync(countTask)
    const asyncAlias = ResultAsync.fromTask(countTask)
    /* eslint-enable @typescript-eslint/no-deprecated */

    assertOk(instanceRun instanceof ResultAsync)
    assertOk(staticRun instanceof ResultAsync)
    assertOk(instanceAlias instanceof ResultAsync)
    assertOk(staticAlias instanceof ResultAsync)
    assertOk(asyncAlias instanceof ResultAsync)

    expectTypeOf(instanceRun).toEqualTypeOf<StrictResultAsync<number, never>>()
    expectTypeOf(staticRun).toEqualTypeOf<ResultAsync<number, never>>()

    deepEqual(await instanceRun, ok(1))
    deepEqual(await staticRun, ok(2))
    deepEqual(await instanceAlias, ok(3))
    deepEqual(await staticAlias, ok(4))
    deepEqual(await asyncAlias, ok(5))

    const chainedSuccess = await ResultTask.ok<number, MissingError | ForbiddenError>(10)
      .runResult()
      .map((value) => value * 2)
      .andThen((value) => ok(value + 1))
      .filterOrElse(
        (value) => value > 10,
        () => new ForbiddenError({ id: 'too-small' }),
      )
      .as('completed' as const)
      .match(
        (status) => `ok:${status}`,
        (error) => `err:${error._tag}`,
      )
    equal(chainedSuccess, 'ok:completed')

    const failingTask = ResultTask.err<number, MissingError | ForbiddenError>(
      new MissingError({ id: 'user_42' }),
    )
    const recoveredTag = await ResultTask.runResult(failingTask)
      .catchTag('Missing', (error) => ok(error.id.length))
      .unwrapOr(0)
    equal(recoveredTag, 7)

    const matchedTags = await failingTask
      .runResult()
      .matchTags((value) => `value:${String(value)}`, {
        Missing: (error) => `missing:${error.id}`,
        Forbidden: (error) => `forbidden:${error.id}`,
      })
    equal(matchedTags, 'missing:user_42')

    const partialMatched = await failingTask.runResult().matchTagsPartial(
      (value) => `value:${String(value)}`,
      { Forbidden: (error) => `forbidden:${error.id}` },
      (error) => `fallback:${error._tag}`,
    )
    equal(partialMatched, 'fallback:Missing')

    equal(await ResultTask.ok(99).runResult().unwrapOrThrow(), 99)
  })

  it('propagates defects, interruptions, and composite causes through runResult() ResultAsync chains', async () => {
    const defect = new Error('defect-boom')
    const dieTask = ResultTask.sync((): number => {
      throw defect
    })
    await rejects(
      async () => await dieTask.runResult().map((value) => value * 2),
      (error: unknown) => error === defect,
    )
    const caughtViaThen = await dieTask.runResult().then(
      () => 'unexpected',
      (error: unknown) => (error instanceof Error ? `caught:${error.message}` : 'other'),
    )
    equal(caughtViaThen, 'caught:defect-boom')

    const abortController = new AbortController()
    abortController.abort('cancelled')
    await rejects(
      async () =>
        await ResultTask.ok(1)
          .runResult({ signal: abortController.signal })
          .match(
            () => 'ok',
            () => 'err',
          ),
      (error: unknown) => error instanceof AbortError && error.cause === 'cancelled',
    )

    const compositeTask = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok(undefined),
        release: () => ResultTask.err('second' as const),
      })
      return yield* ResultTask.err('first' as const)
    })
    await rejects(
      async () => await compositeTask.runResult().unwrapOr('fallback' as never),
      ResultTaskCauseError,
    )
  })
})
