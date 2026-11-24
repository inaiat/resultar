import { deepEqual, equal, ok as assertOk, rejects, throws } from 'node:assert'

import { afterEach, describe, it, vi } from 'vite-plus/test'

import { canUseJit } from '../src/core/jit.js'
import {
  Cause,
  err,
  Fiber,
  Match,
  ok,
  Result,
  ResultTask,
  ResultTaskCauseError,
  Retry,
} from '../src/index.js'
import {
  compileMatcher,
  parseTableCaseIr,
  resolveCaseIr,
  type MatchCaseIr,
  type MatchHandler,
} from '../src/match/match-jit.js'
import {
  compileTaskChain,
  OP_MAP,
  OP_SUCCESS,
  type TaskJitHelpers,
  type TaskNodeLike,
} from '../src/task/task-jit.js'
import { createRuntimeTask, runRuntimeTask } from '../src/task/task-runtime-bridge.js'

const withJit = <T>(enabled: boolean, run: () => T): T => {
  const previous = process.env['RESULTAR_JIT']
  process.env['RESULTAR_JIT'] = enabled ? '1' : '0'
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env['RESULTAR_JIT']
    else process.env['RESULTAR_JIT'] = previous
  }
}

const abortAfterFirstRead = (reason: string): AbortSignal => {
  let reads = 0
  return {
    get aborted() {
      reads += 1
      return reads > 1
    },
    reason,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal
}

interface DynamicMatcherApi {
  readonly whenOr: (...args: readonly unknown[]) => DynamicMatcherApi
  readonly whenAnd: (...args: readonly unknown[]) => DynamicMatcherApi
  readonly tag: (...args: readonly unknown[]) => DynamicMatcherApi
  readonly orElse: (fallback: (value: unknown) => unknown) => (input: unknown) => unknown
}

afterEach(() => {
  delete process.env['RESULTAR_JIT']
})

describe('core/jit and task runtime bridge coverage', () => {
  it('falls back safely when reading process.env throws during JIT capability check', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'process')
    try {
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        get(): never {
          throw new Error('restricted-env')
        },
      })
      equal(canUseJit(), true)
    } finally {
      if (desc !== undefined) {
        Object.defineProperty(globalThis, 'process', desc)
      }
    }
  })

  it('throws when task runtime bridge is invoked for an unregistered owner', () => {
    const unregistered = {}
    throws(
      () => createRuntimeTask(unregistered, () => ({ _tag: 'Success', value: 1 })),
      /ResultTask runtime has not initialized/u,
    )
    throws(
      () => runRuntimeTask(unregistered, ResultTask.ok(1), {} as never),
      /ResultTask runtime has not initialized/u,
    )
  })

  it('reuses the global NEVER_ABORTED_SIGNAL when exit module is reloaded', async () => {
    const first = await import('../src/task/exit.js')
    vi.resetModules()
    const reloaded = await import('../src/task/exit.js')
    equal(reloaded.NEVER_ABORTED_SIGNAL, first.NEVER_ABORTED_SIGNAL)
  })
})

describe('Match and match-jit coverage', () => {
  it('exercises all builtin predicates on eager Match.value and result/option outcomes', () => {
    const sym = Symbol('match')
    const now = new Date()
    equal(
      Match.value(true)
        .when(Match.boolean, () => 'bool')
        .orElse(() => 'no'),
      'bool',
    )
    equal(
      Match.value(10n)
        .when(Match.bigint, () => 'bi')
        .orElse(() => 'no'),
      'bi',
    )
    equal(
      Match.value(sym)
        .when(Match.symbol, () => 'sym')
        .orElse(() => 'no'),
      'sym',
    )
    equal(
      Match.value(null)
        .when(Match.null, () => 'nil')
        .orElse(() => 'no'),
      'nil',
    )
    equal(
      Match.value(now)
        .when(Match.date, () => 'dt')
        .orElse(() => 'no'),
      'dt',
    )
    equal(
      Match.value({ a: 1 })
        .when(Match.record, () => 'rec')
        .orElse(() => 'no'),
      'rec',
    )
    equal(
      Match.value([1])
        .when(Match.record, () => 'rec')
        .orElse(() => 'no'),
      'no',
    )
    equal(
      Match.value(null)
        .when(Match.record, () => 'rec')
        .orElse(() => 'no'),
      'no',
    )
    equal(
      Match.value(123)
        .when(Match.defined, () => 'def')
        .orElse(() => 'no'),
      'def',
    )
    equal(
      Match.value(null)
        .when(Match.defined, () => 'def')
        .orElse(() => 'no'),
      'no',
    )
    equal(
      Match.value(undefined)
        .when(Match.defined, () => 'def')
        .orElse(() => 'no'),
      'no',
    )
    equal(
      Match.value('anything')
        .when(Match.any, () => 'any')
        .orElse(() => 'no'),
      'any',
    )

    deepEqual(
      Match.value<number>(1)
        .when(1, () => 'one')
        .option(),
      { _tag: 'Some', value: 'one' },
    )
    deepEqual(
      Match.value<number>(2)
        .when(1, () => 'one')
        .option(),
      { _tag: 'None' },
    )
    deepEqual(
      Match.value<number>(2)
        .when(1, () => 'one')
        .result(),
      err(2),
    )
  })

  it('covers Match.valueTags direct call edge cases (function, null, numeric tag, symbol tag)', () => {
    const rawValueTags = Match.valueTags as unknown as (input: unknown, handlers: object) => unknown
    const fnTagged = Object.assign(() => undefined, { _tag: 'Fn' as const })
    equal(rawValueTags(fnTagged, { Fn: () => 'fn' }), 'fn')
    equal(rawValueTags({ _tag: 1 }, { '1': () => 'one' }), 'one')

    const symTag = Symbol('tag')
    equal(rawValueTags({ _tag: symTag }, { [symTag]: () => 'sym' }), 'sym')
    throws(() => rawValueTags(null, { A: () => 1 }), /no case matched/u)
  })

  it('covers match-jit IR parsing, eager evaluation, and unknown IR fallbacks', () => {
    throws(
      () => parseTableCaseIr('_tag', { A: 'not-a-function' }),
      /Match handlers must be functions/u,
    )

    equal(
      Match.value('not-arr')
        .when([1, 2] as never, () => 'hit')
        .orElse(() => 'miss'),
      'miss',
    )
    equal(
      Match.value([1])
        .when([1, 2] as never, () => 'hit')
        .orElse(() => 'miss'),
      'miss',
    )
    equal(
      Match.value([1, 9])
        .when([1, 2] as never, () => 'hit')
        .orElse(() => 'miss'),
      'miss',
    )
    // eslint-disable-next-line no-sparse-arrays
    const sparsePattern = [1, , 3] as unknown as readonly number[]
    equal(
      Match.value([1, 999, 3])
        .when(sparsePattern as never, () => 'hit')
        .orElse(() => 'miss'),
      'hit',
    )
    equal(
      Match.value<number>(2)
        .whenOr(1, 2, () => 'or-hit')
        .orElse(() => 'miss'),
      'or-hit',
    )
    equal(
      Match.value({ _tag: 'Missing' } as { readonly _tag: 'A' | 'Missing' })
        .tags({ A: () => 'a' })
        .orElse(() => 'miss'),
      'miss',
    )

    const handler: MatchHandler = () => 'ok'
    equal(
      resolveCaseIr({ kind: 'pattern', pattern: { kind: 'unknown' } as never, handler }, 123),
      undefined,
    )
    equal(resolveCaseIr({ kind: 'unknown' } as never, 123), undefined)
  })

  it('covers match-jit CSP fallback mode for large tag tables/sets, result/option, and fn/context', () => {
    withJit(false, () => {
      const table = Match.type<{ readonly _tag: 'a' | 'b' | 'c' | 'd' | '1' }>()
        .tags({ a: () => 'A', b: () => 'B', c: () => 'C', d: () => 'D', '1': () => 'ONE' })
        .orElse(() => 'other')
      equal(table({ _tag: 'a' }), 'A')
      equal(table({ _tag: 1 as unknown as '1' }), 'ONE')
      equal(table({ _tag: 'z' as unknown as 'a' }), 'other')

      const tagSet = Match.type<{ readonly _tag: string }>()
        .tag('a', 'b', 'c', 'd', 'e', () => 'in-set')
        .orElse(() => 'out')
      equal(tagSet({ _tag: 'e' }), 'in-set')
      equal(tagSet({ _tag: 'x' }), 'out')

      const typeRes = Match.type<number>()
        .when(1, () => 'one')
        .result()
      const typeOpt = Match.type<number>()
        .when(1, () => 'one')
        .option()
      deepEqual(typeRes(2), err(2))
      deepEqual(typeOpt(2), { _tag: 'None' })

      const fnZero = Match.fn(() => 2)
        .when(1, () => 'one')
        .orElse(() => 'fb0')
      equal(fnZero(), 'fb0')
      const fnArgs = Match.fn((x: number) => x)
        .when(1, () => 'one')
        .orElse((v, a) => `${v}:${a}`)
      equal(fnArgs(2), '2:2')

      const ctxRes = Match.context<number, [number]>()
        .when(1, () => 'one')
        .result()
      const ctxOpt = Match.context<number, [number]>()
        .when(1, () => 'one')
        .option()
      deepEqual(ctxRes(2, 9), err(2))
      deepEqual(ctxOpt(2, 9), { _tag: 'None' })
    })
  })

  it('covers match-jit codegen branches for keys, literals, builtins, empty containers, and tag cases', () => {
    withJit(true, () => {
      const sym = Symbol('lit')
      const literalMatcher = Match.type<bigint | symbol | { readonly x: number }>()
        .when(10n, () => 'ten')
        .when(sym, () => 'sym')
        .when({ x: Number.NaN }, () => 'nan-prop')
        .orElse(() => 'miss')
      equal(literalMatcher(10n), 'ten')
      equal(literalMatcher(sym), 'sym')
      equal(literalMatcher({ x: Number.NaN }), 'miss')

      const nestedBuiltin = Match.type<{ readonly a: unknown; readonly b?: string | null }>()
        .when({ a: Match.any, b: Match.defined }, () => 'defined-b')
        .orElse(() => 'other')
      equal(nestedBuiltin({ a: 1, b: 'ok' }), 'defined-b')
      equal(nestedBuiltin({ a: 1, b: null }), 'other')

      const emptyMatcher = Match.type<unknown>()
        .when([], () => 'arr')
        .when({}, () => 'obj')
        .orElse(() => 'other')
      equal(emptyMatcher([]), 'arr')
      equal(emptyMatcher({}), 'obj')

      const numericTable = Match.type<{ readonly _tag: '1' | '2' }>()
        .tags({ '1': () => 'one', '2': () => 'two' })
        .orElse(() => 'other')
      equal(numericTable({ _tag: 1 as unknown as '1' }), 'one')
      equal(numericTable({ _tag: '2' }), 'two')
    })
  })

  it('covers match-jit tagSet (0, undefined, NaN, >4 mixed/NaN-only), empty or/and, and compile fallback', () => {
    withJit(true, () => {
      const sym = Symbol('s')
      const dyn = () => Match.type<unknown>() as unknown as DynamicMatcherApi

      const emptyAndOr = dyn()
        .whenOr(() => 'never')
        .tag(() => 'no-tags')
        .whenAnd(() => 'always')
        .orElse(() => 'fb')
      equal(emptyAndOr(1), 'always')

      const undefAndNaN = dyn()
        .tag(undefined, () => 'undef')
        .tag(Number.NaN, () => 'nan-small')
        .orElse(() => 'miss')
      equal(undefAndNaN(null), 'undef')
      equal(undefAndNaN({ _tag: Number.NaN }), 'nan-small')

      const bigMixed = dyn()
        .tag('a', 2, sym, 'b', Number.NaN, () => 'mixed')
        .orElse(() => 'miss')
      equal(bigMixed({ _tag: 'a' }), 'mixed')
      equal(bigMixed({ _tag: 2 }), 'mixed')
      equal(bigMixed({ _tag: sym }), 'mixed')
      equal(bigMixed({ _tag: Number.NaN }), 'mixed')
      equal(bigMixed({ _tag: 'nope' }), 'miss')

      const bigNoNaN = dyn()
        .tag('a', 'b', 'c', 4, sym, () => 'no-nan')
        .orElse(() => 'miss')
      equal(bigNoNaN({ _tag: 4 }), 'no-nan')

      const bigOnlyNaN = dyn()
        .tag(Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, () => 'only-nan')
        .orElse(() => 'miss')
      equal(bigOnlyNaN({ _tag: Number.NaN }), 'only-nan')
    })
  })

  it('covers direct compileMatcher numeric/symbol keys, unknown IR, and late Function fallback', () => {
    withJit(true, () => {
      const keySym = Symbol('k')
      const direct = compileMatcher({
        kind: 'type',
        select: (x) => x,
        outcome: 'direct',
        fallback: () => 'fb',
        builtins: new Map(),
        cases: [
          { kind: 'pattern', pattern: { kind: 'unknown' } as never, handler: () => 'u' },
          { kind: 'unknown' } as unknown as MatchCaseIr,
          { kind: 'tagSet', key: 0, tags: ['hit0'], handler: () => 'zero' },
          { kind: 'tagSet', key: keySym, tags: ['hitSym'], handler: () => 'symKey' },
          { kind: 'tagTable', key: 0, entries: [[1, () => 'numKey']] },
        ],
      })
      equal(direct(['hit0']), 'zero')
      equal(direct({ [keySym]: 'hitSym' }), 'symKey')
      equal(direct([1]), 'numKey')
      equal(direct(['other']), 'fb')

      const origFunction = globalThis.Function
      try {
        ;(globalThis as unknown as { Function: unknown }).Function = function Function() {
          throw new Error('csp-late')
        }
        const lateFallback = Match.type<number>()
          .when(1, () => 'one')
          .orElse(() => 'fb')
        equal(lateFallback(1), 'one')
        equal(lateFallback(2), 'fb')
      } finally {
        ;(globalThis as unknown as { Function: unknown }).Function = origFunction
      }
    })
  })
})

describe('task-jit, fiber-runtime, and task-helpers coverage', () => {
  it('compiles hot tryPromise, OP_ASYNC, and mapErr-with-Die chains in task-jit', async () => {
    const hotTryPromise = ResultTask.tryPromise({
      try: () => Promise.resolve(3),
      catch: () => 'err',
    })
      .map((n) => n + 1)
      .map((n) => n * 2)
    deepEqual(await hotTryPromise.runResult(), ok(8))
    deepEqual(await hotTryPromise.runResult(), ok(8))
    deepEqual(await hotTryPromise.runResult(), ok(8))

    const hotAsync = ResultTask.fromCallback<number, string>({
      subscribe: ({ resolve }) => {
        resolve(5)
      },
    })
      .map((n) => n + 2)
      .map((n) => n * 3)
    deepEqual(await hotAsync.runResult(), ok(21))
    deepEqual(await hotAsync.runResult(), ok(21))
    deepEqual(await hotAsync.runResult(), ok(21))

    const defect = new Error('hot-die')
    const hotMapErrDie = ResultTask.sync<number>(() => {
      throw defect
    })
      .mapErr((e) => `mapped:${String(e)}`)
      .map((n) => n + 1)
    for (let i = 0; i < 3; i += 1) {
      deepEqual(hotMapErrDie.runSyncExit(), { _tag: 'Failure', cause: Cause.die(defect) })
    }
  })

  it('covers task-jit default emitStepCode branch for an unexpected combinator opcode', () => {
    const leaf: TaskNodeLike = {
      op: OP_SUCCESS,
      value: 1,
      continuation: undefined,
      run: () => ({ _tag: 'Success', value: 1 }),
    }
    const step1: TaskNodeLike = {
      op: OP_MAP,
      value: leaf,
      continuation: (n: number) => n + 1,
      run: () => ({ _tag: 'Success', value: 2 }),
    }
    let reads = 0
    const mutatingStep = {
      get op() {
        reads += 1
        return reads <= 3 ? OP_MAP : 999
      },
      value: step1,
      continuation: (n: number) => n,
      run: () => ({ _tag: 'Success', value: 2 }),
    } as unknown as TaskNodeLike

    const compiled = compileTaskChain(mutatingStep, {
      NEVER_ABORTED_SIGNAL: new AbortController().signal,
      success: (value) => ({ _tag: 'Success', value }),
      failed: (error) => ({ _tag: 'Failure', cause: Cause.fail(error) }),
      died: (defect) => ({ _tag: 'Failure', cause: Cause.die(defect) }),
      interrupted: (signal) => ({ _tag: 'Failure', cause: Cause.interrupt(signal.reason) }),
      failure: (cause) => ({ _tag: 'Failure', cause }),
      isResultTask: (_v): _v is TaskNodeLike => false,
      isPromiseExit: (_v): _v is Promise<never> => false,
      executeTryPromise: () => ({ _tag: 'Success', value: undefined }),
      runGen: () => ({ _tag: 'Success', value: undefined }),
      transformCause: (c) => c,
      getTaggedHandler: () => undefined,
      createCauseError: (c) => new ResultTaskCauseError(c),
      runTap: (_n, exit) => exit,
      runSlow: () => ({ _tag: 'Success', value: undefined }),
      createAsyncResumer: () => async () => ({ _tag: 'Success', value: undefined }),
      createSyncResumer: () => () => ({ _tag: 'Success', value: undefined }),
    } satisfies TaskJitHelpers)
    assertOk(typeof compiled === 'function')
  })

  it('covers SupervisedFiber.close when an observed child is still running at scope close', async () => {
    const program = ResultTask.gen(function* () {
      const fiber = yield* ResultTask.sleep(50).forkChild()
      void Fiber.join(fiber).runExit()
      return 'parent-done'
    }).scoped()
    deepEqual(await program.runResult(), ok('parent-done'))
  })

  it('covers afterScheduleHook when a hook aborts synchronously and returns a rejected promise', async () => {
    const controller = new AbortController()
    const exit = await ResultTask.err('retry-me')
      .retry(
        Retry.policy({
          times: 2,
          while: () => {
            controller.abort('hook-abort')
            return Promise.reject(new Error('late-hook-reject'))
          },
        }),
      )
      .runExit({ signal: controller.signal })
    deepEqual(exit, { _tag: 'Failure', cause: Cause.interrupt('hook-abort') })
  })
})

describe('ResultTask generator finally, fast paths, JIT helpers, and fused tryPromise coverage', () => {
  it('covers closeGeneratorAsync errors after first/second async yield and unsupported finally yield', async () => {
    const firstBoom = new Error('finally-after-first-async')
    const exit1 = await ResultTask.gen(function* () {
      try {
        return yield* ResultTask.err('primary')
      } finally {
        yield* ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'c' })
        // eslint-disable-next-line no-unsafe-finally
        throw firstBoom
      }
    }).runExit()
    deepEqual(exit1, { _tag: 'Failure', cause: Cause.die(firstBoom) })

    const secondBoom = new Error('finally-after-second-async')
    const exit2 = await ResultTask.gen(function* () {
      try {
        return yield* ResultTask.err('primary')
      } finally {
        yield* ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'c' })
        yield* ResultTask.tryPromise({ try: () => Promise.resolve(2), catch: () => 'c' })
        // eslint-disable-next-line no-unsafe-finally
        throw secondBoom
      }
    }).runExit()
    deepEqual(exit2, { _tag: 'Failure', cause: Cause.die(secondBoom) })

    const badYieldTask = ResultTask.gen(function* () {
      try {
        return yield* ResultTask.err('primary')
      } finally {
        yield* ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'c' })
        yield 'bad-finally-yield' as unknown as Result<never, string>
      }
    })
    const exit3 = await badYieldTask.runExit()
    equal(exit3._tag, 'Failure')
    if (exit3._tag === 'Failure') {
      const defect = Cause.defects(exit3.cause)[0]
      assertOk(defect instanceof TypeError)
      equal(defect.message, 'ResultTask.gen yielded an unsupported value')
    }
  })

  it('covers fast combinator budget fallbacks, #finishFastCombinator, and #applyMapToSuccess', async () => {
    deepEqual(
      await ResultTask.err({ _tag: 'A' as const })
        .catchTag('A', () => ResultTask.ok(1))
        .runResult({ yieldEvery: 5 }),
      ok(1),
    )
    deepEqual(
      await ResultTask.ok<number, string>(7)
        .orElse(() => ResultTask.ok(0))
        .runResult({ yieldEvery: 5 }),
      ok(7),
    )
    deepEqual(
      await ResultTask.sync(() => 3)
        .orElse(() => ResultTask.ok(0))
        .runResult({ yieldEvery: 4 }),
      ok(3),
    )
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(4), catch: () => 'e' })
        .map((n) => n + 1)
        .runResult({ yieldEvery: 4 }),
      ok(5),
    )

    const c1 = new AbortController()
    const asyncLeaf = ResultTask.ok(1).andThen(() =>
      ResultTask.tryPromise({ try: () => Promise.resolve(9), catch: () => 'e' }),
    )
    deepEqual(await asyncLeaf.runResult({ signal: c1.signal }), ok(9))
    deepEqual(await asyncLeaf.runResult(), ok(9))

    const c2 = new AbortController()
    deepEqual(
      await ResultTask.acquireRelease({
        acquire: ResultTask.ok(2).map((n) => n + 1),
        release: () => ResultTask.ok(undefined),
      })
        .scoped()
        .runResult({ signal: c2.signal }),
      ok(3),
    )
    deepEqual(
      await ResultTask.acquireRelease({
        acquire: asyncLeaf,
        release: () => ResultTask.ok(undefined),
      })
        .scoped()
        .runResult({ signal: c2.signal }),
      ok(9),
    )

    const c3 = new AbortController()
    deepEqual(
      await ResultTask.fromCallback<number, never>({
        subscribe: ({ resolve }) => {
          resolve(1)
        },
      })
        .map((n) => {
          c3.abort('in-map')
          return n + 1
        })
        .runExit({ signal: c3.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('in-map') },
    )
    const mapBoom = new Error('map-boom')
    deepEqual(
      await ResultTask.fromCallback<number, never>({
        subscribe: ({ resolve }) => {
          resolve(1)
        },
      })
        .map(() => {
          throw mapBoom
        })
        .runExit(),
      { _tag: 'Failure', cause: Cause.die(mapBoom) },
    )
  })

  it('covers #finishCatchAll, #finishMappedCatchAll, and fused tryPromise.mapErr.orElse', async () => {
    const c1 = new AbortController()
    deepEqual(
      await ResultTask.sync(() => {
        c1.abort('sync-ok-abort')
        return 1
      })
        .orElse(() => ResultTask.ok(2))
        .runExit({ signal: c1.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('sync-ok-abort') },
    )

    const c2 = new AbortController()
    deepEqual(
      await ResultTask.err('e')
        .orElse(() => {
          c2.abort('res-ok-abort')
          return ok(2)
        })
        .runExit({ signal: c2.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('res-ok-abort') },
    )

    const c3 = new AbortController()
    deepEqual(
      await ResultTask.err('e')
        .orElse(() => {
          c3.abort('task-ok-abort')
          return ResultTask.ok(2)
        })
        .runExit({ signal: c3.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('task-ok-abort') },
    )

    deepEqual(
      await ResultTask.sync(() => 5)
        .orElse(() => ResultTask.ok(0))
        .map((n) => n * 2)
        .runResult(),
      ok(10),
    )
    deepEqual(
      await ResultTask.err<string>('e1')
        .orElse(() => Result.err('e2'))
        .map((n: never) => n)
        .runResult(),
      err('e2'),
    )

    const syncDefect = new Error('sync-die')
    deepEqual(
      await ResultTask.sync<number>(() => {
        throw syncDefect
      })
        .orElse(() => ResultTask.ok(1))
        .runExit(),
      { _tag: 'Failure', cause: Cause.die(syncDefect) },
    )
    deepEqual(
      await ResultTask.sync<number>(() => {
        throw syncDefect
      })
        .orElse(() => ResultTask.ok(1))
        .map((n) => n + 1)
        .runExit(),
      { _tag: 'Failure', cause: Cause.die(syncDefect) },
    )

    deepEqual(
      await ResultTask.tryPromise({
        try: () => Promise.reject(new Error('raw')),
        catch: (e) => (e as Error).message,
      })
        .mapErr((e) => `err:${e}`)
        .orElse((e) => ResultTask.ok(`recovered:${e}`))
        .runResult(),
      ok('recovered:err:raw'),
    )
    deepEqual(
      await ResultTask.tryPromise({
        try: () => Promise.reject(new Error('raw')),
        catch: (e) => (e as Error).message,
      })
        .mapErr((e) => `err:${e}`)
        .orElse((e) => ResultTask.ok(`recovered:${e}`))
        .map((v) => v.toUpperCase())
        .runResult(),
      ok('RECOVERED:ERR:RAW'),
    )
  })

  it('covers JIT helpers: tapError on failure, composite causeError, async/sync resumers', async () => {
    const tapped: string[] = []
    const hotTapErr = ResultTask.err<string>('boom')
      .tapError((e) => {
        tapped.push(e)
      })
      .tap(() => undefined)
      .map((n: never) => n)
    for (let i = 0; i < 3; i += 1) {
      deepEqual(hotTapErr.runSync(), err('boom'))
    }
    deepEqual(tapped, ['boom', 'boom', 'boom'])

    const hotCompositeReal = ResultTask.gen(function* () {
      return yield* ResultTask.err('a').ensuring(() => ResultTask.err('b'))
    })
      .orElse(() => ResultTask.ok(1))
      .map((n) => n + 1)
      .map((n) => n + 1)
    for (let i = 0; i < 3; i += 1) {
      const exit = await hotCompositeReal.runExit()
      equal(exit._tag, 'Failure')
      if (exit._tag === 'Failure') {
        assertOk(Cause.defects(exit.cause)[0] instanceof ResultTaskCauseError)
      }
    }

    const hotLastAsync = ResultTask.ok(1)
      .map((n) => n + 1)
      .andThen((n) =>
        ResultTask.tryPromise({ try: () => Promise.resolve(n * 3), catch: () => 'e' }),
      )
    await hotLastAsync.runResult()
    await hotLastAsync.runResult()
    deepEqual(
      await ResultTask.acquireRelease({
        acquire: hotLastAsync,
        release: () => ResultTask.ok(undefined),
      })
        .scoped()
        .runResult({ signal: new AbortController().signal }),
      ok(6),
    )

    const burnThree = ResultTask.ok(1).map((n) => n + 1)
    const hotResumeMid = ResultTask.ok(0)
      .andThen(() => burnThree)
      .map((n) => n + 10)
      .map((n) => n * 2)
    await hotResumeMid.runResult()
    await hotResumeMid.runResult()
    deepEqual(await hotResumeMid.runResult({ yieldEvery: 10 }), ok(24))

    const hotResumeEnd = ResultTask.ok(0)
      .map((n) => n + 1)
      .andThen(() => burnThree)
    await hotResumeEnd.runResult()
    await hotResumeEnd.runResult()
    deepEqual(
      await ResultTask.acquireRelease({
        acquire: hotResumeEnd,
        release: () => ResultTask.ok(undefined),
      })
        .scoped()
        .runResult({ yieldEvery: 10, signal: new AbortController().signal }),
      ok(2),
    )
  })

  it('covers OP_CUSTOM throws/rejects, acquireRelease pre-abort, async service gen return, and scope runners', async () => {
    const customThrow = ResultTask.ok(1)
    ;(customThrow as unknown as { execute: () => never }).execute = () => {
      throw new Error('custom-sync-boom')
    }
    deepEqual(await customThrow.map((n) => n + 1).runExit(), {
      _tag: 'Failure',
      cause: Cause.die(new Error('custom-sync-boom')),
    })

    const customReject = ResultTask.ok(1)
    ;(customReject as unknown as { execute: () => Promise<never> }).execute = () =>
      Promise.reject(new Error('custom-async-boom'))
    deepEqual(await customReject.map((n) => n + 1).runExit(), {
      _tag: 'Failure',
      cause: Cause.die(new Error('custom-async-boom')),
    })

    deepEqual(
      await ResultTask.acquireRelease({
        acquire: ResultTask.ok(1),
        release: () => ResultTask.ok(undefined),
      }).runExit({ signal: abortAfterFirstRead('stop-acq') }),
      { _tag: 'Failure', cause: Cause.interrupt('stop-acq') },
    )

    const AsyncSvc = ResultTask.service<string, 'AsyncSvc'>('AsyncSvc')
    const svcGen = ResultTask.gen(function* () {
      return yield* AsyncSvc
    })
    deepEqual(
      await ResultTask.provideServiceResolver(svcGen, {
        AsyncSvc: () =>
          ResultTask.tryPromise({ try: () => Promise.resolve('ready'), catch: () => 'e' }),
      }).runResult(),
      ok('ready'),
    )

    const owner = ResultTask.makeScope()
    let nestedReleased = false
    owner.addFinalizer(
      () =>
        ResultTask.acquireRelease({
          acquire: ResultTask.ok(undefined),
          release: () =>
            ResultTask.tryPromise({
              try: async () => {
                await Promise.resolve()
                nestedReleased = true
              },
              catch: () => 'e',
            }),
        }) as unknown as ResultTask<void>,
    )
    await owner.close().runResult()
    equal(nestedReleased, true)
  })

  it('covers no-options runResult/runPromise/runExit sync & async finalizer and catch branches', async () => {
    const asyncFinalizer = () =>
      ResultTask.tryPromise({ try: () => Promise.resolve(), catch: () => 'e' })

    const syncWithAsyncFinalizer = ResultTask.acquireRelease({
      acquire: ResultTask.ok(11),
      release: asyncFinalizer,
    })
    deepEqual(await syncWithAsyncFinalizer.runExit({ signal: new AbortController().signal }), {
      _tag: 'Success',
      value: 11,
    })

    deepEqual(
      await ResultTask.gen(function* () {
        yield* ResultTask.ok(undefined)
        return 5
      })
        .map((n) => n + 1)
        .runResult(),
      ok(6),
    )
    deepEqual(
      await ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({ acquire: ResultTask.ok('r'), release: asyncFinalizer })
        return yield* ResultTask.tryPromise({ try: () => Promise.resolve(8), catch: () => 'e' })
      })
        .map((n) => n * 2)
        .runResult(),
      ok(16),
    )

    equal(
      await ResultTask.gen(function* () {
        yield* ResultTask.acquireRelease({ acquire: ResultTask.ok('r'), release: asyncFinalizer })
        return yield* ResultTask.tryPromise({ try: () => Promise.resolve(12), catch: () => 'e' })
      }).runPromise(),
      12,
    )
    equal(await syncWithAsyncFinalizer.runPromise(), 11)

    const throwingTask = ResultTask.ok(1)
    ;(throwingTask as unknown as { execute: () => never }).execute = () => {
      // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
      throw 'raw-runner-throw'
    }
    await rejects(() => throwingTask.runResult(), /raw-runner-throw/u)
    await rejects(() => throwingTask.runPromise(), /raw-runner-throw/u)

    const throwingErrorTask = ResultTask.ok(1)
    ;(throwingErrorTask as unknown as { execute: () => never }).execute = () => {
      throw new Error('err-runner-throw')
    }
    await rejects(() => throwingErrorTask.runPromise(), /err-runner-throw/u)
  })

  it('covers memoize sync throw, async rejection, and aborted signal paths', async () => {
    const syncThrowTask = ResultTask.ok(1)
    ;(syncThrowTask as unknown as { execute: () => never }).execute = () => {
      throw new Error('memo-sync-throw')
    }
    deepEqual(await ResultTask.memoize(syncThrowTask).runExit(), {
      _tag: 'Failure',
      cause: Cause.die(new Error('memo-sync-throw')),
    })

    const asyncRejectTask = ResultTask.ok(1)
    ;(asyncRejectTask as unknown as { execute: () => Promise<never> }).execute = () =>
      Promise.reject(new Error('memo-async-reject'))
    deepEqual(await ResultTask.memoize(asyncRejectTask).runExit(), {
      _tag: 'Failure',
      cause: Cause.die(new Error('memo-async-reject')),
    })

    let memoRuns = 0
    const memoOk = ResultTask.memoize(
      ResultTask.sync(() => {
        memoRuns += 1
        return 42
      }),
    )
    deepEqual(await memoOk.runExit({ signal: abortAfterFirstRead('uncached-abort') }), {
      _tag: 'Failure',
      cause: Cause.interrupt('uncached-abort'),
    })
    equal(memoRuns, 0)
    deepEqual(await memoOk.runResult(), ok(42))
    equal(memoRuns, 1)
    deepEqual(await memoOk.runExit({ signal: abortAfterFirstRead('cached-abort') }), {
      _tag: 'Failure',
      cause: Cause.interrupt('cached-abort'),
    })
    equal(memoRuns, 1)
  })

  it('covers executeFusedTryPromise signal, mapErr throw, and sync invoke throw branches', async () => {
    const mapErrBoom = new Error('fused-mapErr-boom')
    deepEqual(
      await ResultTask.tryPromise({
        try: () => Promise.reject(new Error('e')),
        catch: (e) => (e as Error).message,
      })
        .mapErr(() => {
          throw mapErrBoom
        })
        .runExit(),
      { _tag: 'Failure', cause: Cause.die(mapErrBoom) },
    )

    deepEqual(
      await ResultTask.tryPromise({
        try: () => {
          throw new Error('sync-invoke-boom')
        },
        catch: (e) => (e as Error).message,
      })
        .mapErr((e) => `mapped:${e}`)
        .runResult(),
      err('mapped:sync-invoke-boom'),
    )

    const cRec1 = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(5), catch: () => 'e' })
        .orElse(() => ResultTask.ok(0))
        .runResult({ signal: cRec1.signal }),
      ok(5),
    )
    const cRec2 = new AbortController()
    const pRec2 = Promise.withResolvers<number>()
    const runningRec2 = ResultTask.tryPromise({ try: () => pRec2.promise, catch: () => 'e' })
      .orElse(() => ResultTask.ok(0))
      .runExit({ signal: cRec2.signal })
    cRec2.abort('rec-abort')
    pRec2.resolve(5)
    deepEqual(await runningRec2, { _tag: 'Failure', cause: Cause.interrupt('rec-abort') })

    const cMapErr1 = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(6), catch: () => 'e' })
        .mapErr((e) => e)
        .runResult({ signal: cMapErr1.signal }),
      ok(6),
    )
    const cMapErr2 = new AbortController()
    const pMapErr2 = Promise.withResolvers<number>()
    const runningMapErr2 = ResultTask.tryPromise({ try: () => pMapErr2.promise, catch: () => 'e' })
      .mapErr((e) => e)
      .runExit({ signal: cMapErr2.signal })
    cMapErr2.abort('maperr-abort')
    pMapErr2.resolve(6)
    deepEqual(await runningMapErr2, { _tag: 'Failure', cause: Cause.interrupt('maperr-abort') })

    const cAcq = new AbortController()
    const pAcq = Promise.withResolvers<number>()
    const runningAcq = ResultTask.acquireRelease({
      acquire: ResultTask.tryPromise({ try: () => pAcq.promise, catch: () => 'e' }).mapErr(
        (e) => e,
      ),
      release: () => ResultTask.ok(undefined),
    })
      .scoped()
      .runExit({ signal: cAcq.signal })
    cAcq.abort('acq-abort')
    pAcq.resolve(6)
    equal((await runningAcq)._tag, 'Failure')
  })

  it('covers executeFusedTryPromise single-map abort and double-map abort/success branches', async () => {
    const cSingle = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'e' })
        .map((n) => {
          cSingle.abort('single-map-abort')
          return n + 1
        })
        .runExit({ signal: cSingle.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('single-map-abort') },
    )

    const cPre = new AbortController()
    const pPre = Promise.withResolvers<number>()
    const runPre = ResultTask.tryPromise({ try: () => pPre.promise, catch: () => 'e' })
      .map((n) => n + 1)
      .orElse(() => ResultTask.ok(0))
      .map((n) => n * 2)
      .runExit({ signal: cPre.signal })
    cPre.abort('pre-dbl')
    pPre.resolve(1)
    deepEqual(await runPre, { _tag: 'Failure', cause: Cause.interrupt('pre-dbl') })

    const cFirst = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'e' })
        .map((n) => {
          cFirst.abort('first-dbl')
          return n + 1
        })
        .orElse(() => ResultTask.ok(0))
        .map((n) => n * 2)
        .runExit({ signal: cFirst.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('first-dbl') },
    )

    const cSecond = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(1), catch: () => 'e' })
        .map((n) => n + 1)
        .orElse(() => ResultTask.ok(0))
        .map((n) => {
          cSecond.abort('second-dbl')
          return n * 2
        })
        .runExit({ signal: cSecond.signal }),
      { _tag: 'Failure', cause: Cause.interrupt('second-dbl') },
    )

    const cOk = new AbortController()
    deepEqual(
      await ResultTask.tryPromise({ try: () => Promise.resolve(2), catch: () => 'e' })
        .map((n) => n + 1)
        .orElse(() => ResultTask.ok(0))
        .map((n) => n * 2)
        .runResult({ signal: cOk.signal }),
      ok(6),
    )
  })
})
