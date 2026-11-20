import { afterEach, describe, expect, it } from 'vite-plus/test'

import { canUseJit } from '../src/core/jit.js'
import {
  Cause,
  createTaggedError,
  err,
  flow,
  Match,
  ok,
  pipe,
  redact,
  ResultTask,
  ResultTaskCauseError,
  taggedEnum,
} from '../src/index.js'

const withJitMode = <T>(enabled: boolean, run: () => T): T => {
  const previous = process.env['RESULTAR_JIT']
  process.env['RESULTAR_JIT'] = enabled ? '1' : '0'
  try {
    return run()
  } finally {
    if (previous === undefined) {
      delete process.env['RESULTAR_JIT']
    } else {
      process.env['RESULTAR_JIT'] = previous
    }
  }
}

const withJitModeAsync = async <T>(enabled: boolean, run: () => Promise<T>): Promise<T> => {
  const previous = process.env['RESULTAR_JIT']
  process.env['RESULTAR_JIT'] = enabled ? '1' : '0'
  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env['RESULTAR_JIT']
    } else {
      process.env['RESULTAR_JIT'] = previous
    }
  }
}

afterEach(() => {
  delete process.env['RESULTAR_JIT']
})

describe('JIT runtime controls and Workstream A micro-optimizations', () => {
  it('respects RESULTAR_JIT=0 and RESULTAR_JIT=false dynamically', () => {
    expect(withJitMode(true, () => canUseJit())).toBe(true)
    expect(withJitMode(false, () => canUseJit())).toBe(false)
    process.env['RESULTAR_JIT'] = 'false'
    expect(canUseJit()).toBe(false)
  })

  it('preserves arity-specialized pipe and flow semantics across 0..8 functions', () => {
    const add1 = (n: number) => n + 1
    const double = (n: number) => n * 2
    expect(pipe(3)).toBe(3)
    expect(pipe(3, add1)).toBe(4)
    expect(pipe(3, add1, double)).toBe(8)
    expect(pipe(3, add1, double, add1, double, add1, double, add1, double)).toBe(78)

    const composed = flow(
      (a: number, b: number) => a + b,
      add1,
      double,
      add1,
      double,
      add1,
      double,
      add1,
      double,
    )
    expect(composed(1, 2)).toBe(78)
  })
})

describe('Workstream B: createTaggedError JIT template compilation & parity', () => {
  const dollar = String.fromCodePoint(36)
  const injectedSnippet = `${dollar}{process.exit(1)}`

  const runTemplateSuite = (jitEnabled: boolean) =>
    withJitMode(jitEnabled, () => {
      const HostileError = createTaggedError({
        name: 'HostileError',
        message: `quote " ' \` \\ \n \r \u2028 \u2029 ${injectedSnippet} $id/$secret/$missing/$id`,
      })
      const NumericError = createTaggedError({ name: 'NumericError', message: '$count' })
      const PlainError = createTaggedError({
        name: 'PlainError',
        message: 'static message without placeholders',
      })

      const secret = redact('super-secret')
      const cause = new Error('root-cause')
      const hostile = new HostileError({
        id: 42,
        secret,
        missing: undefined as unknown as string,
        cause,
      })
      const numeric = new NumericError({ count: 99 })
      const plain = new PlainError()

      return {
        hostileMessage: hostile.message,
        hostileCause: hostile.cause,
        hostileDescriptor: Object.getOwnPropertyDescriptor(hostile, 'id'),
        numericMessage: numeric.message,
        hasCauseOnNumeric: 'cause' in numeric,
        plainMessage: plain.message,
        fingerprint: hostile.fingerprint,
      }
    })

  it('matches identically between RESULTAR_JIT=1 and RESULTAR_JIT=0 including hostile templates', () => {
    const jitResult = runTemplateSuite(true)
    const fallbackResult = runTemplateSuite(false)

    expect(jitResult).toEqual(fallbackResult)
    expect(jitResult.hostileMessage).toContain(`${injectedSnippet} 42/<redacted>/$missing/42`)
    expect(jitResult.hostileDescriptor).toEqual({
      configurable: true,
      enumerable: true,
      value: 42,
      writable: false,
    })
    expect(jitResult.numericMessage).toBe('99')
    expect(jitResult.hasCauseOnNumeric).toBe(false)
    expect(jitResult.plainMessage).toBe('static message without placeholders')
    expect(jitResult.fingerprint[0]).toBe('HostileError')
    expect(jitResult.fingerprint).toHaveLength(2)
  })

  it('caches taggedEnum constructors while constructing distinct values', () => {
    const Event = taggedEnum<{
      readonly Ping: { readonly seq: number }
      readonly Pong: { readonly ok: boolean }
    }>()
    expect(Event.Ping).toBe(Event.Ping)
    const first = Event.Ping({ seq: 1 })
    const second = Event.Ping({ seq: 2 })
    expect(first).toEqual({ _tag: 'Ping', seq: 1 })
    expect(second).toEqual({ _tag: 'Ping', seq: 2 })
    expect(first).not.toBe(second)
  })
})

describe('Workstream C: Match JIT compilation, security, and parity', () => {
  type Shape =
    | { readonly _tag: 'Circle'; readonly radius: number }
    | { readonly _tag: 'Rect'; readonly w: number; readonly h: number }
    | { readonly _tag: 'Dot' }

  const runMatchSuite = (jitEnabled: boolean) =>
    withJitMode(jitEnabled, () => {
      const area = Match.type<Shape>().pipe(
        Match.tagsExhaustive({
          Circle: ({ radius }) => radius * radius,
          Rect: ({ w, h }) => w * h,
          Dot: () => 0,
        }),
      )

      const nested = Match.type<unknown>()
        .pipe(
          Match.when(
            { kind: 'pair', pair: [Match.string, Match.number] },
            (v) => `pair:${v.pair[0]}`,
          ),
          Match.when(Match.nonEmptyString, (s) => `str:${s}`),
          Match.when(Number.NaN, () => 'literal-nan-never'),
          Match.when(Match.is(Number.NaN), () => 'object-is-nan'),
          Match.when(0, () => 'zero'),
          Match.when({ a: undefined }, () => 'has-undef-a'),
          Match.whenOr('x', 'y', () => 'xy'),
        )
        .pipe(
          Match.whenAnd(
            Match.number,
            (n: unknown): n is number => typeof n === 'number' && n > 10,
            (n) => `big:${String(n)}`,
          ),
          Match.not(false, () => 'not-false'),
          Match.orElse(() => 'fallback'),
        )

      const ctxMatcher = Match.context<Shape, [scale: number]>().pipe(
        Match.tagStartsWith('Cir', (shape, scale) => shape.radius * scale),
        Match.tag('Rect', (shape, scale) => (shape.w + shape.h) * scale),
        Match.option,
      )

      const fnMatcher = Match.fn((_prefix: string, shape: Shape) => shape).pipe(
        Match.tag('Dot', (_shape, prefix) => `${prefix}:dot`),
        Match.result,
      )

      return {
        circle: area({ _tag: 'Circle', radius: 3 }),
        rect: area({ _tag: 'Rect', w: 4, h: 5 }),
        dot: area({ _tag: 'Dot' }),
        nestedPair: nested({ kind: 'pair', pair: ['ok', 7] }),
        nestedStr: nested('hello'),
        nestedNaN: nested(Number.NaN),
        nestedNegZero: nested(-0),
        nestedHasUndef: nested({ a: undefined }),
        nestedMissingUndef: nested({}),
        nestedOr: nested('y'),
        nestedAnd: nested(42),
        nestedFalse: nested(false),
        ctxCir: ctxMatcher({ _tag: 'Circle', radius: 2 }, 10),
        ctxDot: ctxMatcher({ _tag: 'Dot' }, 10),
        fnDot: fnMatcher('evt', { _tag: 'Dot' })._unsafeUnwrap(),
        fnMissIsErr: fnMatcher('evt', { _tag: 'Circle', radius: 1 }).isErr(),
      }
    })

  it('produces identical results in RESULTAR_JIT=1 and RESULTAR_JIT=0 across combinators', () => {
    const jit = runMatchSuite(true)
    const fallback = runMatchSuite(false)

    expect(jit).toEqual(fallback)
    expect(jit.circle).toBe(9)
    expect(jit.rect).toBe(20)
    expect(jit.nestedPair).toBe('pair:ok')
    expect(jit.nestedNegZero).toBe('zero')
    expect(jit.nestedNaN).toBe('object-is-nan')
    expect(jit.nestedHasUndef).toBe('has-undef-a')
    expect(jit.nestedMissingUndef).toBe('not-false')
    expect(jit.nestedFalse).toBe('fallback')
    expect(jit.ctxCir).toEqual({ _tag: 'Some', value: 20 })
    expect(jit.ctxDot).toEqual({ _tag: 'None' })
    expect(jit.fnDot).toBe('evt:dot')
    expect(jit.fnMissIsErr).toBe(true)
  })

  it('safely handles hostile property keys, hostile _tag strings, and >128 case fallback', () => {
    const hostileKey = 'a"]; throw new Error("code-injection"); //'
    const hostileTag = 'x": throw new Error("tag-injection"); case "y'

    const runHostile = (jitEnabled: boolean) =>
      withJitMode(jitEnabled, () => {
        const byHostileKey = Match.type<Record<string, unknown>>().pipe(
          Match.when({ [hostileKey]: 'safe' }, () => 'matched-key'),
          Match.orElse(() => 'missed'),
        )
        const byHostileTag = Match.type<{ readonly _tag: string }>().pipe(
          Match.tag(hostileTag as never, () => 'matched-tag'),
          Match.orElse(() => 'missed-tag'),
        )
        const symbolKey = Symbol('sym')
        const bySymbol = Match.type<Record<PropertyKey, unknown>>().pipe(
          Match.when({ [symbolKey]: 123 }, () => 'matched-sym'),
          Match.orElse(() => 'missed-sym'),
        )

        let large = Match.type<number>().when(0, () => 0)
        for (let index = 1; index < 140; index += 1) {
          large = large.when(index, () => index * 10)
        }
        const runLarge = large.orElse(() => -1)

        return {
          keyHit: byHostileKey({ [hostileKey]: 'safe' }),
          keyMiss: byHostileKey({ [hostileKey]: 'other' }),
          tagHit: byHostileTag({ _tag: hostileTag }),
          tagMiss: byHostileTag({ _tag: 'other' }),
          symHit: bySymbol({ [symbolKey]: 123 }),
          large135: runLarge(135),
          largeMiss: runLarge(999),
        }
      })

    const jit = runHostile(true)
    const fallback = runHostile(false)
    expect(jit).toEqual(fallback)
    expect(jit.keyHit).toBe('matched-key')
    expect(jit.tagHit).toBe('matched-tag')
    expect(jit.symHit).toBe('matched-sym')
    expect(jit.large135).toBe(1350)
    expect(jit.largeMiss).toBe(-1)
  })

  it('guards Match.valueTags fast path against inherited prototype keys and non-function handlers', () => {
    type Tagged = { readonly _tag: 'A'; readonly value: number } | { readonly _tag: 'B' }
    expect(
      Match.valueTags({ _tag: 'A', value: 7 } as Tagged, {
        A: ({ value }) => value * 3,
        B: () => 0,
      }),
    ).toBe(21)

    expect(() =>
      Match.valueTags({ _tag: 'toString' } as unknown as Tagged, { A: () => 1, B: () => 2 }),
    ).toThrow(/Match: no case matched the input/u)

    expect(() =>
      Match.valueTags({ _tag: 'A', value: 1 } as Tagged, {
        A: 'not-a-function' as unknown as () => number,
        B: () => 2,
      }),
    ).toThrow(TypeError)
  })
})

describe('Workstream E: ResultTask tiered JIT parity, bailout, abort, and safety', () => {
  const buildAndRunTaskSuite = (jitEnabled: boolean) =>
    withJitModeAsync(jitEnabled, async () => {
      class DomainErr extends createTaggedError({ name: 'DomainErr', message: 'boom $code' }) {}
      const hostileTag = 'a"; throw new Error("injected"); //'

      const syncChain = ResultTask.sync(() => 10)
        .map((n) => n + 5)
        .andThen((n) => ResultTask.ok(n * 2))
        .andThen((n) => ok(n - 4))
        .map((n) => n / 2)

      const failingChain = ResultTask.try({
        try: (): number => {
          throw new Error('raw')
        },
        catch: () => new DomainErr({ code: 500 }),
      })
        .map((n) => n + 1)
        .catchTag(hostileTag as never, () => ResultTask.ok(-1))
        .catchTag('DomainErr', (error) => ResultTask.ok(Number(error.code)))
        .map((code) => code + 1)

      const asyncMidChain = ResultTask.ok(3)
        .map((n) => n * 2)
        .andThen((n) => ResultTask.tryPromise({ try: async () => n + 10, catch: String }))
        .map((n) => n * 3)

      const errMapChain = ResultTask.err({ _tag: 'Initial' as const, code: 1 })
        .mapErr((e) => ({ _tag: 'Mapped' as const, code: e.code + 10 }))
        .catchTags({ Mapped: (e) => err(e.code * 2) })
        .catchAll((n) => ResultTask.ok(n + 1))

      // Run each 3 times: run #1 (cold), run #2 (triggers JIT compile), run #3 (hot compiled)
      const syncRuns = [
        await ResultTask.runExit(syncChain),
        await ResultTask.runExit(syncChain),
        await ResultTask.runExit(syncChain),
      ]
      const failRuns = [
        await ResultTask.runExit(failingChain),
        await ResultTask.runExit(failingChain),
        await ResultTask.runExit(failingChain),
      ]
      const asyncRuns = [
        await ResultTask.runExit(asyncMidChain),
        await ResultTask.runExit(asyncMidChain),
        await ResultTask.runExit(asyncMidChain),
      ]
      const errMapRuns = [
        await ResultTask.runExit(errMapChain),
        await ResultTask.runExit(errMapChain),
        await ResultTask.runExit(errMapChain),
      ]

      return { syncRuns, failRuns, asyncRuns, errMapRuns }
    })

  it('matches identically across cold and hot executions in RESULTAR_JIT=1 and RESULTAR_JIT=0', async () => {
    const jit = await buildAndRunTaskSuite(true)
    const fallback = await buildAndRunTaskSuite(false)

    expect(jit).toEqual(fallback)
    expect(jit.syncRuns).toEqual([
      { _tag: 'Success', value: 13 },
      { _tag: 'Success', value: 13 },
      { _tag: 'Success', value: 13 },
    ])
    expect(jit.failRuns).toEqual([
      { _tag: 'Success', value: 501 },
      { _tag: 'Success', value: 501 },
      { _tag: 'Success', value: 501 },
    ])
    expect(jit.asyncRuns).toEqual([
      { _tag: 'Success', value: 48 },
      { _tag: 'Success', value: 48 },
      { _tag: 'Success', value: 48 },
    ])
    expect(jit.errMapRuns).toEqual([
      { _tag: 'Success', value: 23 },
      { _tag: 'Success', value: 23 },
      { _tag: 'Success', value: 23 },
    ])
  })

  it('preserves mid-chain AbortSignal interruption, composite Cause defects, and execute invalidation', async () => {
    const runEdgeCases = (jitEnabled: boolean) =>
      withJitModeAsync(jitEnabled, async () => {
        const controller = new AbortController()
        let stepCount = 0
        const abortTask = ResultTask.ok(1)
          .map((n) => {
            stepCount += 1
            return n + 1
          })
          .andThen((_n) => {
            if (stepCount >= 3) {
              controller.abort('mid-chain-stop')
            }
            return ResultTask.err('should-interrupt-before-fail')
          })
          .catchAll(() => ResultTask.ok(999))

        await ResultTask.runExit(abortTask)
        await ResultTask.runExit(abortTask)
        const abortedExit = await ResultTask.runExit(abortTask, { signal: controller.signal })

        // Composite sequential cause entering catchAll on hot compiled path
        const compositeTask = ResultTask.err('a')
          .ensuring(() => {
            throw new Error('b')
          })
          .map((value: never) => value)
          .catchAll(() => ResultTask.ok('unreachable'))
        await ResultTask.runExit(compositeTask)
        const compositeHotExit = await ResultTask.runExit(compositeTask)

        // Chain exceeding MAX_JIT_STEPS (260 steps)
        let longChain = ResultTask.ok(0)
        for (let index = 0; index < 260; index += 1) {
          longChain = longChain.map((n) => n + 1)
        }
        await ResultTask.runExit(longChain)
        const longHotExit = await ResultTask.runExit(longChain)

        // Private execute setter invalidation after JIT compilation
        const mutableTask = ResultTask.ok(1)
          .map((n) => n + 1)
          .map((n) => n * 10)
        await ResultTask.runExit(mutableTask)
        const beforeOverride = await ResultTask.runExit(mutableTask)
        ;(mutableTask as unknown as { execute: () => { _tag: 'Success'; value: number } }).execute =
          () => ({ _tag: 'Success', value: 777 })
        const afterOverride = await ResultTask.runExit(mutableTask)

        return {
          abortedInterrupted:
            abortedExit._tag === 'Failure' && Cause.hasInterrupts(abortedExit.cause),
          compositeIsCauseError:
            compositeHotExit._tag === 'Failure' &&
            compositeHotExit.cause._tag === 'Die' &&
            compositeHotExit.cause.defect instanceof ResultTaskCauseError,
          longHotExit,
          beforeOverride,
          afterOverride,
        }
      })

    const jit = await runEdgeCases(true)
    const fallback = await runEdgeCases(false)

    expect(jit).toEqual(fallback)
    expect(jit.abortedInterrupted).toBe(true)
    expect(jit.compositeIsCauseError).toBe(true)
    expect(jit.longHotExit).toEqual({ _tag: 'Success', value: 260 })
    expect(jit.beforeOverride).toEqual({ _tag: 'Success', value: 20 })
    expect(jit.afterOverride).toEqual({ _tag: 'Success', value: 777 })
  })
})
