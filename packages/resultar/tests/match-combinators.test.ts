import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test'
import { Match, pipe } from '../src/index.js'
import type { Result } from '../src/index.js'

type Event =
  | { _tag: 'Created'; id: string }
  | { _tag: 'Deleted'; count: number }
  | { _tag: 'Ignored'; reason: string }

describe('Match combinators', () => {
  it('infers patterns, handlers and remaining inputs through pipe', () => {
    const format = Match.type<string | number>().pipe(
      Match.when(Match.number, (number) => number + 1),
      Match.when(Match.string, (string) => string.toUpperCase()),
      Match.exhaustive,
    )
    expectTypeOf(format).toEqualTypeOf<(input: string | number) => string | number>()
    expect(format(1)).toBe(2)
    expect(format('ada')).toBe('ADA')
    const fallback = Match.type<Event>().pipe(
      Match.tag('Created', (event) => event.id),
      Match.orElse((event) => {
        expectTypeOf(event).toEqualTypeOf<Exclude<Event, { _tag: 'Created' }>>()
        return 0
      }),
    )
    expect(fallback({ _tag: 'Ignored', reason: 'skip' })).toBe(0)
  })

  it('supports exhaustive and partial tag tables', () => {
    const run = Match.type<Event>().pipe(
      Match.tags({ Created: (event) => event.id }),
      Match.tagsExhaustive({ Deleted: (event) => event.count, Ignored: (event) => event.reason }),
    )
    expectTypeOf(run).returns.toEqualTypeOf<string | number>()
    expect(run({ _tag: 'Created', id: '1' })).toBe('1')
    expect(run({ _tag: 'Deleted', count: 2 })).toBe(2)
    const all = Match.typeTags<Event>()({
      Created: (event) => event.id,
      Deleted: (event) => event.count,
      Ignored: (event) => event.reason,
    })
    expect(all({ _tag: 'Ignored', reason: 'skip' })).toBe('skip')
    expect(
      pipe(
        { _tag: 'Created', id: 'a' } as Event,
        Match.valueTags({
          Created: (event) => event.id,
          Deleted: (event) => event.count,
          Ignored: (event) => event.reason,
        }),
      ),
    ).toBe('a')
  })

  it('keeps selector arguments for handlers and fallback', () => {
    const select = vi.fn((_prefix: string, event: Event) => event)
    const run = Match.fn(select).pipe(
      Match.tag('Created', (event, prefix, original) => {
        expectTypeOf(prefix).toEqualTypeOf<string>()
        expectTypeOf(original).toEqualTypeOf<Event>()
        return prefix + event.id
      }),
      Match.tag('Deleted', 'Ignored', (event, prefix) => prefix + event._tag),
      Match.exhaustive,
    )
    expectTypeOf(run).toEqualTypeOf<(prefix: string, event: Event) => string>()
    expect(select).not.toHaveBeenCalled()
    expect(run('id:', { _tag: 'Created', id: '1' })).toBe('id:1')
    expect(run('tag:', { _tag: 'Deleted', count: 2 })).toBe('tag:Deleted')
    expect(select).toHaveBeenCalledTimes(2)
    const fallback = Match.fn((_prefix: string, event: Event) => event).orElse(
      (event, prefix) => prefix + event._tag,
    )
    expect(fallback('tag:', { _tag: 'Ignored', reason: 'skip' })).toBe('tag:Ignored')
  })

  it('passes context arguments once with fluent and functional finalizers', () => {
    interface Context {
      readonly prefix: string
      readonly record: (id: string) => void
    }
    const record = vi.fn<(id: string) => void>()
    const run = Match.context<Event, [context: Context, count?: number]>().pipe(
      Match.tag('Created', (event, context, count) => {
        expectTypeOf(event._tag).toEqualTypeOf<'Created'>()
        expectTypeOf(event.id).toEqualTypeOf<string>()
        expectTypeOf(context).toEqualTypeOf<Context>()
        expectTypeOf(count).toEqualTypeOf<number | undefined>()
        context.record(event.id)
        return context.prefix + event.id + (count ?? 0)
      }),
      Match.orElse((event, context) => {
        expectTypeOf(event).toEqualTypeOf<Exclude<Event, { _tag: 'Created' }>>()
        return context.prefix + event._tag
      }),
    )
    expectTypeOf(run).toEqualTypeOf<(event: Event, context: Context, count?: number) => string>()
    expect(record).not.toHaveBeenCalled()
    const context = { prefix: 'id:', record }
    expect(run({ _tag: 'Created', id: 'a' }, context, 2)).toBe('id:a2')
    expect(run({ _tag: 'Ignored', reason: 'skip' }, context)).toBe('id:Ignored')
    expect(record).toHaveBeenCalledExactlyOnceWith('a')
    const fluent = Match.context<Event, [prefix: string]>().tagsExhaustive({
      Created: (event, prefix) => prefix + event.id,
      Deleted: (event, prefix) => prefix + event.count,
      Ignored: (event, prefix) => prefix + event.reason,
    })
    expect(fluent({ _tag: 'Deleted', count: 2 }, 'count:')).toBe('count:2')
    const result = Match.context<Event, [prefix: string]>()
      .tag('Created', (event, prefix) => prefix + event.id)
      .result()
    const ignored: Event = { _tag: 'Ignored', reason: 'skip' }
    expect(result(ignored, 'id:')._unsafeUnwrapErr()).toBe(ignored)
  })

  it('combines positive and negative patterns', () => {
    const either = Match.type<'a' | 'b' | 'c'>().pipe(
      Match.whenOr('a', 'b', (value) => value.toUpperCase()),
      Match.when('c', () => 0),
      Match.exhaustive,
    )
    expect(either('a')).toBe('A')
    expect(either('b')).toBe('B')
    expect(either('c')).toBe(0)
    const both = Match.type<{ age: number; role: 'admin' | 'user' }>().pipe(
      Match.whenAnd({ age: (age) => age >= 18 }, { role: 'admin' }, (user) => user.age),
      Match.orElse(() => false),
    )
    expect(both({ age: 20, role: 'admin' })).toBe(20)
    expect(both({ age: 10, role: 'admin' })).toBe(false)
    expect(both({ age: 20, role: 'user' })).toBe(false)
    const negative = Match.type<'a' | 'b'>().pipe(
      Match.not('a', (value) => {
        expectTypeOf(value).toEqualTypeOf<'b'>()
        return value
      }),
      Match.when('a', () => 0),
      Match.exhaustive,
    )
    expect(negative('a')).toBe(0)
    expect(negative('b')).toBe('b')
  })

  it('supports discriminator names and prefixes', () => {
    type Input =
      | { type: 'user.created'; id: string }
      | { type: 'user.deleted'; id: string }
      | { type: 'health'; ready: boolean }
    const run = Match.type<Input>().pipe(
      Match.discriminatorStartsWith('type')('user.', (event) => event.id),
      Match.discriminatorsExhaustive('type')({ health: (event) => event.ready }),
    )
    expectTypeOf(run).returns.toEqualTypeOf<string | boolean>()
    expect(run({ type: 'user.created', id: '1' })).toBe('1')
    expect(run({ type: 'health', ready: true })).toBe(true)
    const tagged = Match.type<Event>().pipe(
      Match.tagStartsWith('Cre', (event) => event.id),
      Match.orElse(() => null),
    )
    expect(tagged({ _tag: 'Created', id: '1' })).toBe('1')
    const single = Match.type<Input>().pipe(
      Match.discriminator('type')('health', (event) => event.ready),
      Match.orElse(() => false),
    )
    expect(single({ type: 'health', ready: true })).toBe(true)
  })

  it('returns native Resultar Ok and the original unmatched input in Err', () => {
    const run = Match.type<Event>().pipe(
      Match.tag('Created', (event) => event.id),
      Match.result,
    )
    expectTypeOf(run).toEqualTypeOf<
      (input: Event) => Result<string, Exclude<Event, { _tag: 'Created' }>>
    >()
    expect(run({ _tag: 'Created', id: '1' }).unwrapOr('fallback')).toBe('1')
    const ignored: Event = { _tag: 'Ignored', reason: 'skip' }
    const missing = run(ignored)
    expect(missing.isErr()).toBe(true)
    if (missing.isErr()) expect(missing.error).toBe(ignored)
    expect(
      Match.value(1)
        .when(1, () => undefined)
        .result()
        .isOk(),
    ).toBe(true)
    expect(
      Match.type<'a' | 'b'>()
        .when('a', () => undefined)
        .option()('a'),
    ).toEqual({ _tag: 'Some', value: undefined })
    expect(
      Match.type<'a' | 'b'>()
        .when('a', () => undefined)
        .pipe(Match.option)('b'),
    ).toEqual({ _tag: 'None' })
    const absurd = Match.type<string>()
      .when('a', () => 1)
      .pipe(Match.orElseAbsurd)
    expect(() => absurd('b')).toThrow('no case matched')
  })

  it('narrows safe refinements without incorrectly claiming coverage', () => {
    class User {
      public readonly name = 'Ada'
    }
    const run = Match.type<unknown>().pipe(
      Match.when(Match.nonEmptyString, (value) => value.toUpperCase()),
      Match.when(Match.instanceOf(User), (value) => value.name),
      Match.when(Match.date, (value) => value.getUTCFullYear()),
      Match.when(Match.record, (value) => Object.keys(value).length),
      Match.orElse(() => null),
    )
    expect(run('ada')).toBe('ADA')
    expect(run('')).toBeNull()
    expect(run(new User())).toBe('Ada')
    expect(run(new Date('2026-01-01'))).toBe(2026)
    expect(run({ a: 1 })).toBe(1)
    expect(run([])).toBeNull()
    const nullable = Match.type<string | null | undefined>().pipe(
      Match.when(Match.defined, (value) => value.length),
      Match.when(Match.null, () => 0),
      Match.when(undefined, () => -1),
      Match.exhaustive,
    )
    expect(nullable('Ada')).toBe(3)
    expect(nullable(null)).toBe(0)
    expect(nullable(undefined)).toBe(-1)
    const literals = Match.type<'a' | 'b' | null>()
      .when(Match.is('a', 'b'), () => 1)
      .when(Match.null, () => 0)
      .exhaustive()
    expect(literals('b')).toBe(1)
  })

  it('checks declared handler return types', () => {
    const run = Match.type<string | number>().pipe(
      Match.withReturnType<string>(),
      Match.when(Match.string, (value) => value),
      Match.when(Match.number, String),
      Match.exhaustive,
    )
    expectTypeOf(run).returns.toEqualTypeOf<string>()
    expect(run(1)).toBe('1')
  })

  it('exhausts literal fields and nested single-property patterns', () => {
    type Input = { role: 'admin' | 'member'; id: number }
    const run = Match.type<Input>()
      .when({ role: 'admin' }, (input) => input.id)
      .when({ role: 'member' }, () => false)
      .exhaustive()
    expect(run({ role: 'admin', id: 1 })).toBe(1)
    expect(run({ role: 'member', id: 2 })).toBe(false)
    const nested = Match.type<{ user: Input }>()
      .when({ user: { role: 'admin' } }, () => true)
      .when({ user: { role: 'member' } }, () => false)
      .exhaustive()
    expect(nested({ user: { role: 'member', id: 2 } })).toBe(false)
  })

  it('exhausts combinations of finite literal fields without losing correlations', () => {
    type Input = { role: 'admin' | 'member'; active: true | false; id: number }
    const run = Match.type<Input>()
      .when({ role: 'admin', active: true }, (input) => input.id)
      .when({ role: 'admin', active: false }, () => 0)
      .when({ role: 'member', active: true }, () => 1)
      .when({ role: 'member', active: false }, () => 2)
      .exhaustive()
    expectTypeOf(run).toEqualTypeOf<(input: Input) => number>()
    expect(run({ role: 'admin', active: true, id: 5 })).toBe(5)
    expect(run({ role: 'admin', active: false, id: 5 })).toBe(0)
    expect(run({ role: 'member', active: true, id: 5 })).toBe(1)
    expect(run({ role: 'member', active: false, id: 5 })).toBe(2)
    const nested = Match.type<{ user: Input; source: 'web' | 'job' }>()
      .when({ user: { role: 'admin', active: true }, source: 'web' }, () => 'admin')
      .when({ source: 'job' }, () => 'job')
      .when({ user: { role: 'admin', active: false } }, () => 'inactive')
      .when({ user: { role: 'member' } }, () => 'member')
      .exhaustive()
    expect(nested({ user: { role: 'member', active: false, id: 1 }, source: 'web' })).toBe('member')
  })

  it('keeps optional and undefined table handlers in the remaining channel', () => {
    const handlers: { Created?: (event: Extract<Event, { _tag: 'Created' }>) => string } = {}
    const run = Match.type<Event>()
      .tags(handlers)
      .orElse((event) => event._tag)
    expectTypeOf(run).returns.toEqualTypeOf<string>()
    expect(run({ _tag: 'Created', id: '1' })).toBe('Created')
    const undefinedHandler = Match.type<Event>()
      .tags({ Created: undefined })
      .orElse((event) => event._tag)
    expect(undefinedHandler({ _tag: 'Created', id: '1' })).toBe('Created')
  })

  it('requires an explicit unsafe refinement to exhaust structural class types', () => {
    class Counter {
      public readonly count = 1
    }
    const unsafe = Match.type<Counter>()
      .when(Match.instanceOfUnsafe(Counter), (value) => value.count)
      .exhaustive()
    expectTypeOf(unsafe).toEqualTypeOf<(value: Counter) => number>()
    expect(unsafe(new Counter())).toBe(1)
    expect(() => unsafe({ count: 1 })).toThrow('no case matched')
    const safe = Match.type<Counter>()
      .when(Match.instanceOf(Counter), (value) => value.count)
      .orElse(() => 0)
    expect(safe({ count: 1 })).toBe(0)
    expect(() => Match.value<unknown>(null).when(new Counter() as never, () => 1)).toThrow(
      'plain objects',
    )
  })
})

const checkTypes = () => {
  // @ts-expect-error Active admins do not cover inactive admins or members.
  Match.type<{ role: 'admin' | 'member'; active: boolean }>()
    .when({ role: 'admin', active: true }, () => 1)
    .exhaustive()
  // @ts-expect-error A boolean predicate still cannot prove a multi-property pattern exhaustive.
  Match.type<{ role: 'admin'; age: number }>()
    .when({ role: 'admin', age: (age) => age >= 18 }, () => 1)
    .exhaustive()
  const optional: { Created?: (event: Extract<Event, { _tag: 'Created' }>) => string } = {}
  // @ts-expect-error An optional handler might be absent at runtime.
  Match.type<Extract<Event, { _tag: 'Created' }>>().tags(optional).exhaustive()
  const literals: 'a' | 'b' = Math.random() > 0.5 ? 'a' : 'b'
  // @ts-expect-error A literal union variable represents one value per invocation.
  Match.type<'a' | 'b'>()
    .when(literals, () => 1)
    .exhaustive()
  const optionalPattern: { role?: 'admin' } = { role: 'admin' }
  // @ts-expect-error An optional pattern property cannot prove coverage.
  Match.type<{ role: 'admin' | 'member' }>()
    .when(optionalPattern, () => 1)
    .exhaustive()
  const arrayPattern: string[] = ['a']
  // @ts-expect-error A variable-length array is not a proven wildcard pattern.
  Match.type<string[]>()
    .when(arrayPattern, () => 1)
    .exhaustive()
  Match.type<Event>().pipe(
    Match.tag('Deleted', () => 0),
    // @ts-expect-error Missing Created and Ignored cases.
    Match.exhaustive,
  )
  // @ts-expect-error Missing Ignored case.
  Match.type<Event>().pipe(Match.tagsExhaustive({ Created: () => 0, Deleted: () => 0 }))
  Match.type<number>().pipe(
    Match.when(
      (value) => value > 0,
      () => 0,
    ),
    // @ts-expect-error A boolean predicate cannot prove coverage.
    Match.exhaustive,
  )
  // @ts-expect-error Structural class types cannot prove nominal instanceof coverage.
  Match.type<Error>()
    .when(Match.instanceOf(Error), () => 0)
    .exhaustive()
  // @ts-expect-error Empty strings remain unmatched.
  Match.type<string>()
    .when(Match.nonEmptyString, () => 0)
    .exhaustive()
  Match.type<number>().pipe(
    Match.withReturnType<string>(),
    // @ts-expect-error Every handler must return a string.
    Match.when(Match.number, (value) => value),
    Match.exhaustive,
  )
  Match.type<number>()
    .when(Match.number, () => 1)
    // @ts-expect-error A declared return type also checks existing branches.
    .pipe(Match.withReturnType<string>())
}
expectTypeOf(checkTypes).toBeFunction()
