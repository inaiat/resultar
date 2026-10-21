import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { Match } from '../src/index.js'
import type { MatchOption, Result } from '../src/index.js'

type Event =
  | { readonly _tag: 'Created'; readonly id: string }
  | { readonly _tag: 'Deleted'; readonly count: number }
  | { readonly _tag: 'Ignored'; readonly reason: string }
type Context = { readonly prefix: string }
type Args = [context: Context, count?: number, ...labels: string[]]
type Run<Value> = (event: Event, ...args: Args) => Value
const created: Event = { _tag: 'Created', id: '1' }
const deleted: Event = { _tag: 'Deleted', count: 2 }
const ignored: Event = { _tag: 'Ignored', reason: 'skip' }
const context: Context = { prefix: 'event:' }

describe('Match argument and table inference', () => {
  it('retains required, optional and rest arguments when piped tag handlers omit them', () => {
    const required = Match.context<Event, [context: Context]>().pipe(
      Match.tag('Created', () => 1),
      Match.tag('Deleted', 'Ignored', () => 2),
      Match.exhaustive,
    )
    expectTypeOf(required).toEqualTypeOf<(event: Event, context: Context) => number>()
    expect(required(created, context)).toBe(1)

    const optional = Match.context<Event, [context: Context, count?: number]>().pipe(
      Match.tag('Created', (event) => event.id),
      Match.orElse(() => 'fallback'),
    )
    expectTypeOf(optional).toEqualTypeOf<
      (event: Event, context: Context, count?: number) => string
    >()
    expect(optional(created, context)).toBe('1')

    const rest = Match.context<Event, Args>().pipe(
      Match.tag('Created', () => 'created'),
      Match.tag('Deleted', (event, selectedContext) => {
        expectTypeOf(event.count).toEqualTypeOf<number>()
        expectTypeOf(selectedContext).toEqualTypeOf<Context>()
        return selectedContext.prefix + event.count
      }),
      Match.orElse((event, selectedContext, count, ...labels) => {
        expectTypeOf(event).toEqualTypeOf<Extract<Event, { _tag: 'Ignored' }>>()
        expectTypeOf(count).toEqualTypeOf<number | undefined>()
        expectTypeOf(labels).toEqualTypeOf<string[]>()
        return selectedContext.prefix + event.reason + (count ?? 0) + labels.join('/')
      }),
    )
    expectTypeOf(rest).toEqualTypeOf<Run<string>>()
    expect(rest(deleted, context, 3, 'unused')).toBe('event:2')
    expect(rest(ignored, context, 3, 'a', 'b')).toBe('event:skip3a/b')
  })

  it('retains context arguments through positive, conjunctive and negated cases', () => {
    const run = Match.context<Event, Args>().pipe(
      Match.whenOr({ _tag: 'Created' }, { _tag: 'Deleted' }, () => 'handled'),
      Match.whenAnd({ _tag: 'Ignored' }, { reason: 'special' }, () => 'special'),
      Match.when({ reason: 'ordinary' }, (event) => event.reason),
      Match.not({ reason: 'other' }, () => 'not-other'),
      Match.orElse(() => 'other'),
    )
    expectTypeOf(run).toEqualTypeOf<Run<string>>()
    expect(run(created, context)).toBe('handled')
    expect(run({ _tag: 'Ignored', reason: 'special' }, context, 2, 'a')).toBe('special')
    expect(run({ _tag: 'Ignored', reason: 'ordinary' }, context)).toBe('ordinary')
    expect(run(ignored, context)).toBe('not-other')
    expect(run({ _tag: 'Ignored', reason: 'other' }, context)).toBe('other')
  })

  it('retains arguments across custom discriminants, prefixes and handler tables', () => {
    type Input =
      | { readonly kind: 'user.created'; readonly id: string }
      | { readonly kind: 'user.deleted'; readonly count: number }
      | { readonly kind: 'health'; readonly ready: boolean }
    const custom = Match.context<Input, Args>().pipe(
      Match.discriminator('kind')('health', () => 'health'),
      Match.discriminatorStartsWith('kind')('user.', (event) => event.kind),
      Match.exhaustive,
    )
    expectTypeOf(custom).toEqualTypeOf<(input: Input, ...args: Args) => string>()
    expect(custom({ kind: 'user.created', id: '1' }, context, 1, 'a')).toBe('user.created')

    const table = Match.context<Input, Args>().pipe(
      Match.discriminators('kind')({ health: () => true }),
      Match.discriminatorsExhaustive('kind')({
        'user.created': (event) => event.id,
        'user.deleted': (event, selectedContext) => selectedContext.prefix + event.count,
      }),
    )
    expectTypeOf(table).toEqualTypeOf<(input: Input, ...args: Args) => string | boolean>()
    expect(table({ kind: 'user.deleted', count: 2 }, context)).toBe('event:2')

    const tagged = Match.context<Event, Args>().pipe(
      Match.tagStartsWith('Cre', () => 'created'),
      Match.tags({ Deleted: (event) => event.count }),
      Match.tagsExhaustive({ Ignored: () => false }),
    )
    expectTypeOf(tagged).toEqualTypeOf<Run<string | number | boolean>>()
    expect(tagged(ignored, context)).toBe(false)
  })

  it('preserves selector arguments and finalizer result types with unused handler parameters', () => {
    const selected = Match.fn((prefix: string, event: Event, count?: number) => {
      expect(prefix).toBe('event:')
      expect(count).toBe(2)
      return event
    }).pipe(
      Match.tag('Created', () => 1),
      Match.orElse(() => 0),
    )
    expectTypeOf(selected).toEqualTypeOf<(prefix: string, event: Event, count?: number) => number>()
    expect(selected('event:', created, 2)).toBe(1)

    const result = Match.context<Event, Args>().pipe(
      Match.tag('Created', () => 1),
      Match.result,
    )
    expectTypeOf(result).toEqualTypeOf<Run<Result<number, Exclude<Event, { _tag: 'Created' }>>>>()
    expect(result(ignored, context).isErr()).toBe(true)
    const option = Match.context<Event, Args>().pipe(
      Match.tag('Created', () => 1),
      Match.option,
    )
    expectTypeOf(option).toEqualTypeOf<Run<MatchOption<number>>>()
    expect(option(ignored, context)).toEqual({ _tag: 'None' })
    const absurd = Match.context<Event, Args>().pipe(
      Match.tag('Created', () => 1),
      Match.orElseAbsurd,
    )
    expectTypeOf(absurd).toEqualTypeOf<Run<number>>()
    expect(() => absurd(ignored, context)).toThrow('no case matched')
  })

  it('ignores undefined table entries without widening outputs or proving coverage', () => {
    const onlyUndefined = Match.type<Event>()
      .tags({ Created: undefined })
      .orElse((event) => event)
    expectTypeOf(onlyUndefined).toEqualTypeOf<(event: Event) => Event>()
    expect(onlyUndefined(created)).toBe(created)
    const mixed = Match.context<Event, Args>().pipe(
      Match.tags({ Created: undefined, Deleted: () => 1 }),
      Match.orElse((event, selectedContext) => {
        expectTypeOf(event).toEqualTypeOf<Exclude<Event, { _tag: 'Deleted' }>>()
        return selectedContext.prefix + event._tag
      }),
    )
    expectTypeOf(mixed).toEqualTypeOf<Run<string | number>>()
    expect(mixed(created, context)).toBe('event:Created')
    expect(mixed(deleted, context)).toBe(1)

    type Optional = {
      Created?: ((event: Extract<Event, { _tag: 'Created' }>) => string) | undefined
    }
    const optional: Optional = {}
    const optionalTable = Match.type<Event>()
      .tags(optional)
      .orElse(() => false as const)
    expectTypeOf(optionalTable).returns.toEqualTypeOf<string | false>()
    expect(optionalTable(created)).toBe(false)
    type Tables = { Created: undefined } | { Deleted: () => number }
    const select = (enabled: boolean): Tables =>
      enabled ? { Deleted: () => 2 } : { Created: undefined }
    const union = Match.type<Event>()
      .tags(select(false))
      .orElse(() => false as const)
    expectTypeOf(union).returns.toEqualTypeOf<number | false>()
    expect(union(created)).toBe(false)
  })
})

const checkTypes = (neverHandler: { Created: never }) => {
  const neverTable = Match.type<Event>()
    .tags(neverHandler)
    .orElse(() => false as const)
  expectTypeOf(neverTable).returns.toEqualTypeOf<false>()
  // @ts-expect-error Undefined entries do not cover the missing Created case.
  Match.type<Event>()
    .tags({ Created: undefined, Deleted: () => 1, Ignored: () => 2 })
    .exhaustive()
  Match.context<Event, Args>().pipe(
    Match.tagsExhaustive({
      // @ts-expect-error Exhaustive tables require a callable handler for every tag.
      Created: undefined,
      Deleted: () => 1,
      Ignored: () => 2,
    }),
  )
  Match.context<Event, Args>().pipe(
    // @ts-expect-error An optional count cannot be required by a handler.
    Match.tag('Created', (_event, _context, count: number) => count),
  )
  Match.context<Event, Args>().pipe(
    // @ts-expect-error Callback context remains constrained to the matcher context.
    Match.tag('Created', (_event, incompatible: number) => incompatible),
  )
  Match.context<Event, Args>().pipe(
    // @ts-expect-error Rest arguments remain string values.
    Match.orElse((_event, _context, _count, ...labels: number[]) => labels.length),
  )
}
expectTypeOf(checkTypes).toBeFunction()
