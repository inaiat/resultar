import { equal, strictEqual, throws } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  createTaggedError,
  err,
  isResultTask,
  isServiceTag,
  MissingServiceError,
  okAsync,
  ResultTask,
  ResultTaskCauseError,
  ResultTaskTypeId,
  ResultTaskYieldTypeId,
  serviceTag,
  ServiceTagTypeId,
} from '../src/index.js'
import { TaskScope } from '../src/task/scope.js'

describe('TaskScope edge cases', () => {
  it('throws when adding a finalizer to a closing scope', async () => {
    const scope = new TaskScope()
    void scope.close({ _tag: 'Success', value: undefined })
    throws(
      () => scope.add(() => Promise.resolve({ _tag: 'Success', value: undefined })),
      /Cannot acquire into a closing ResultTask scope/u,
    )
  })

  it('throws when adopting a child scope into a closing scope', async () => {
    const scope = new TaskScope()
    void scope.close({ _tag: 'Success', value: undefined })
    const child = new TaskScope()
    throws(() => scope.adopt(child), /Cannot acquire into a closing ResultTask scope/u)
  })

  it('captures synchronous exceptions thrown by finalizers during drain', async () => {
    const scope = new TaskScope()
    scope.add(() => {
      throw new Error('sync finalizer throw')
    })
    const exit = await scope.close({ _tag: 'Success', value: 'original' })
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Die')
      if (exit.cause._tag === 'Die') {
        equal((exit.cause.defect as Error).message, 'sync finalizer throw')
      }
    }
  })
})

describe('ResultTask.memoize and ResultTask.makeScope', () => {
  it('memoizes successful in-flight execution and preserves result', async () => {
    let executions = 0
    const task = ResultTask.sync(() => {
      executions += 1
      return 100
    })
    const memo = ResultTask.memoize(task)
    const val1 = await ResultTask.runPromise(memo)
    const val2 = await ResultTask.runPromise(memo)
    equal(val1, 100)
    equal(val2, 100)
    equal(executions, 1)
  })

  it('resets memoized state on failure to allow retry', async () => {
    let attempts = 0
    const failingTask = ResultTask.sync(() => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('attempt 1 failed')
      }
      return 'recovered'
    })
    const memo = ResultTask.memoize(failingTask)
    const exit1 = await ResultTask.runExit(memo)
    equal(exit1._tag, 'Failure')
    const val2 = await ResultTask.runPromise(memo)
    equal(val2, 'recovered')
    equal(attempts, 2)
  })

  it('manages long-lived resources with makeScope and cleans up on close', async () => {
    const owner = ResultTask.makeScope()
    let resourceClosed = false
    const resource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed('active-resource'),
      release: () =>
        ResultTask.sync(() => {
          resourceClosed = true
        }),
    })

    const val = await ResultTask.runPromise(owner.use(resource))
    equal(val, 'active-resource')
    equal(resourceClosed, false)

    const closeExit = await ResultTask.runExit(owner.close())
    equal(closeExit._tag, 'Success')
    equal(resourceClosed, true)

    const afterCloseExit = await ResultTask.runExit(owner.use(ResultTask.succeed(1)))
    equal(afterCloseExit._tag, 'Failure')
    if (afterCloseExit._tag === 'Failure') {
      equal(afterCloseExit.cause._tag, 'Die')
      if (afterCloseExit.cause._tag === 'Die') {
        equal(
          (afterCloseExit.cause.defect as Error).message,
          'Cannot execute in a closed ResultTask scope',
        )
      }
    }
  })

  it('closes attempt immediately if task fails inside makeScope', async () => {
    const owner = ResultTask.makeScope()
    let resourceClosed = false
    const failingResource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed('temp-res'),
      release: () =>
        ResultTask.sync(() => {
          resourceClosed = true
        }),
    }).flatMap(() => ResultTask.fail('failed-in-use'))

    const exit = await ResultTask.runExit(owner.use(failingResource))
    equal(exit._tag, 'Failure')
    equal(resourceClosed, true)
    await ResultTask.runExit(owner.close())
  })

  it('handles abortion during execution in makeScope', async () => {
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    controller.abort()
    const abortedExit = await ResultTask.runExit(owner.use(ResultTask.succeed('ok')), {
      signal: controller.signal,
    })
    equal(abortedExit._tag, 'Failure')
    if (abortedExit._tag === 'Failure') {
      equal(abortedExit.cause._tag, 'Interrupt')
    }
    await ResultTask.runExit(owner.close())
  })
})

describe('ResultTask generator finally and error propagation', () => {
  const throwingTask = ResultTask.sync(() => {
    throw new Error('sync task throw')
  })

  it('captures throwing tasks inside finally in ResultTask.gen', async () => {
    const gen = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('initial-failure')
      } finally {
        yield* throwingTask
      }
    })
    const exit = await ResultTask.runExit(gen)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
      equal((exit.cause.defect as Error).message, 'sync task throw')
    }
  })

  it('captures failing service resolution inside finally in ResultTask.gen', async () => {
    const Tag = serviceTag<string, 'Tag'>('Tag')
    const gen = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('initial-failure')
      } finally {
        yield* Tag
      }
    })
    const provided = ResultTask.provideServiceResolver(gen, {
      Tag: () => ResultTask.fail('resolver-failure'),
    })
    const exit = await ResultTask.runExit(provided)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
      equal(exit.cause.error, 'resolver-failure')
    }
  })

  it('captures err results yielded inside finally in ResultTask.gen', async () => {
    const gen = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('initial-failure')
      } finally {
        yield* err('finally-err')
      }
    })
    const exit = await ResultTask.runExit(gen)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
      equal(exit.cause.error, 'finally-err')
    }
  })

  it('captures unsupported values yielded inside finally in ResultTask.gen', async () => {
    const gen = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('initial-failure')
      } finally {
        yield* [123] as unknown as Iterable<never>
      }
    })
    const exit = await ResultTask.runExit(gen as never)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
      equal((exit.cause.defect as Error).message, 'ResultTask.gen yielded an unsupported value')
    }
  })

  it('captures tasks throwing in generator body and closes runtime', async () => {
    const gen = ResultTask.gen(function* () {
      yield* throwingTask
      return 1
    })
    const exit = await ResultTask.runExit(gen)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
      equal((exit.cause.defect as Error).message, 'sync task throw')
    }
  })

  it('captures resolver task that throws synchronous exception', async () => {
    const ThrowTag = serviceTag<string, 'ThrowTag'>('ThrowTag')
    const gen = ResultTask.gen(function* () {
      const s = yield* ThrowTag
      return s
    })
    const provided = ResultTask.provideServiceResolver(gen, { ThrowTag: () => throwingTask })
    const exit = await ResultTask.runExit(provided)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
      equal((exit.cause.defect as Error).message, 'sync task throw')
    }
  })
})

describe('ResultTask combinator error branches and defects', () => {
  it('converts synchronous throws in map, flatMap, tap, tapError, catchAll into Die', async () => {
    const mapThrow = ResultTask.succeed(1).map(() => {
      throw new Error('map throw')
    })
    const exitMap = await ResultTask.runExit(mapThrow)
    equal(exitMap._tag, 'Failure')

    const flatMapThrow = ResultTask.succeed(1).flatMap((): ResultTask<number, never, never> => {
      throw new Error('flatMap throw')
    })
    const exitFlatMap = await ResultTask.runExit(flatMapThrow)
    equal(exitFlatMap._tag, 'Failure')

    const tapThrow = ResultTask.succeed(1).tap(() => {
      throw new Error('tap throw')
    })
    const exitTap = await ResultTask.runExit(tapThrow)
    equal(exitTap._tag, 'Failure')

    const tapErrorThrow = ResultTask.fail('err').tapError(() => {
      throw new Error('tapError throw')
    })
    const exitTapError = await ResultTask.runExit(tapErrorThrow)
    equal(exitTapError._tag, 'Failure')

    const catchAllThrow = ResultTask.fail('err').catchAll((): ResultTask<number, never, never> => {
      throw new Error('catchAll throw')
    })
    const exitCatchAll = await ResultTask.runExit(catchAllThrow)
    equal(exitCatchAll._tag, 'Failure')
  })

  it('preserves Die defects across mapError and tapError', async () => {
    const dieTask = ResultTask.sync(() => {
      throw new Error('die defect')
    })
    const mapped = dieTask.mapError(() => 'mapped')
    const exitMapped = await ResultTask.runExit(mapped)
    equal(exitMapped._tag, 'Failure')
    if (exitMapped._tag === 'Failure') {
      equal(exitMapped.cause._tag, 'Die')
    }

    const tapped = dieTask.tapError(() => undefined)
    const exitTapped = await ResultTask.runExit(tapped)
    equal(exitTapped._tag, 'Failure')
    if (exitTapped._tag === 'Failure') {
      equal(exitTapped.cause._tag, 'Die')
    }
  })
})

describe('ResultTask fromResultAsync abortion and error handling', () => {
  it('returns interrupted when signal is pre-aborted or aborted during factory execution', async () => {
    const preController = new AbortController()
    preController.abort()
    const preTask = ResultTask.fromResultAsync(okAsync(1))
    const preExit = await ResultTask.runExit(preTask, { signal: preController.signal })
    equal(preExit._tag, 'Failure')
    if (preExit._tag === 'Failure') {
      equal(preExit.cause._tag, 'Interrupt')
    }

    const postController = new AbortController()
    const postTask = ResultTask.fromResultAsync(() => {
      postController.abort()
      return okAsync(2)
    })
    const postExit = await ResultTask.runExit(postTask, { signal: postController.signal })
    equal(postExit._tag, 'Failure')
    if (postExit._tag === 'Failure') {
      equal(postExit.cause._tag, 'Interrupt')
    }
  })

  it('returns Die when factory throws synchronous error', async () => {
    const throwingTask = ResultTask.fromResultAsync(() => {
      throw new Error('factory throw')
    })
    const exit = await ResultTask.runExit(throwingTask)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Die')
      if (exit.cause._tag === 'Die') {
        equal((exit.cause.defect as Error).message, 'factory throw')
      }
    }
  })
})

describe('ResultTask static helper validations', () => {
  const task = ResultTask.succeed(1)
  const tag = serviceTag<number, 'Num'>('Num')
  const callMethod = (name: string, ...args: unknown[]) => {
    const fn = (
      ResultTask as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>
    )[name]
    if (typeof fn === 'function') {
      return fn(...args)
    }
    throw new TypeError(`Method ${name} not found`)
  }

  it('validates provideService and provideServiceResolver arguments at runtime', () => {
    throws(
      () => callMethod('provideService', null, tag, 1),
      /ResultTask\.provideService expects a ResultTask as first argument/u,
    )
    throws(
      () => callMethod('provideService', task, null, 1),
      /ResultTask\.provideService requires a valid service tag/u,
    )
    throws(
      () => callMethod('provideService', null, 1),
      /ResultTask\.provideService requires a valid service tag/u,
    )

    throws(
      () => callMethod('provideServiceResolver', null, {}),
      /ResultTask\.provideServiceResolver expects a ResultTask as first argument/u,
    )
    throws(
      () => callMethod('provideServiceResolver', task, null),
      /ResultTask\.provideServiceResolver requires a resolvers object/u,
    )
    throws(
      () => callMethod('provideServiceResolver', null),
      /ResultTask\.provideServiceResolver requires a resolvers object/u,
    )
    throws(
      () => callMethod('provideServiceResolver'),
      /ResultTask\.provideServiceResolver requires a resolvers object/u,
    )
  })

  it('validates provideServices arguments at runtime', () => {
    throws(
      () => callMethod('provideServices', null, {}),
      /ResultTask\.provideServices expects a ResultTask as first argument/u,
    )
    throws(
      () => callMethod('provideServices', task, null),
      /ResultTask\.provideServices requires a services object/u,
    )
    throws(
      () => callMethod('provideServices', null),
      /ResultTask\.provideServices requires a services object/u,
    )
    throws(
      () => callMethod('provideServices'),
      /ResultTask\.provideServices requires a services object/u,
    )
  })

  it('validates functional combinator arguments and supports curried form', () => {
    throws(() => callMethod('map', task, undefined), /ResultTask\.map requires a mapping function/u)
    throws(
      () => callMethod('mapError', task, undefined),
      /ResultTask\.mapError requires an error mapping function/u,
    )
    throws(
      () => callMethod('flatMap', task, undefined),
      /ResultTask\.flatMap requires a continuation function/u,
    )
    throws(
      () => callMethod('catchAll', task, undefined),
      /ResultTask\.catchAll requires a recovery function/u,
    )
    throws(
      () => callMethod('tap', task, undefined),
      /ResultTask\.tap requires a side-effect function/u,
    )
    throws(
      () => callMethod('tapError', task, undefined),
      /ResultTask\.tapError requires an error side-effect function/u,
    )
    throws(
      () => callMethod('andThen', task, undefined),
      /ResultTask\.andThen requires a continuation function/u,
    )
    throws(() => callMethod('as', task, undefined), /ResultTask\.as requires a replacement value/u)
    throws(() => callMethod('match', task, undefined), /ResultTask\.match requires match handlers/u)

    // Curried forms
    const mapped = task.pipe(ResultTask.map((x) => x + 1))
    const flatMapped = task.pipe(ResultTask.flatMap((x) => ResultTask.succeed(x * 2)))
    const andThenCurried = task.pipe(ResultTask.andThen((x) => ResultTask.succeed(x * 2)))
    const tapped = task.pipe(ResultTask.tap(() => undefined))
    const asVal = task.pipe(ResultTask.as('hello'))
    const caught = ResultTask.fail('err').pipe(ResultTask.catchAll(() => ResultTask.succeed(0)))
    const matched = task.pipe(
      ResultTask.match({ onSuccess: (x) => `ok:${x}`, onFailure: () => 'fail' }),
    )

    expectTypeOf(mapped).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(flatMapped).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(andThenCurried).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(tapped).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(asVal).toEqualTypeOf<ResultTask<string, never, never>>()
    expectTypeOf(caught).toEqualTypeOf<ResultTask<number, never, never>>()
    expectTypeOf(matched).toEqualTypeOf<ResultTask<string, never, never>>()
  })

  it('executes combinators in data-first mode', async () => {
    let tapRun = false
    let tapErrRun = false
    const t = ResultTask.succeed(10)
    const errT = ResultTask.fail('err')

    const andThenRes = await ResultTask.runPromise(
      ResultTask.andThen(t, (x) => ResultTask.succeed(x * 3)),
    )
    equal(andThenRes, 30)

    const tapRes = await ResultTask.runPromise(
      ResultTask.tap(t, () => {
        tapRun = true
      }),
    )
    equal(tapRes, 10)
    equal(tapRun, true)

    const tapErrExit = await ResultTask.runExit(
      ResultTask.tapError(errT, () => {
        tapErrRun = true
      }),
    )
    equal(tapErrExit._tag, 'Failure')
    equal(tapErrRun, true)

    const asRes = await ResultTask.runPromise(ResultTask.as(t, 'replaced'))
    equal(asRes, 'replaced')

    const matchRes = await ResultTask.runPromise(
      ResultTask.match(t, { onSuccess: (x) => `ok:${x}`, onFailure: () => 'fail' }),
    )
    equal(matchRes, 'ok:10')
  })
})

describe('ResultTask synchronous executor exception handling', () => {
  const createSyncThrowingTask = () => {
    const raw = ResultTask.succeed(1) as unknown as Record<string, unknown>
    const broken = Object.create(raw) as Record<string, unknown>
    broken['execute'] = () => {
      throw new Error('sync execute throw')
    }
    return broken as unknown as ResultTask<number, never, never>
  }

  it('captures synchronous execution throw inside generator body and finally', async () => {
    const broken = createSyncThrowingTask()

    // Inside generator body
    const genBody = ResultTask.gen(function* () {
      yield* broken
      return 1
    })
    const bodyExit = await ResultTask.runExit(genBody)
    equal(bodyExit._tag, 'Failure')
    if (bodyExit._tag === 'Failure' && bodyExit.cause._tag === 'Die') {
      equal((bodyExit.cause.defect as Error).message, 'sync execute throw')
    }

    // Inside generator finally
    const genFinally = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('initial-err')
      } finally {
        yield* broken
      }
    })
    const finallyExit = await ResultTask.runExit(genFinally)
    equal(finallyExit._tag, 'Failure')
    if (finallyExit._tag === 'Failure' && finallyExit.cause._tag === 'Die') {
      equal((finallyExit.cause.defect as Error).message, 'sync execute throw')
    }
  })

  it('captures synchronous execution throw inside resolver and handles task undefined', async () => {
    const broken = createSyncThrowingTask()
    const Tag = serviceTag<number, 'Tag'>('Tag')

    const genResolver = ResultTask.gen(function* () {
      const s = yield* Tag
      return s
    })
    const provided = ResultTask.provideServiceResolver(genResolver, { Tag: () => broken })
    const exit = await ResultTask.runExit(provided)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
      equal((exit.cause.defect as Error).message, 'sync execute throw')
    }

    // task === undefined with supplied in resolveService (line 343)
    const TagA = serviceTag<string, 'TagA'>('TagA')
    const TagB = serviceTag<number, 'TagB'>('TagB')
    const genMixed = ResultTask.gen(function* () {
      const a = yield* TagA
      const b = yield* TagB
      return `${a}:${b}`
    })
    const workflow = genMixed
      .pipe(ResultTask.provideServices({ TagA: 'providedA' }))
      .pipe(ResultTask.provideServiceResolver({ TagB: () => ResultTask.succeed(42) }))
    const mixedVal = await ResultTask.runPromise(workflow)
    equal(mixedVal, 'providedA:42')
  })

  it('handles signals aborted in-flight or directly before execution in makeScope', async () => {
    const ctrlInFlight = new AbortController()
    const ownerInFlight = ResultTask.makeScope()
    const delayedTask = ResultTask.tryPromise({
      try: () =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(99), 30)
        }),
      catch: () => 'err' as const,
    })
    const inFlightPromise = ResultTask.runExit(ownerInFlight.use(delayedTask), {
      signal: ctrlInFlight.signal,
    })
    ctrlInFlight.abort()
    const exitInFlight = await inFlightPromise
    equal(exitInFlight._tag, 'Failure')
    if (exitInFlight._tag === 'Failure') {
      equal(exitInFlight.cause._tag, 'Interrupt')
    }
    await ResultTask.runExit(ownerInFlight.close())

    // Direct execute with pre-aborted signal (lines 1292, 1568)
    const abortedCtrl = new AbortController()
    abortedCtrl.abort()
    const fromAsync = ResultTask.fromResultAsync(okAsync('val'))
    const directExec = fromAsync as unknown as {
      execute: (c: unknown) => Promise<{ _tag: string }>
    }
    const res1 = await directExec.execute({ signal: abortedCtrl.signal })
    equal(res1._tag, 'Failure')

    const ownerDirect = ResultTask.makeScope()
    const useTask = ownerDirect.use(ResultTask.succeed(1))
    const directScopeExec = useTask as unknown as {
      execute: (c: unknown) => Promise<{ _tag: string }>
    }
    const res2 = await directScopeExec.execute({ signal: abortedCtrl.signal })
    equal(res2._tag, 'Failure')
    await ResultTask.runExit(ownerDirect.close())
  })

  it('captures synchronous execution throw inside instruction runner (line 691)', async () => {
    const syncThrowInst = new (ResultTask as unknown as new (fn: unknown) => ResultTask<unknown>)(
      () => {
        throw new Error('sync instruction throw')
      },
    )
    const exitSyncInst = await ResultTask.runExit(syncThrowInst)
    equal(exitSyncInst._tag, 'Failure')
    if (exitSyncInst._tag === 'Failure' && exitSyncInst.cause._tag === 'Die') {
      equal((exitSyncInst.cause.defect as Error).message, 'sync instruction throw')
    }
  })
})

describe('ResultTask Stryker Mutant Killers', () => {
  const task = ResultTask.succeed(1)

  it('validates ResultTaskCauseError and MissingServiceError error properties (lines 21-22, 41-43)', () => {
    const innerCause = {
      _tag: 'Sequential' as const,
      left: { _tag: 'Fail' as const, error: 'left' },
      right: { _tag: 'Fail' as const, error: 'right' },
    }
    const causeErr = new ResultTaskCauseError(innerCause)
    equal(causeErr.message, 'ResultTask execution failed with multiple causes')
    equal(causeErr.name, 'ResultTaskCauseError')
    equal(causeErr.cause, innerCause)
    const causeDescriptor = Object.getOwnPropertyDescriptor(causeErr, 'cause')
    equal(causeDescriptor?.configurable, true)
    equal(causeDescriptor?.enumerable, false)
    equal(causeDescriptor?.writable, true)

    const missingErr = new MissingServiceError('Database')
    equal(missingErr.message, 'Missing ResultTask service: Database')
    equal(missingErr.name, 'MissingServiceError')
    equal(missingErr.serviceIdentifier, 'Database')
  })

  it('validates isServiceTag and isResultTask boundary checks (lines 269, 274-278, 289-295, 303)', () => {
    // isPlainRecord Array check (line 269)
    equal(typeof ResultTask.provideServices, 'function')
    throws(
      () => ResultTask.provideServices([] as unknown as Record<string, unknown>),
      /requires a services object/u,
    )
    throws(
      () => ResultTask.provideServices('not-an-object' as never),
      /requires a services object/u,
    )
    throws(() => ResultTask.provideServices(task as never), /requires a services object/u)
    throws(
      () =>
        ResultTask.provideServiceResolver(
          [] as unknown as Record<string, () => ResultTask<unknown, unknown, unknown>>,
        ),
      /requires a resolvers object/u,
    )
    throws(
      () => ResultTask.provideServiceResolver('not-an-object' as never),
      /requires a resolvers object/u,
    )
    throws(() => ResultTask.provideServiceResolver(task as never), /requires a resolvers object/u)

    // isServiceTag checks (lines 274-278)
    const validTag = serviceTag<string>('ValidTag')
    equal(isServiceTag(validTag), true)
    equal(isServiceTag(null), false)
    equal(isServiceTag(undefined), false)
    equal(isServiceTag({}), false)
    const wrongTag: Record<PropertyKey, unknown> = {}
    // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
    Object.assign(wrongTag, validTag, { _tag: 'NotServiceTag' })
    equal(isServiceTag(wrongTag), false)
    const wrongIdentifier: Record<PropertyKey, unknown> = {}
    // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
    Object.assign(wrongIdentifier, validTag, { identifier: 123 })
    equal(isServiceTag(wrongIdentifier), false)
    const wrongKey: Record<PropertyKey, unknown> = {}
    // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
    Object.assign(wrongKey, validTag, { key: 'not-a-symbol' })
    equal(isServiceTag(wrongKey), false)
    const withoutIterator: Record<PropertyKey, unknown> = {}
    // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
    Object.assign(withoutIterator, validTag, { [Symbol.iterator]: undefined })
    equal(isServiceTag(withoutIterator), false)

    // isResultTask checks
    equal(isResultTask(ResultTask.succeed(1)), true)
    equal(isResultTask({}), false)
    equal(isResultTask(null), false)
  })

  it('rejects every malformed nominal guard while preserving valid branded values', async () => {
    const validTag = serviceTag<string>('GuardTag')
    const copyTag = (changes: Record<PropertyKey, unknown> = {}): Record<PropertyKey, unknown> => {
      const tag: Record<PropertyKey, unknown> = {}
      // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
      Object.assign(tag, validTag, { [Symbol.iterator]: validTag[Symbol.iterator] }, changes)
      return tag
    }
    const tagVariants: unknown[] = [
      copyTag({ [ServiceTagTypeId]: Symbol('wrong-brand') }),
      copyTag({ _tag: 'WrongTag' }),
      copyTag({ identifier: 123 }),
      copyTag({ key: 'wrong-key' }),
      copyTag({ [Symbol.iterator]: undefined }),
    ]
    equal(isServiceTag(validTag), true)
    const callableTag = Object.assign(() => undefined, copyTag())
    equal(isServiceTag(callableTag), true)
    for (const variant of tagVariants) equal(isServiceTag(variant), false)

    const task = ResultTask.succeed(1)
    equal(isResultTask(task), true)
    equal(isResultTask({ [ResultTaskTypeId]: undefined }), false)

    const execute = (value: unknown) =>
      ResultTask.runExit(
        ResultTask.gen(function* () {
          yield value as never
          return 'done'
        }) as never,
      )

    const malformedTaskYields: unknown[] = [
      { [ResultTaskYieldTypeId]: Symbol('wrong'), _tag: 'ResultTask', task },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'WrongTag', task },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'ResultTask', task: {} },
    ]
    for (const value of malformedTaskYields) {
      const exit = await execute(value)
      equal(exit._tag, 'Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
        equal((exit.cause.defect as Error).message, 'ResultTask.gen yielded an unsupported value')
      }
    }

    const malformedServiceYields: unknown[] = [
      { [ResultTaskYieldTypeId]: Symbol('wrong'), _tag: 'Service', tag: validTag },
      { [ResultTaskYieldTypeId]: ResultTaskYieldTypeId, _tag: 'WrongTag', tag: validTag },
      {
        [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
        _tag: 'Service',
        tag: { identifier: 'GuardTag' },
      },
    ]
    for (const value of malformedServiceYields) {
      const exit = await execute(value)
      equal(exit._tag, 'Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
        equal((exit.cause.defect as Error).message, 'ResultTask.gen yielded an unsupported value')
      }
    }
  })

  it('distinguishes malformed ResultTask generator values from Err results', async () => {
    const values: unknown[] = [
      { error: 'not-an-err-result', isErr: 1 },
      { error: 'not-an-err-result', isErr: () => false },
      { isErr: () => true },
    ]
    for (const value of values) {
      const task = ResultTask.gen(function* () {
        yield value as never
        return 'done'
      })
      const exit = await ResultTask.runExit(task as never)
      equal(exit._tag, 'Failure')
      if (exit._tag === 'Failure' && exit.cause._tag === 'Die') {
        equal((exit.cause.defect as Error).message, 'ResultTask.gen yielded an unsupported value')
      }
    }
  })

  it('prefers a symbol-keyed service and honors abort reasons on successful execution', async () => {
    const Tag = serviceTag<string>('SymbolOnly')
    const task = ResultTask.gen(function* () {
      return yield* Tag
    })
    const execute = (task as unknown as { execute: (context: unknown) => Promise<unknown> }).execute
    const signal = new AbortController().signal
    const context = {
      namedServices: new Map(),
      services: new Map([[Tag.key, 'symbol-value']]),
      serviceResolver: () => ResultTask.fail('wrong-resolver'),
      signal,
      scope: new TaskScope(),
    }
    const exit = (await execute(context)) as { _tag: string; value?: unknown }
    equal(exit._tag, 'Success')
    equal(exit.value, 'symbol-value')

    const controller = new AbortController()
    const abortedTask = ResultTask.sync(() => {
      controller.abort('aborted-after-success')
      return 1
    })
    const abortedExit = await ResultTask.runExit(abortedTask, { signal: controller.signal })
    equal(abortedExit._tag, 'Failure')
    if (abortedExit._tag === 'Failure' && abortedExit.cause._tag === 'Interrupt') {
      equal(abortedExit.cause.reason, 'aborted-after-success')
    }
  })

  it('reports missing services and resolver failures in ResultTask.gen', async () => {
    const TagA = serviceTag<string>('ServiceA')

    // Missing service in gen yields MissingServiceError
    const genMissing = ResultTask.gen(function* () {
      const a = yield* TagA
      return a
    })
    const exitMissing = await ResultTask.runExit(genMissing as never)
    equal(exitMissing._tag, 'Failure')
    if (exitMissing._tag === 'Failure' && exitMissing.cause._tag === 'Die') {
      equal(exitMissing.cause.defect instanceof MissingServiceError, true)
      equal((exitMissing.cause.defect as MissingServiceError).serviceIdentifier, 'ServiceA')
    }

    // Resolver returning task that fails with typed error
    const genFailResolver = ResultTask.gen(function* () {
      const a = yield* TagA
      return a
    })
    const taskFailResolver = ResultTask.provideServiceResolver(genFailResolver, {
      ServiceA: () => ResultTask.fail('resolver-failed'),
    })
    const exitFail = await ResultTask.runExit(taskFailResolver)
    equal(exitFail._tag, 'Failure')
    if (exitFail._tag === 'Failure' && exitFail.cause._tag === 'Fail') {
      equal(exitFail.cause.error, 'resolver-failed')
    }

    // Resolver returning task that throws synchronously
    const genThrowResolver = ResultTask.gen(function* () {
      const a = yield* TagA
      return a
    })
    const taskThrowResolver = ResultTask.provideServiceResolver(genThrowResolver, {
      ServiceA: () => {
        throw new Error('resolver sync boom')
      },
    })
    const exitThrow = await ResultTask.runExit(taskThrowResolver)
    equal(exitThrow._tag, 'Failure')
    if (exitThrow._tag === 'Failure' && exitThrow.cause._tag === 'Die') {
      equal((exitThrow.cause.defect as Error).message, 'resolver sync boom')
    }

    // Resolver returning undefined (falls back to Missing)
    const taskUndefResolver = ResultTask.provideServiceResolver(genMissing, {
      ServiceA: () => undefined as unknown as ResultTask<string>,
    })
    const exitUndef = await ResultTask.runExit(taskUndefResolver)
    equal(exitUndef._tag, 'Failure')
    if (exitUndef._tag === 'Failure' && exitUndef.cause._tag === 'Die') {
      equal(exitUndef.cause.defect instanceof MissingServiceError, true)
    }
  })

  it('supports yielded Result values in ResultTask.gen', async () => {
    // Yielding an Err result in gen
    const genErr = ResultTask.gen(function* () {
      yield* err('yielded-err') as unknown as Iterable<never>
      return 42
    })
    const exitErr = await ResultTask.runExit(genErr as never)
    equal(exitErr._tag, 'Failure')
    if (exitErr._tag === 'Failure' && exitErr.cause._tag === 'Fail') {
      equal(exitErr.cause.error, 'yielded-err')
    }

    // A plain Err yielded directly must use the Err guard, without delegation.
    const directErr = ResultTask.gen(function* () {
      yield err('direct-err') as never
      return 42
    })
    const directErrExit = await ResultTask.runExit(directErr as never)
    equal(directErrExit._tag, 'Failure')
    if (directErrExit._tag === 'Failure' && directErrExit.cause._tag === 'Fail') {
      equal(directErrExit.cause.error, 'direct-err')
    }
  })

  it('retains body failures through successful finally cleanup in gen', async () => {
    // A successful resolver in a generator finally block must resume cleanup and retain the
    // original failure that caused the generator to close.
    const CleanupTag = serviceTag<string>('CleanupTag')
    let cleanupValue = ''
    const closing = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('body-failure')
      } finally {
        cleanupValue = yield* CleanupTag
      }
    })
    const resolvedClosing = ResultTask.provideServiceResolver(closing, {
      CleanupTag: () => ResultTask.succeed('cleanup-ok'),
    })
    const closingExit = await ResultTask.runExit(resolvedClosing)
    equal(cleanupValue, 'cleanup-ok')
    equal(closingExit._tag, 'Failure')
    if (closingExit._tag !== 'Failure') throw new Error('expected generator cleanup failure')
    equal(closingExit.cause._tag, 'Fail')
    if (closingExit.cause._tag !== 'Fail') throw new Error('expected typed cleanup failure')
    equal(closingExit.cause.error, 'body-failure')

    const failedClosing = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('body-failure')
      } finally {
        yield* CleanupTag
      }
    })
    const failedClosingExit = await ResultTask.runExit(
      ResultTask.provideServiceResolver(failedClosing, {
        CleanupTag: () => ResultTask.fail('cleanup-failure'),
      }),
    )
    equal(failedClosingExit._tag, 'Failure')
    if (failedClosingExit._tag !== 'Failure') throw new Error('expected resolver cleanup failure')
    equal(failedClosingExit.cause._tag, 'Fail')
    if (failedClosingExit.cause._tag !== 'Fail') throw new Error('expected typed resolver failure')
    equal(failedClosingExit.cause.error, 'cleanup-failure')
  })

  it('preserves cleanup failures and defects in gen finally blocks', async () => {
    const CleanupTag = serviceTag<string>('CleanupTag')
    const throwingClosing = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('body-failure')
      } finally {
        yield* CleanupTag
      }
    })
    const throwingClosingExit = await ResultTask.runExit(
      ResultTask.provideServiceResolver(throwingClosing, {
        CleanupTag: () => {
          throw new Error('cleanup-resolver-throw')
        },
      }),
    )
    equal(throwingClosingExit._tag, 'Failure')
    if (throwingClosingExit._tag !== 'Failure') throw new Error('expected throwing cleanup failure')
    equal(throwingClosingExit.cause._tag, 'Die')
    if (throwingClosingExit.cause._tag !== 'Die') throw new Error('expected cleanup defect')
    equal((throwingClosingExit.cause.defect as Error).message, 'cleanup-resolver-throw')

    const errClosing = ResultTask.gen(function* () {
      try {
        yield* ResultTask.fail('body-failure')
      } finally {
        yield err('cleanup-err')
      }
    })
    const errClosingExit = await ResultTask.runExit(errClosing as never)
    equal(errClosingExit._tag, 'Failure')
    if (errClosingExit._tag !== 'Failure') throw new Error('expected err cleanup failure')
    equal(errClosingExit.cause._tag, 'Fail')
    if (errClosingExit.cause._tag !== 'Fail') throw new Error('expected typed err cleanup failure')
    equal(errClosingExit.cause.error, 'cleanup-err')

    // A resolver property that is present but undefined follows the missing-service path.
    const TagA = serviceTag<string>('ServiceA')
    const genMissing = ResultTask.gen(function* () {
      const a = yield* TagA
      return a
    })
    const undefinedResolver = ResultTask.provideServiceResolver(
      genMissing as never,
      { ServiceA: undefined } as never,
    )
    const undefinedExit = await ResultTask.runExit(undefinedResolver as never)
    equal(undefinedExit._tag, 'Failure')
    if (undefinedExit._tag === 'Failure' && undefinedExit.cause._tag === 'Die') {
      equal(undefinedExit.cause.defect instanceof MissingServiceError, true)
    }
  })

  it('validates success & failure continuation error boundaries (lines 563-584, 601-633)', async () => {
    // Null is not a thenable and must remain a successful pass-through value.
    equal(
      await ResultTask.runPromise(ResultTask.succeed(10).tap(() => null as unknown as void)),
      10,
    )

    // MapError, TapError, CatchAll do not alter Success value
    const passSuccess = ResultTask.succeed(100)
      .mapError((e) => `mapped-${String(e)}`)
      .tapError(() => {
        throw new Error('should not tap success')
      })
      .catchAll(() => ResultTask.succeed(999))
    equal(await ResultTask.runPromise(passSuccess), 100)

    // Map, FlatMap, Tap do not alter Failure
    const passFailure = ResultTask.fail('fail-msg')
      .map(() => 999)
      .flatMap(() => ResultTask.succeed(999))
      .tap(() => {
        throw new Error('should not tap failure')
      })
    const exitPassFail = await ResultTask.runExit(passFailure)
    equal(exitPassFail._tag, 'Failure')
    if (exitPassFail._tag === 'Failure' && exitPassFail.cause._tag === 'Fail') {
      equal(exitPassFail.cause.error, 'fail-msg')
    }

    // Tap returning a Promise that resolves or rejects (lines 745-755)
    let promiseTapped = false
    const tapPromise = ResultTask.succeed(10).tap(async () => {
      await Promise.resolve()
      promiseTapped = true
    })
    equal(await ResultTask.runPromise(tapPromise), 10)
    equal(promiseTapped, true)

    const tapPromiseReject = ResultTask.succeed(10).tap(async () => {
      await Promise.resolve()
      throw new Error('tap promise rejected')
    })
    const exitReject = await ResultTask.runExit(tapPromiseReject)
    equal(exitReject._tag, 'Failure')
    if (exitReject._tag === 'Failure' && exitReject.cause._tag === 'Die') {
      equal((exitReject.cause.defect as Error).message, 'tap promise rejected')
    }

    const dieTapError = ResultTask.sync(() => {
      throw new Error('original die')
    }).tapError(() => {
      throw new Error('must not tap die')
    })
    const dieTapExit = await ResultTask.runExit(dieTapError)
    equal(dieTapExit._tag, 'Failure')
    if (dieTapExit._tag === 'Failure' && dieTapExit.cause._tag === 'Die') {
      equal((dieTapExit.cause.defect as Error).message, 'original die')
    }

    // CatchAll with Sequential Cause (line 627)
    const seqExit = {
      _tag: 'Failure' as const,
      cause: {
        _tag: 'Sequential' as const,
        all: [
          { _tag: 'Fail' as const, error: 'err1' },
          { _tag: 'Fail' as const, error: 'err2' },
        ],
      },
    }
    const directTask = new (ResultTask as unknown as new (fn: unknown) => ResultTask<unknown>)(
      () => seqExit,
    )
    const catchAllSeq = directTask.catchAll(() => ResultTask.succeed('recovered'))
    const exitSeq = await ResultTask.runExit(catchAllSeq as never)
    equal(exitSeq._tag, 'Failure')
    if (exitSeq._tag === 'Failure' && exitSeq.cause._tag === 'Die') {
      equal(exitSeq.cause.defect instanceof ResultTaskCauseError, true)
    }
  })

  it('applies success continuations exactly once and preserves their defects', async () => {
    const mapBoom = new Error('map throw')
    let mapCalls = 0
    const mapThrow = ResultTask.succeed(10).map(() => {
      mapCalls += 1
      throw mapBoom
    })
    const exitMapThrow = await ResultTask.runExit(mapThrow)
    equal(mapCalls, 1)
    equal(exitMapThrow._tag, 'Failure')
    if (exitMapThrow._tag === 'Failure') {
      equal(exitMapThrow.cause._tag, 'Die')
      if (exitMapThrow.cause._tag === 'Die') {
        strictEqual(exitMapThrow.cause.defect, mapBoom)
      }
    }

    const flatMapBoom = new Error('flatmap throw')
    let flatMapCalls = 0
    const flatMapThrow = ResultTask.succeed(10).flatMap(() => {
      flatMapCalls += 1
      throw flatMapBoom
    })
    const exitFlatMapThrow = await ResultTask.runExit(flatMapThrow as never)
    equal(flatMapCalls, 1)
    equal(exitFlatMapThrow._tag, 'Failure')
    if (exitFlatMapThrow._tag === 'Failure') {
      equal(exitFlatMapThrow.cause._tag, 'Die')
      if (exitFlatMapThrow.cause._tag === 'Die') {
        strictEqual(exitFlatMapThrow.cause.defect, flatMapBoom)
      }
    }

    const tapBoom = new Error('tap throw')
    let tapCalls = 0
    const tapThrow = ResultTask.succeed(10).tap(() => {
      tapCalls += 1
      throw tapBoom
    })
    const exitTapThrow = await ResultTask.runExit(tapThrow)
    equal(tapCalls, 1)
    equal(exitTapThrow._tag, 'Failure')
    if (exitTapThrow._tag === 'Failure') {
      equal(exitTapThrow.cause._tag, 'Die')
      if (exitTapThrow.cause._tag === 'Die') {
        strictEqual(exitTapThrow.cause.defect, tapBoom)
      }
    }
  })

  it('applies failure continuations exactly once and preserves their defects', async () => {
    const tapErrorBoom = new Error('tapError boom')
    let tapErrorCalls = 0
    const tapErrorThrow = ResultTask.fail('err').tapError(() => {
      tapErrorCalls += 1
      throw tapErrorBoom
    })
    const exitTapErrThrow = await ResultTask.runExit(tapErrorThrow)
    equal(tapErrorCalls, 1)
    equal(exitTapErrThrow._tag, 'Failure')
    if (exitTapErrThrow._tag === 'Failure') {
      equal(exitTapErrThrow.cause._tag, 'Die')
      if (exitTapErrThrow.cause._tag === 'Die') {
        strictEqual(exitTapErrThrow.cause.defect, tapErrorBoom)
      }
    }

    const catchAllBoom = new Error('catchAll boom')
    let catchAllCalls = 0
    const catchAllThrow = ResultTask.fail('err').catchAll(() => {
      catchAllCalls += 1
      throw catchAllBoom
    })
    const exitCatchAllThrow = await ResultTask.runExit(catchAllThrow as never)
    equal(catchAllCalls, 1)
    equal(exitCatchAllThrow._tag, 'Failure')
    if (exitCatchAllThrow._tag === 'Failure') {
      equal(exitCatchAllThrow.cause._tag, 'Die')
      if (exitCatchAllThrow.cause._tag === 'Die') {
        strictEqual(exitCatchAllThrow.cause.defect, catchAllBoom)
      }
    }
  })

  it('converts a queued success into Interrupt when aborted mid-execution', async () => {
    const controller = new AbortController()
    let mapped = 0
    const task = ResultTask.succeed(1)
      .tap(() => {
        controller.abort('mid-run')
      })
      .map((value) => {
        mapped += 1
        return value + 1
      })
    const exit = await ResultTask.runExit(task, { signal: controller.signal })
    // Aborted tasks stop running queued success continuations.
    equal(mapped, 0)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Interrupt')
      if (exit.cause._tag === 'Interrupt') {
        equal(exit.cause.reason, 'mid-run')
      }
    }
  })

  it('preempts queued failure processing with Interrupt when aborted mid-execution', async () => {
    const controller = new AbortController()
    const task = ResultTask.tryPromise({
      try: async (): Promise<string> => {
        controller.abort('mid-run')
        throw new Error('nope')
      },
      catch: () => 'boom' as const,
    }).map((value) => `${value}!`)
    const exit = await ResultTask.runExit(task, { signal: controller.signal })
    // An aborted signal preempts the queued failure before continuations run.
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Interrupt')
      if (exit.cause._tag === 'Interrupt') {
        equal(exit.cause.reason, 'mid-run')
      }
    }
  })

  it('reports Interrupt for pre-aborted scope use even when the task would fail', async () => {
    const owner = ResultTask.makeScope()
    const controller = new AbortController()
    controller.abort('pre-aborted')
    const exit = await ResultTask.runExit(owner.use(ResultTask.fail('task-error')), {
      signal: controller.signal,
    })
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Interrupt')
      if (exit.cause._tag === 'Interrupt') {
        equal(exit.cause.reason, 'pre-aborted')
      }
    }
    await ResultTask.runExit(owner.close())
  })

  it('rejects executions in closed scopes with the documented defect', async () => {
    const owner = ResultTask.makeScope()

    // Test that closed scope returns died with exact message
    const closePromise = ResultTask.runExit(owner.close())
    const closeExit = await closePromise
    equal(closeExit._tag, 'Success')

    // Executing in closed scope (line 1275)
    const closedExec = await ResultTask.runExit(owner.use(ResultTask.succeed(1)))
    equal(closedExec._tag, 'Failure')
    if (closedExec._tag === 'Failure' && closedExec.cause._tag === 'Die') {
      equal(
        (closedExec.cause.defect as Error).message,
        'Cannot execute in a closed ResultTask scope',
      )
    }
  })

  it('rolls back pending acquisitions and propagates cleanup failures on close', async () => {
    // Fresh scope for pending execution and close error handling
    const owner2 = ResultTask.makeScope()
    let resourceFinalized = false
    const gate = Promise.withResolvers<{ _tag: 'Success'; value: string }>()
    const hangingTask = new (ResultTask as unknown as new (
      execute: unknown,
    ) => ResultTask<string, never, never>)(() => gate.promise)

    const acquireHanging = ResultTask.acquireRelease({
      acquire: hangingTask,
      release: () =>
        ResultTask.sync(() => {
          resourceFinalized = true
        }),
    })

    const usePromise = ResultTask.runExit(owner2.use(acquireHanging))
    // Close while use is in flight
    let closeCompleted = false
    const closeTaskPromise = ResultTask.runExit(owner2.close()).then((res) => {
      closeCompleted = true
      return res
    })

    // At this point, close has aborted controller and is waiting for pending
    equal(closeCompleted, false)
    gate.resolve({ _tag: 'Success', value: 'done' })
    await usePromise
    const closeRes = await closeTaskPromise
    equal(closeCompleted, true)
    equal(closeRes._tag, 'Success')
    equal(resourceFinalized, true)

    // Test close failure propagation when cleanup fails (lines 1308)
    const owner3 = ResultTask.makeScope()
    const failingFinalizerResource = ResultTask.acquireRelease({
      acquire: ResultTask.succeed('ok'),
      release: () =>
        ResultTask.sync(() => {
          throw new Error('finalizer failed')
        }),
    })
    await ResultTask.runExit(owner3.use(failingFinalizerResource))
    const closeWithFail = await ResultTask.runExit(owner3.close())
    equal(closeWithFail._tag, 'Failure')

    // `close(exit)` is cleanup-only: a successful cleanup must not leak the body exit.
    const owner3b = ResultTask.makeScope()
    const bodyExit = { _tag: 'Failure' as const, cause: { _tag: 'Fail' as const, error: 'body' } }
    await ResultTask.runExit(
      owner3b.use(
        ResultTask.acquireRelease({
          acquire: ResultTask.succeed('owned'),
          release: () => ResultTask.succeed(undefined),
        }),
      ),
    )
    const cleanupOnly = await ResultTask.runExit(owner3b.close(bodyExit))
    equal(cleanupOnly._tag, 'Success')
  })

  it('aborts owned executions with the documented reason and cleans up listeners', async () => {
    // The scope controller aborts owned executions with its documented reason.
    const ownerReason = ResultTask.makeScope()
    let ownerAbortReason: unknown = undefined
    const waiting = ResultTask.tryPromise({
      try: (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              ownerAbortReason = signal.reason
              resolve()
            },
            { once: true },
          )
        }),
      catch: (cause) => cause,
    })
    const waitingPromise = ResultTask.runExit(ownerReason.use(waiting))
    await ResultTask.runExit(ownerReason.close())
    await waitingPromise
    equal(ownerAbortReason, 'ResultTask scope closed')

    // Abort listener cleanup in use (lines 1291-1294)
    const owner4 = ResultTask.makeScope()
    const ac = new AbortController()
    const resultVal = await ResultTask.runPromise(owner4.use(ResultTask.succeed('clean-run')), {
      signal: ac.signal,
    })
    equal(resultVal, 'clean-run')
    await ResultTask.runExit(owner4.close())
  })

  it('validates curried combinators and method overloads (lines 1410, 1433, 1456)', async () => {
    // curried flatMap
    const curriedFlatMap = ResultTask.flatMap((x: number) => ResultTask.succeed(x * 2))
    const resFlatMap = await ResultTask.runPromise(curriedFlatMap(ResultTask.succeed(21)))
    equal(resFlatMap, 42)

    // curried andThen
    const curriedAndThen = ResultTask.andThen((x: number) => ResultTask.succeed(x + 5))
    const resAndThen = await ResultTask.runPromise(curriedAndThen(ResultTask.succeed(37)))
    equal(resAndThen, 42)

    // curried catchAll
    const curriedCatchAll = ResultTask.catchAll((err: string) =>
      ResultTask.succeed(`caught: ${err}`),
    )
    const resCatchAll = await ResultTask.runPromise(curriedCatchAll(ResultTask.fail('oops')))
    equal(resCatchAll, 'caught: oops')
  })

  it('validates fromResultAsync signal abortion before and after execution (lines 1567, 1578)', async () => {
    // Pre-aborted signal with factory (lines 1567-1569): the factory must not run
    const acPre = new AbortController()
    acPre.abort('pre-aborted')
    let preAbortedFactoryCalls = 0
    const taskPre = ResultTask.fromResultAsync(() => {
      preAbortedFactoryCalls += 1
      return okAsync('val')
    })
    const exitPre = await ResultTask.runExit(taskPre, { signal: acPre.signal })
    equal(preAbortedFactoryCalls, 0)
    equal(exitPre._tag, 'Failure')
    if (exitPre._tag === 'Failure') {
      equal(exitPre.cause._tag, 'Interrupt')
    }

    // Aborted while asyncResult is awaiting (lines 1578-1580)
    const acMid = new AbortController()
    const taskMid = ResultTask.fromResultAsync(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            acMid.abort('mid-aborted')
            resolve({ isOk: () => true, value: 'done' })
          }, 10)
        }) as never,
    )
    const exitMid = await ResultTask.runExit(taskMid, { signal: acMid.signal })
    equal(exitMid._tag, 'Failure')
    if (exitMid._tag === 'Failure') {
      equal(exitMid.cause._tag, 'Interrupt')
    }
  })

  it('validates runResult with Interruption throws AbortError (line 1628)', async () => {
    const ac = new AbortController()
    ac.abort('custom-reason')
    const task = ResultTask.sync(() => 'ok')
    await ResultTask.runResult(task, { signal: ac.signal }).then(
      () => {
        throw new Error('should have rejected')
      },
      (error: unknown) => {
        const rejection = error as {
          readonly name: unknown
          readonly message: unknown
          readonly cause: unknown
        }
        equal(rejection.name, 'AbortError')
        equal(rejection.message, 'ResultTask execution interrupted')
        equal(rejection.cause, 'custom-reason')
      },
    )
  })

  it('validates provideService preserves prior context services (lines 1168, 1169)', async () => {
    const Tag1 = serviceTag<string>('S1')
    const Tag2 = serviceTag<number>('S2')

    const task = ResultTask.gen(function* () {
      const s1 = yield* Tag1
      const s2 = yield* Tag2
      return `${s1}-${s2}`
    })

    const withS1 = ResultTask.provideService(task, Tag1, 'first')
    const withBoth = ResultTask.provideService(withS1, Tag2, 42)

    const res = await ResultTask.runPromise(withBoth)
    equal(res, 'first-42')
  })

  it('keeps symbol-keyed services isolated when identifiers collide', async () => {
    const First = serviceTag<string>('same-identifier')
    const Second = serviceTag<number>('same-identifier')
    const task = ResultTask.gen(function* () {
      const first = yield* First
      const second = yield* Second
      return `${first}:${second}`
    })
    const provided = ResultTask.provideService(
      ResultTask.provideService(task as never, First as never, 'first' as never),
      Second as never,
      2 as never,
    )
    equal(await ResultTask.runPromise(provided as never), 'first:2')

    const Original = serviceTag<string>('named-fallback')
    const Clone: Record<PropertyKey, unknown> = {}
    // eslint-disable-next-line unicorn/no-immediate-mutation -- object spread is banned repo-wide; the literal-assign form trips prefer-object-spread instead.
    Object.assign(Clone, Original, {
      key: Symbol('different-key'),
      [Symbol.iterator]: Original[Symbol.iterator],
    })
    const cloneTask = ResultTask.gen(function* () {
      return yield* Clone as unknown as typeof Original
    })
    const cloneProvided = ResultTask.provideService(
      cloneTask as never,
      Original as never,
      'named' as never,
    )
    equal(await ResultTask.runPromise(cloneProvided as never), 'named')
  })

  it('distinguishes typed failures, defects, and interruptions at runResult', async () => {
    const typed = await ResultTask.runResult(ResultTask.fail('typed-failure'))
    equal(typed.isErr(), true)
    if (typed.isErr()) equal(typed.error, 'typed-failure')

    await ResultTask.runResult(
      ResultTask.sync(() => {
        throw new Error('runResult defect')
      }),
    ).then(
      () => {
        throw new Error('expected runResult to reject defects')
      },
      (error: unknown) => equal((error as Error).message, 'runResult defect'),
    )
  })

  it('preserves tryPromise overload semantics and avoids invoking a pre-aborted factory', async () => {
    const functionFailure = await ResultTask.runResult(
      ResultTask.tryPromise(() => Promise.reject(new Error('function failure'))),
    )
    equal(functionFailure.isErr(), true)
    if (functionFailure.isErr()) equal((functionFailure.error as Error).message, 'function failure')

    const optionFailure = await ResultTask.runResult(
      ResultTask.tryPromise({
        try: () => Promise.reject(new Error('option failure')),
        catch: () => 'mapped-option-failure' as const,
      }),
    )
    equal(optionFailure.isErr(), true)
    if (optionFailure.isErr()) equal(optionFailure.error, 'mapped-option-failure')

    const controller = new AbortController()
    controller.abort('pre-aborted')
    let called = false
    const preAborted = ResultTask.fromResultAsync(() => {
      called = true
      return okAsync('value')
    })
    const exit = await ResultTask.runExit(preAborted, { signal: controller.signal })
    equal(called, false)
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') equal(exit.cause._tag, 'Interrupt')
  })

  it('validates makeScope abort listener triggering during in-flight use execution (lines 1286-1294, 1620-1628)', async () => {
    const owner = ResultTask.makeScope()
    const ac = new AbortController()
    let rejectHanging: (() => void) | undefined = undefined

    const slowTask = new (ResultTask as unknown as new (
      execute: unknown,
    ) => ResultTask<never, never, never>)(
      () =>
        new Promise<never>((_, rej) => {
          rejectHanging = rej
        }),
    )

    const usePromise = ResultTask.runExit(owner.use(slowTask), { signal: ac.signal })
    ac.abort('aborted-during-flight')
    const exit = await usePromise
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      equal(exit.cause._tag, 'Interrupt')
    }
    ;(rejectHanging as (() => void) | undefined)?.()
    await ResultTask.runExit(owner.close())
  })

  it('returns an interruption from the fromResultAsync executor after an in-flight abort', async () => {
    const controller = new AbortController()
    let resolveResult: ((result: unknown) => void) | undefined = undefined
    const task = ResultTask.fromResultAsync(
      () =>
        new Promise((resolve) => {
          resolveResult = resolve
        }) as never,
    )
    const execute = (task as unknown as { execute: (context: unknown) => Promise<unknown> }).execute
    const pending = execute({
      namedServices: new Map(),
      services: new Map(),
      serviceResolver: undefined,
      signal: controller.signal,
      scope: new TaskScope(),
    })
    controller.abort('executor-aborted')
    ;(resolveResult as ((result: unknown) => void) | undefined)?.(okAsync('value'))
    const exit = (await pending) as { _tag: string; cause?: { _tag: string; reason?: unknown } }
    equal(exit._tag, 'Failure')
    if (exit.cause?._tag === 'Interrupt') equal(exit.cause.reason, 'executor-aborted')
  })

  it('short-circuits the fromResultAsync executor before invoking a pre-aborted factory', async () => {
    const controller = new AbortController()
    controller.abort('executor-pre-aborted')
    let called = false
    const task = ResultTask.fromResultAsync(() => {
      called = true
      return okAsync('value')
    })
    const execute = (task as unknown as { execute: (context: unknown) => Promise<unknown> }).execute
    const exit = (await execute({
      namedServices: new Map(),
      services: new Map(),
      serviceResolver: undefined,
      signal: controller.signal,
      scope: new TaskScope(),
    })) as { _tag: string; cause?: { _tag: string; reason?: unknown } }
    equal(called, false)
    equal(exit._tag, 'Failure')
    if (exit.cause?._tag === 'Interrupt') equal(exit.cause.reason, 'executor-pre-aborted')
  })

  it('interrupts a successful continuation when the signal aborts during the callback', async () => {
    const controller = new AbortController()
    const task = ResultTask.succeed(1).map(() => {
      controller.abort('continuation-aborted')
      return 2
    })
    const exit = await ResultTask.runExit(task, { signal: controller.signal })
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure' && exit.cause._tag === 'Interrupt') {
      equal(exit.cause.reason, 'continuation-aborted')
    }
  })
})

describe('TaggedError symbol template formatting', () => {
  it('formats Symbol without description using symbol.toString()', () => {
    class SymbolTemplateError extends createTaggedError({
      message: 'Token $token failed',
      name: 'SymbolTemplateError',
    }) {}

    const globalObj = globalThis as unknown as { Symbol: (desc?: string) => symbol }
    const anonymousSymbol = globalObj.Symbol()
    const error = new SymbolTemplateError({ token: anonymousSymbol as unknown as string })
    equal(error.message, 'Token Symbol() failed')
  })
})
