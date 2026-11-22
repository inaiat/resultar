import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  Result,
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

  it('does not alias or mutate retained Ok iterator results across iterations', () => {
    const r1 = ok(1)[Symbol.iterator]().next()
    const r2 = ok(2)[Symbol.iterator]().next()
    expect(r1).not.toBe(r2)
    expect(r1.done).toBe(true)
    expect(r2.done).toBe(true)
    expect(r1.value).toBe(1)
    expect(r2.value).toBe(2)
    expect(r1.value).toBe(1)
    expect(r2.value).toBe(2)

    const it1 = ok('first')[Symbol.iterator]()
    const it2 = ok('second')[Symbol.iterator]()
    expect(it1).not.toBe(it2)
    const s1 = it1.next()
    const s2 = it2.next()
    expect(s1.value).toBe('first')
    expect(s2.value).toBe('second')
    expect(s1.value).toBe('first')

    function* manualGen() {
      const a = yield* ok(10)
      const b = yield* ok(32)
      return a + b
    }
    expect(manualGen().next()).toEqual({ done: true, value: 42 })

    const genRes = Result.gen(function* () {
      const a = yield* ok(10)
      const b = yield* ok(32)
      return a + b
    })
    expect(genRes).toEqual(ok(42))
  })

  it('does not alias or mutate retained ResultTask iterator results across iterations', () => {
    const taskIt1 = ResultTask.ok(101)[Symbol.iterator]()
    const taskIt2 = ResultTask.ok(202)[Symbol.iterator]()
    expect(taskIt1 === taskIt2).toBe(false)
    const firstYield = taskIt1.next()
    expect(firstYield.done).toBe(false)
    const tr1 = taskIt1.next({ _tag: 'Success', value: 101 })
    const secondYield = taskIt2.next()
    expect(secondYield.done).toBe(false)
    const tr2 = taskIt2.next({ _tag: 'Success', value: 202 })
    expect(tr1 === tr2).toBe(false)
    expect(tr1.done).toBe(true)
    expect(tr2.done).toBe(true)
    expect(tr1.value).toBe(101)
    expect(tr2.value).toBe(202)
    expect(tr1.value).toBe(101)
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

  it('evaluates property and array getters strictly once in identical order across RESULTAR_JIT=0 and 1 processes', () => {
    const entryUrl = pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href
    const script = `
      import { Match } from ${JSON.stringify(entryUrl)};

      const runAll = () => {
        // 1. Flaky getter returning string once, then null (previously threw TypeError under JIT)
        let nameReads = 0;
        const flakyObj = {
          get name() {
            nameReads += 1;
            return nameReads === 1 ? "Ada" : null;
          },
        };
        const matchName = Match.type().pipe(
          Match.when({ name: Match.nonEmptyString }, () => "matched"),
          Match.orElse(() => "missed"),
        );
        const flakyResult = matchName(flakyObj);

        // 2. Multi-read & zero-read builtins + NaN literal + nested object/array read order
        const order = [];
        const nestedTarget = {
          get user() {
            order.push("user");
            return {
              get name() { order.push("user.name"); return "Grace"; },
              get meta() { order.push("user.meta"); return { ok: true }; },
              get note() { order.push("user.note"); return "kept"; },
            };
          },
          get items() {
            order.push("items");
            const arr = [];
            Object.defineProperty(arr, 0, {
              enumerable: true,
              get() { order.push("items[0]"); return 123; },
            });
            Object.defineProperty(arr, 1, {
              enumerable: true,
              get() { order.push("items[1]"); return "any-val"; },
            });
            return arr;
          },
          get untouched() {
            order.push("untouched");
            return 999;
          },
        };
        const matchNested = Match.type().pipe(
          Match.when(
            {
              user: { name: Match.nonEmptyString, meta: Match.record, note: Match.any },
              items: [Match.defined, Match.any],
            },
            () => "nested-hit",
          ),
          Match.when({ untouched: Match.number }, () => "should-short-circuit"),
          Match.orElse(() => "nested-miss"),
        );
        const nestedResult = matchNested(nestedTarget);

        // 3. NaN literal getter must still be read once (matching interpreter)
        const nanOrder = [];
        const nanTarget = {
          get score() { nanOrder.push("score"); return 42; },
          get after() { nanOrder.push("after"); return "skipped"; },
        };
        const matchNan = Match.type().pipe(
          Match.when({ score: Number.NaN, after: Match.string }, () => "nan-hit"),
          Match.orElse(() => "nan-miss"),
        );
        const nanResult = matchNan(nanTarget);

        // 4. Short-circuit inside whenOr / whenAnd / failed earlier property
        const scOrder = [];
        const scTarget = {
          get first() { scOrder.push("first"); return ""; },
          get second() { scOrder.push("second"); return "never-read"; },
          get alt() { scOrder.push("alt"); return "ok"; },
          get never() { scOrder.push("never"); return 1; },
        };
        const matchSc = Match.type().pipe(
          Match.whenOr(
            { first: Match.nonEmptyString, second: Match.string },
            { alt: Match.nonEmptyString },
            { never: Match.number },
            () => "sc-hit",
          ),
          Match.orElse(() => "sc-miss"),
        );
        const scResult = matchSc(scTarget);

        return {
          flakyResult,
          nameReads,
          nestedResult,
          order,
          nanResult,
          nanOrder,
          scResult,
          scOrder,
        };
      };

      console.log(JSON.stringify(runAll()));
    `

    const runInProcess = (jitFlag: '0' | '1'): Record<string, unknown> => {
      const env: NodeJS.ProcessEnv = Object.fromEntries([
        ...Object.entries(process.env),
        ['RESULTAR_JIT', jitFlag],
      ])
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'vite-plus/register', '--input-type=module', '-e', script],
        { encoding: 'utf8', env },
      )
      return JSON.parse(stdout.trim()) as Record<string, unknown>
    }

    const jit = runInProcess('1')
    const fallback = runInProcess('0')

    expect(jit).toEqual(fallback)
    expect(jit).toEqual({
      flakyResult: 'matched',
      nameReads: 1,
      nestedResult: 'nested-hit',
      order: ['user', 'user.name', 'user.meta', 'user.note', 'items', 'items[0]', 'items[1]'],
      nanResult: 'nan-miss',
      nanOrder: ['score'],
      scResult: 'sc-hit',
      scOrder: ['first', 'alt'],
    })
  })

  it('matches numeric NaN discriminators identically across RESULTAR_JIT=0 and 1 for <=4 and >4 tags', () => {
    const entryUrl = pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href
    const script = `
      import { Match } from ${JSON.stringify(entryUrl)};

      const small = Match.type().pipe(
        Match.discriminator('code')(1, Number.NaN, (v) => 'small-hit:' + String(v.code)),
        Match.orElse(() => 'small-fallback'),
      );

      const large = Match.type().pipe(
        Match.discriminator('code')(1, 2, 3, 4, Number.NaN, 6, (v) => 'large-hit:' + String(v.code)),
        Match.orElse(() => 'large-fallback'),
      );

      const smallSingleNan = Match.type().pipe(
        Match.discriminator('code')(Number.NaN, () => 'single-nan'),
        Match.orElse(() => 'single-fallback'),
      );

      console.log(JSON.stringify({
        smallNan: small({ code: Number.NaN }),
        smallOne: small({ code: 1 }),
        smallMiss: small({ code: 2 }),
        largeNan: large({ code: Number.NaN }),
        largeFour: large({ code: 4 }),
        largeSix: large({ code: 6 }),
        largeMiss: large({ code: 99 }),
        singleNan: smallSingleNan({ code: Number.NaN }),
        singleMiss: smallSingleNan({ code: 0 }),
      }));
    `

    const runInChild = (jitFlag: '0' | '1') => {
      const env: NodeJS.ProcessEnv = Object.fromEntries([
        ...Object.entries(process.env),
        ['RESULTAR_JIT', jitFlag],
      ])
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'vite-plus/register', '--input-type=module', '-e', script],
        { env, encoding: 'utf8' },
      )
      return JSON.parse(stdout.trim()) as Record<string, string>
    }

    const fallback = runInChild('0')
    const jit = runInChild('1')

    expect(jit).toEqual(fallback)
    expect(jit).toEqual({
      smallNan: 'small-hit:NaN',
      smallOne: 'small-hit:1',
      smallMiss: 'small-fallback',
      largeNan: 'large-hit:NaN',
      largeFour: 'large-hit:4',
      largeSix: 'large-hit:6',
      largeMiss: 'large-fallback',
      singleNan: 'single-nan',
      singleMiss: 'single-fallback',
    })
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
        .map((n) => n + 1)

      const errMapChain = ResultTask.err({ _tag: 'Initial' as const, code: 1 })
        .mapErr((e) => ({ _tag: 'Mapped' as const, code: e.code + 10 }))
        .catchTags({ Mapped: (e) => err(e.code * 2) })
        .orElse((n) => ResultTask.ok(n + 1))

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
      { _tag: 'Success', value: 49 },
      { _tag: 'Success', value: 49 },
      { _tag: 'Success', value: 49 },
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
          .orElse(() => ResultTask.ok(999))

        await ResultTask.runExit(abortTask)
        await ResultTask.runExit(abortTask)
        const abortedExit = await ResultTask.runExit(abortTask, { signal: controller.signal })

        // Composite sequential cause entering catchAll on hot compiled path
        const compositeTask = ResultTask.err('a')
          .ensuring(() => {
            throw new Error('b')
          })
          .map((value: never) => value)
          .orElse(() => ResultTask.ok('unreachable'))
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

  it('preserves this receiver in ResultTask.try across cold and JIT-compiled success and failure paths', async () => {
    const runReceiverSuite = (jitEnabled: boolean) =>
      withJitModeAsync(jitEnabled, async () => {
        const successOptions = {
          value: 40,
          try() {
            return this.value + 4
          },
          catch() {
            return `err:${String(this.value)}`
          },
        }
        const successTask = ResultTask.try(successOptions).map((n) => n)

        const failureOptions = {
          value: 40,
          prefix: 'caught',
          try(): number {
            throw new Error(`boom:${String(this.value)}`)
          },
          catch(error: unknown) {
            return `${this.prefix}:${String(this.value)}:${error instanceof Error ? error.message : String(error)}`
          },
        }
        const failureTask = ResultTask.try(failureOptions).map((n) => n + 1)

        const successRuns = []
        const failureRuns = []
        // Repeat the same task instance 5 times to cross warmup and execute the compiled chain.
        for (let index = 0; index < 5; index += 1) {
          // eslint-disable-next-line no-await-in-loop
          successRuns.push(await ResultTask.runExit(successTask))
          // eslint-disable-next-line no-await-in-loop
          failureRuns.push(await ResultTask.runExit(failureTask))
        }
        return { successRuns, failureRuns }
      })

    const fallback = await runReceiverSuite(false)
    const jit = await runReceiverSuite(true)

    expect(jit).toEqual(fallback)
    expect(jit.successRuns).toEqual([
      { _tag: 'Success', value: 44 },
      { _tag: 'Success', value: 44 },
      { _tag: 'Success', value: 44 },
      { _tag: 'Success', value: 44 },
      { _tag: 'Success', value: 44 },
    ])
    expect(jit.failureRuns).toEqual([
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'caught:40:boom:40' } },
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'caught:40:boom:40' } },
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'caught:40:boom:40' } },
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'caught:40:boom:40' } },
      { _tag: 'Failure', cause: { _tag: 'Fail', error: 'caught:40:boom:40' } },
    ])
  })

  it('preserves explicit null abort reason identically in runExit and runSyncExit across JIT modes', async () => {
    // eslint-disable-next-line unicorn/no-null -- Explicit null abort reason is the regression under test.
    const explicitNull: unknown = null

    for (const jitEnabled of [false, true]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitModeAsync(jitEnabled, async () => {
        let activeController = new AbortController()
        let shouldAbort = false
        const task = ResultTask.sync(() => {
          if (shouldAbort) {
            activeController.abort(explicitNull)
          }
          return 1
        })
          .map((n) => n + 1)
          .map((n) => n * 2)

        // Warm up so JIT compiles the chain when RESULTAR_JIT=1.
        for (let index = 0; index < 3; index += 1) {
          expect(ResultTask.runSyncExit(task)).toEqual({ _tag: 'Success', value: 4 })
        }

        shouldAbort = true

        // 1. Mid-execution abort(null) in runExit vs runSyncExit
        activeController = new AbortController()
        const asyncExit = await ResultTask.runExit(task, { signal: activeController.signal })

        activeController = new AbortController()
        const syncExit = ResultTask.runSyncExit(task, { signal: activeController.signal })

        expect(asyncExit).toEqual({
          _tag: 'Failure',
          cause: { _tag: 'Interrupt', reason: explicitNull },
        })
        expect(syncExit).toEqual(asyncExit)
        if (syncExit._tag === 'Failure' && syncExit.cause._tag === 'Interrupt') {
          expect(Object.is(syncExit.cause.reason, explicitNull)).toBe(true)
        }

        // 2. Pre-aborted abort(null)
        const preAborted = new AbortController()
        preAborted.abort(explicitNull)
        const preSyncExit = ResultTask.runSyncExit(task, { signal: preAborted.signal })
        expect(preSyncExit).toEqual({
          _tag: 'Failure',
          cause: { _tag: 'Interrupt', reason: explicitNull },
        })
      })
    }
  })
})
