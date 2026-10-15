import { describe, expect, expectTypeOf, it } from 'vite-plus/test'
import { Match, createTaggedError, err, errAsync } from '../src/index.js'

type Role = { readonly role: 'admin' } | { readonly role: 'member' }

describe('Match major review regressions', () => {
  it('preserves output unions in sync and async domain partial matching tables', async () => {
    class FirstError extends createTaggedError({ name: 'FirstError', message: 'first' }) {}
    class SecondError extends createTaggedError({ name: 'SecondError', message: 'second' }) {}
    type Tables =
      | { FirstError: (error: FirstError) => string }
      | { SecondError: (error: SecondError) => Promise<number> }
    const select = (first: boolean): Tables =>
      first ? { FirstError: () => 'first' } : { SecondError: async () => 2 }
    const sync = err<never, FirstError | SecondError>(new FirstError()).matchTagsPartial(
      () => false as const,
      select(true),
      (error) => {
        expectTypeOf(error).toEqualTypeOf<FirstError | SecondError>()
        return false as const
      },
    )
    expectTypeOf(sync).toEqualTypeOf<string | Promise<number> | false>()
    expect(sync).toBe('first')
    const async = errAsync<never, FirstError | SecondError>(new SecondError()).matchTagsPartial(
      () => false as const,
      select(false),
      () => false as const,
    )
    expectTypeOf(async).toEqualTypeOf<Promise<string | number | false>>()
    expect(await async).toBe(2)
  })
  it('treats array patterns as prefixes with their full required length', () => {
    const run = Match.type<[] | [undefined]>()
      .when([undefined], (value) => {
        expectTypeOf(value[0]).toEqualTypeOf<undefined>()
        return 'present'
      })
      .orElse(() => 'empty')
    expect(run([undefined])).toBe('present')
    expect(run([])).toBe('empty')
  })

  it('preserves output unions from a variable containing different handler tables', () => {
    type Event =
      | { readonly _tag: 'Created'; readonly id: string }
      | { readonly _tag: 'Deleted'; readonly count: number }
    type Tables =
      | { Created: (event: Extract<Event, { _tag: 'Created' }>) => string }
      | { Deleted: (event: Extract<Event, { _tag: 'Deleted' }>) => number }
    const select = (created: boolean): Tables =>
      created ? { Created: (event) => event.id } : { Deleted: (event) => event.count }
    const run = Match.type<Event>()
      .tags(select(true))
      .orElse(() => false as const)
    expectTypeOf(run).returns.toEqualTypeOf<string | number | false>()
    expect(run({ _tag: 'Created', id: 'a' })).toBe('a')
    expect(run({ _tag: 'Deleted', count: 2 })).toBe(false)
  })
})

const checkCoverage = (pattern: Role, indexPattern: Record<string, 'a'>) => {
  const variableObject = Match.type<Role>().when(pattern, () => 1)
  // @ts-expect-error One variable object union selects only one member at runtime.
  variableObject.exhaustive()
  const variableIndex = Match.type<Record<string, 'a'>>().when(indexPattern, () => 1)
  // @ts-expect-error An index signature does not guarantee the concrete pattern keys exist.
  variableIndex.exhaustive()
  type Callable = (() => void) & { readonly role: 'admin' | 'member' }
  const callable = Match.type<Callable>()
    .when({ role: 'admin' }, () => 1)
    .when({ role: 'member' }, () => 2)
  // @ts-expect-error Plain object patterns do not match callable values at runtime.
  callable.exhaustive()
  const andCallable = Match.type<Callable>().whenAnd({ role: Match.string }, Match.any, () => 1)
  // @ts-expect-error An object condition also keeps callable values unmatched in a conjunction.
  andCallable.exhaustive()
  type ExactCallable = (() => void) & { readonly role: 'admin' }
  const callableAnd = Match.type<ExactCallable>().whenAnd({ role: 'admin' }, () => 1)
  // @ts-expect-error Conjunctions of object patterns also leave callable values unmatched.
  callableAnd.exhaustive()
}
expectTypeOf(checkCoverage).toBeFunction()
