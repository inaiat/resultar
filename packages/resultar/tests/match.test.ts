import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'
import { createTaggedError, Match, pipe } from '../src/index.js'

type Event =
  | { readonly _tag: 'Created'; readonly id: string }
  | { readonly _tag: 'Deleted'; readonly count: number }
  | { readonly _tag: 'Ignored'; readonly reason: string }

class MissingError extends createTaggedError({ name: 'MissingError', message: 'Missing $id' }) {}
class OfflineError extends createTaggedError({ name: 'OfflineError', message: 'Offline' }) {}

describe('Match tables', () => {
  it('narrows each tagged member and preserves distinct return types', () => {
    const run = (event: Event) =>
      Match.valueTags(event, {
        Created: (value) => {
          expectTypeOf(value.id).toEqualTypeOf<string>()
          return value.id
        },
        Deleted: (value) => {
          expectTypeOf(value.count).toEqualTypeOf<number>()
          return value.count
        },
        Ignored: (value) => {
          expectTypeOf(value.reason).toEqualTypeOf<string>()
          return false as const
        },
      })
    expectTypeOf(run).returns.toEqualTypeOf<string | number | false>()
    expect(run({ _tag: 'Created', id: 'a' })).toBe('a')
    expect(run({ _tag: 'Deleted', count: 3 })).toBe(3)
    expect(run({ _tag: 'Ignored', reason: 'duplicate' })).toBe(false)
  })

  it('supports string, number and symbol discriminants', () => {
    type Response = { status: 200; user: string } | { status: 404; message: string }
    const run = (input: Response) =>
      Match.value(input).pipe(
        Match.discriminatorsExhaustive('status')({
          200: (response) => {
            expectTypeOf(response.user).toEqualTypeOf<string>()
            return response.user
          },
          404: (response) => response.message.length,
        }),
      )
    expectTypeOf(run).returns.toEqualTypeOf<string | number>()
    expect(run({ status: 200, user: 'Ada' })).toBe('Ada')
    expect(run({ status: 404, message: 'gone' })).toBe(4)
    const active = Symbol('active')
    const idle = Symbol('idle')
    type State = { kind: typeof active; count: number } | { kind: typeof idle }
    const state = (input: State) =>
      Match.value(input).pipe(
        Match.discriminatorsExhaustive('kind')({
          [active]: (entry) => entry.count,
          [idle]: () => 0,
        }),
      )
    expect(state({ kind: active, count: 4 })).toBe(4)
    expect(state({ kind: idle })).toBe(0)
  })

  it('ignores inherited handlers, including prototype names', () => {
    const handlers = Object.create({ toString: () => 'wrong' }) as { toString: () => string }
    expect(() => Match.valueTags({ _tag: 'toString' }, handlers)).toThrow('no case matched')
    expect(Match.valueTags({ _tag: 'toString' }, { toString: () => 'own' })).toBe('own')
    const malformed = { Created: 'invalid' } as unknown as { Created: () => string }
    expect(() => Match.valueTags({ _tag: 'Created' }, malformed)).toThrow('must be functions')
  })

  it('supports generic success payloads without conditional return types', () => {
    const convert = <T>(input: { _tag: 'Value'; value: T } | { _tag: 'Empty' }) =>
      Match.valueTags(input, { Value: (entry) => entry.value, Empty: () => null })
    expectTypeOf(convert({ _tag: 'Value', value: 42 })).toEqualTypeOf<number | null>()
    expect(convert({ _tag: 'Value', value: 42 })).toBe(42)
  })
})

describe('Match fluent API', () => {
  it('handles literals and built-in type guards exhaustively', () => {
    const format = Match.type<string | number | boolean | null | undefined>()
      .when(Match.string, (value) => value.toUpperCase())
      .when(Match.number, (value) => value + 1)
      .when(Match.boolean, (value) => !value)
      .when(null, () => 'null')
      .when(undefined, () => 'undefined')
      .exhaustive()
    expectTypeOf(format).toEqualTypeOf<
      (input: string | number | boolean | null | undefined) => string | number | boolean
    >()
    expect(format('ada')).toBe('ADA')
    expect(format(2)).toBe(3)
    expect(format(false)).toBe(true)
    expect(format(null)).toBe('null')
    expect(format(undefined)).toBe('undefined')
    expect(
      Match.value(undefined)
        .when(undefined, () => 42)
        .exhaustive(),
    ).toBe(42)
  })

  it('supports nested object patterns and predicates without claiming full coverage', () => {
    type Input =
      | { kind: 'user'; user: { role: 'admin' | 'member'; id: number } }
      | { kind: 'guest' }
    const run = Match.type<Input>()
      .when({ kind: 'user', user: { role: 'admin', id: (id) => id > 0 } }, (input) => {
        expectTypeOf(input.user.id).toEqualTypeOf<number>()
        return 'admin'
      })
      .when({ kind: 'user' }, (input) => input.user.id)
      .when({ kind: 'guest' }, () => null)
      .exhaustive()
    expect(run({ kind: 'user', user: { role: 'admin', id: 1 } })).toBe('admin')
    expect(run({ kind: 'user', user: { role: 'admin', id: 0 } })).toBe(0)
    expect(run({ kind: 'user', user: { role: 'member', id: 3 } })).toBe(3)
    expect(run({ kind: 'guest' })).toBeNull()
  })

  it('matches tuple positions and array prefixes', () => {
    type Input = readonly ['get', string] | readonly ['delete', number]
    const run = Match.type<Input>()
      .when(['get', Match.string], (value) => value[1].toUpperCase())
      .when(['delete', Match.number], (value) => value[1])
      .exhaustive()
    expectTypeOf(run).returns.toEqualTypeOf<string | number>()
    expect(run(['get', 'ada'])).toBe('ADA')
    expect(run(['delete', 3])).toBe(3)
    const exact = Match.type<readonly string[]>()
      .when(['a'], () => true)
      .orElse(() => false)
    expect(exact(['a'])).toBe(true)
    expect(exact(['a', 'b'])).toBe(true)
  })

  it('narrows type guards and remaining fallbacks', () => {
    const isMissing = (error: MissingError | OfflineError): error is MissingError =>
      MissingError.is(error)
    const run = Match.type<MissingError | OfflineError>()
      .when(isMissing, (error) => error.id)
      .orElse((error) => {
        expectTypeOf(error).toEqualTypeOf<OfflineError>()
        return 503 as const
      })
    expectTypeOf(run).returns.toEqualTypeOf<string | number>()
    expect(run(new MissingError({ id: '1' }))).toBe('1')
    expect(run(new OfflineError())).toBe(503)
  })

  it('provides single tags, grouped tags and a terminal table', () => {
    const run = Match.type<Event>()
      .tag('Created', (event) => {
        expectTypeOf(event.id).toEqualTypeOf<string>()
        return event.id
      })
      .tagsExhaustive({ Deleted: (event) => event.count, Ignored: (event) => event.reason })
    expectTypeOf(run).returns.toEqualTypeOf<string | number>()
    expect(run({ _tag: 'Created', id: 'a' })).toBe('a')
    expect(run({ _tag: 'Deleted', count: 4 })).toBe(4)
    const grouped = Match.type<Event>()
      .tag('Created', 'Deleted', (event) => {
        expectTypeOf(event).toEqualTypeOf<Extract<Event, { _tag: 'Created' | 'Deleted' }>>()
        return 'changed'
      })
      .orElse((event) => {
        expectTypeOf(event._tag).toEqualTypeOf<'Ignored'>()
        return event.reason
      })
    expect(grouped({ _tag: 'Ignored', reason: 'duplicate' })).toBe('duplicate')
  })

  it('keeps branches independent, evaluates value cases eagerly, and stops at the first match', () => {
    const predicate = vi.fn((value: number) => value > 0)
    const handler = vi.fn((value: number) => value + 1)
    const skipped = vi.fn(() => 99)
    const base = Match.value<number>(2).when(predicate, handler)
    const branch = base.when(Match.number, skipped)
    expect(predicate).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(branch.exhaustive()).toBe(3)
    expect(base.orElse(() => 0)).toBe(3)
    expect(predicate).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(skipped).not.toHaveBeenCalled()
    const reusable = Match.type<number>()
    const positive = reusable.when(predicate, handler).orElse(() => 0)
    const negative = reusable
      .when(
        (input) => input < 0,
        () => -1,
      )
      .orElse(() => 0)
    expect(positive(3)).toBe(4)
    expect(negative(3)).toBe(0)
    expect(negative(-3)).toBe(-1)
  })

  it('handles wildcard, bigint, symbol, NaN and signed zeros', () => {
    const run = Match.type<unknown>()
      .when(Match.bigint, (input) => input + 1n)
      .when(Match.symbol, (input) => input.description)
      .when(Match.any, () => null)
      .exhaustive()
    expect(run(1n)).toBe(2n)
    expect(run(Symbol('id'))).toBe('id')
    expect(run({})).toBeNull()
    expect(
      Match.value<number>(Number.NaN)
        .when(Number.NaN, () => 'nan')
        .orElse(() => 'other'),
    ).toBe('other')
    expect(
      Match.value<0>(0)
        .when(-0, () => 'zero')
        .exhaustive(),
    ).toBe('zero')
  })

  it('requires an explicitly present property, supports symbol keys and snapshots patterns', () => {
    const key = Symbol('key')
    const pattern = { [key]: 'a' }
    const run = Match.type<{ [key]?: string }>()
      .when(pattern, () => true)
      .orElse(() => false)
    pattern[key] = 'b'
    expect(run({ [key]: 'a' })).toBe(true)
    expect(run({ [key]: 'b' })).toBe(false)
    expect(run({})).toBe(false)
    const optional = Match.type<{ value?: undefined }>()
      .when({ value: undefined }, () => true)
      .orElse(() => false)
    expect(optional({})).toBe(false)
    expect(optional({ value: undefined })).toBe(true)
  })

  it('preserves native handler exceptions and promises', async () => {
    const failure = new Error('handler defect')
    const throwing = Match.type<number>()
      .when(Match.number, () => {
        throw failure
      })
      .exhaustive()
    expect(() => throwing(1)).toThrow(failure)
    const promise = Promise.resolve('done')
    expect(
      Match.value(1)
        .when(1, () => promise)
        .exhaustive(),
    ).toBe(promise)
    expect(
      await Match.value(1)
        .when(1, () => promise)
        .exhaustive(),
    ).toBe('done')
    const fallback = Match.type<number>().orElse(() => {
      throw failure
    })
    expect(() => fallback(1)).toThrow(failure)
  })

  it('composes as an ordinary function in pipe', () => {
    const run = Match.type<string | number>()
      .when(Match.string, (input) => input.length)
      .when(Match.number, (input) => input)
      .exhaustive()
    expect(pipe('Ada', run, (value) => value * 2)).toBe(6)
  })

  it('dispatches large tag and discriminator tables while preserving prior cases and fallback', () => {
    const table: Record<string, (value: { readonly _tag: string; readonly n: number }) => number> =
      {}
    for (let i = 0; i < 256; i += 1) {
      table[`Tag${i}`] = (value) => value.n + i
    }

    const matcher = Match.type<{ readonly _tag: string; readonly n: number }>()
      .when({ _tag: 'Tag0', n: -1 }, () => -999)
      .tags(table)
      .orElse(() => -1)

    expect(matcher({ _tag: 'Tag0', n: -1 })).toBe(-999)
    expect(matcher({ _tag: 'Tag0', n: 10 })).toBe(10)
    expect(matcher({ _tag: 'Tag128', n: 5 })).toBe(133)
    expect(matcher({ _tag: 'Tag255', n: 1 })).toBe(256)
    expect(matcher({ _tag: 'Unknown', n: 1 })).toBe(-1)

    const curriedEventTags = Match.typeTags<Event>()({
      Created: (event) => `c:${event.id}`,
      Deleted: (event) => `d:${event.count}`,
      Ignored: (event) => `i:${event.reason}`,
    })
    const formatViaPipe = (input: Event) =>
      pipe(
        input,
        Match.valueTags({
          Created: (event) => `c:${event.id}`,
          Deleted: (event) => `d:${event.count}`,
          Ignored: (event) => `i:${event.reason}`,
        }),
      )
    expect(curriedEventTags({ _tag: 'Created', id: '1' })).toBe('c:1')
    expect(curriedEventTags({ _tag: 'Deleted', count: 2 })).toBe('d:2')
    expect(curriedEventTags({ _tag: 'Ignored', reason: 'dup' })).toBe('i:dup')
    expect(formatViaPipe({ _tag: 'Created', id: '1' })).toBe('c:1')
    expect(formatViaPipe({ _tag: 'Deleted', count: 2 })).toBe('d:2')
  })
})

// Kept uncalled: these assertions exercise compile-time failures, including unsafe exhaustion.
const checkTypes = (event: Event) => {
  // @ts-expect-error Missing Ignored handler.
  Match.valueTags(event, { Created: () => 1, Deleted: () => 2 })
  // @ts-expect-error Unknown handler key.
  Match.valueTags(event, { Created: () => 1, Deleted: () => 2, Ignored: () => 3, Typo: () => 4 })
  // @ts-expect-error A missing tag remains.
  Match.type<Event>()
    .tag('Created', () => 1)
    .exhaustive()
  // @ts-expect-error Unknown tag.
  Match.type<Event>().tag('Missing', () => 1)
  // @ts-expect-error Boolean predicates do not prove exhaustiveness.
  Match.type<number>()
    .when(
      (value) => value > 0,
      () => 1,
    )
    .exhaustive()
  const literal = String(1)
  // @ts-expect-error A string variable matches one value, not every string.
  Match.type<string>()
    .when(literal, () => 1)
    .exhaustive()
  const tag = Math.random() > 0.5 ? ('Created' as const) : ('Deleted' as const)
  // @ts-expect-error A tag union variable selects only one tag at runtime.
  Match.type<Event>()
    .tag(tag, () => 1)
    .tag('Ignored', () => 2)
    .exhaustive()
  // @ts-expect-error A nested predicate does not cover every Created event.
  Match.type<Event>()
    .when({ _tag: 'Created', id: (id) => id.length > 0 }, () => 1)
    .tag('Deleted', 'Ignored', () => 2)
    .exhaustive()
  // @ts-expect-error No terminal table for open-ended tags.
  Match.type<{ _tag: string }>().tagsExhaustive({})
  // @ts-expect-error Direct tables require finite tags.
  Match.valueTags({ _tag: literal }, {})
  Match.value({ status: 200 } as { status: 200 | 404 }).pipe(
    // @ts-expect-error Missing literal discriminator.
    Match.discriminatorsExhaustive('status')({ 200: () => 1 }),
  )
  const status = Math.floor(Math.random())
  Match.value({ status }).pipe(
    // @ts-expect-error Open-ended discriminators cannot be exhaustive tables.
    Match.discriminatorsExhaustive('status')({ 200: () => 1 }),
  )
}
expectTypeOf(checkTypes).toBeFunction()
