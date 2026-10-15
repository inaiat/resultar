import { identity } from '../core/function.js'
import { err, ok } from '../result.js'
import type { Result } from '../result.js'
import { Pipeable } from '../core/pipe.js'
import type {
  LiteralCoverage,
  MatchCoverage,
  MatchNarrowed,
  MatchPattern,
  MatchRefinement,
  MatchRemaining,
} from './match-pattern.js'
import { compileMatchPattern } from './match-pattern.js'

export type { MatchPattern, MatchRefinement } from './match-pattern.js'

/** Appears in exhaustive-call diagnostics with the input cases that still need a handler. */
export interface MatchMissingCases<Remaining> {
  readonly missingCases: Remaining
}

declare const matchState: unique symbol
interface MatchState<
  Input,
  Remaining,
  Matched,
  Kind extends Mode,
  Args extends readonly unknown[],
  Target,
> {
  readonly [matchState]: {
    readonly input: Input
    readonly remaining: Remaining
    readonly matched: Matched
    readonly kind: Kind
    readonly args: Args
    readonly target: Target
  }
}

// Defer the homomorphic mapping so callback arity cannot infer a shorter tuple.
// Once the matcher supplies Args, mapping preserves optional and rest elements.
type HandlerArgs<Args extends readonly unknown[]> = Args extends readonly unknown[]
  ? { [Key in keyof Args]: NoInfer<Args[Key]> }
  : never

type DefinedValue = object | string | number | boolean | bigint | symbol

type Mode = 'value' | 'type' | 'fn' | 'context'
type Output<
  Input,
  Matched,
  Kind extends Mode,
  Args extends readonly unknown[],
> = Kind extends 'value'
  ? Matched
  : Kind extends 'fn'
    ? (...args: Args) => Matched
    : Kind extends 'context'
      ? (value: Input, ...args: Args) => Matched
      : (value: Input) => Matched
type TagsOf<Input, Key extends PropertyKey = '_tag'> =
  Input extends Readonly<Record<Key, infer Tag>> ? Extract<Tag, PropertyKey> : never
type Variant<Input, Key extends PropertyKey, Tag> = MatchNarrowed<Input, Readonly<Record<Key, Tag>>>
type HandlerOutput<Cases> = Cases extends unknown
  ? {
      [Key in keyof Cases]-?: [NonNullable<Cases[Key]>] extends [never]
        ? never
        : NonNullable<Cases[Key]> extends (...args: never[]) => infer Value
          ? Value
          : never
    }[keyof Cases]
  : never
type DefinedCaseKeys<Cases> = {
  [Key in keyof Cases]-?: Cases[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof Cases]
type PartialTable<Input, Key extends PropertyKey, Target, Args extends readonly unknown[]> = {
  readonly [Tag in TagsOf<Input, Key>]?:
    | ((value: Variant<Input, Key, Tag>, ...args: Args) => Target)
    | undefined
}

type ExactHandlers<Cases, Allowed extends PropertyKey> = {
  readonly [Key in keyof Cases]: Key extends Allowed ? Cases[Key] : never
}
type Table<Input, Key extends PropertyKey, Target, Args extends readonly unknown[]> = {
  readonly [Tag in TagsOf<Input, Key>]: (value: Variant<Input, Key, Tag>, ...args: Args) => Target
}
type Finite<Key extends PropertyKey> = string extends Key
  ? never
  : number extends Key
    ? never
    : symbol extends Key
      ? never
      : Key
type TableInput<Input, Key extends PropertyKey> = [Input] extends [
  Readonly<Record<Key, Finite<TagsOf<Input, Key>>>>,
]
  ? Input
  : never
type CoveredLiterals<Values extends readonly unknown[]> = number extends Values['length']
  ? never
  : { [Key in keyof Values]: LiteralCoverage<Values[Key]> }[number]
type OrRemaining<Input, Patterns extends readonly unknown[]> = Patterns extends readonly [
  infer First,
  ...infer Rest,
]
  ? OrRemaining<MatchRemaining<Input, First>, Rest>
  : Input
type AndNarrowed<Input, Patterns extends readonly unknown[]> = Patterns extends readonly [
  infer First,
  ...infer Rest,
]
  ? AndNarrowed<MatchNarrowed<Input, First>, Rest>
  : Input
type AndCoverage<Patterns extends readonly unknown[]> = number extends Patterns['length']
  ? never
  : Patterns extends readonly [infer First, ...infer Rest]
    ? MatchCoverage<First> & AndCoverage<Rest>
    : unknown
type AndRemaining<Input, Patterns extends readonly unknown[]> =
  | Exclude<Input, AndCoverage<Patterns>>
  | ([Exclude<Extract<Patterns[number], object>, (...args: never[]) => unknown>] extends [never]
      ? never
      : Extract<Input, (...args: never[]) => unknown>)

/** Optional match output as a plain tagged value. */
export type MatchOption<Value> =
  | { readonly _tag: 'Some'; readonly value: Value }
  | { readonly _tag: 'None' }

/**
 * Immutable pattern-matching builder supporting both fluent method chaining and `pipe(matcher, Match.*)`.
 *
 * In `Match.value(input)` mode, the first matching handler executes eagerly as soon as its case is added;
 * in `Match.type()`, `Match.fn()`, and `Match.context()` modes, cases are compiled once and evaluated per call.
 *
 * @example
 * ```ts
 * import { Match } from 'resultar'
 *
 * type Event =
 *   | { readonly _tag: 'Created'; readonly id: string }
 *   | { readonly _tag: 'Deleted'; readonly id: string }
 *
 * const describe = Match.type<Event>().tagsExhaustive({
 *   Created: (e) => `created:${e.id}`,
 *   Deleted: (e) => `deleted:${e.id}`,
 * })
 * ```
 */
export interface MatchMatcher<
  Input,
  Remaining = Input,
  Matched = never,
  Kind extends Mode = 'value',
  Args extends readonly unknown[] = [],
  Target = unknown,
>
  extends Pipeable, MatchState<Input, Remaining, Matched, Kind, Args, Target> {
  /** Matches inputs satisfying `pattern` (literal, predicate/refinement, nested object, or tuple/array prefix). */
  when: <const Pattern extends MatchPattern<Remaining>, Next extends Target>(
    pattern: Pattern,
    handler: (value: MatchNarrowed<Remaining, Pattern>, ...args: Args) => Next,
  ) => MatchMatcher<Input, MatchRemaining<Remaining, Pattern>, Matched | Next, Kind, Args, Target>
  /** Matches inputs satisfying at least one of the supplied `patterns`. */
  whenOr: <
    const Patterns extends readonly [MatchPattern<Remaining>, ...MatchPattern<Remaining>[]],
    Next extends Target,
  >(
    ...patternsAndHandler: [
      ...Patterns,
      (value: MatchNarrowed<Remaining, Patterns[number]>, ...args: Args) => Next,
    ]
  ) => MatchMatcher<Input, OrRemaining<Remaining, Patterns>, Matched | Next, Kind, Args, Target>
  /** Matches inputs satisfying every supplied pattern in `patterns`. */
  whenAnd: <
    const Patterns extends readonly [MatchPattern<Remaining>, ...MatchPattern<Remaining>[]],
    Next extends Target,
  >(
    ...patternsAndHandler: [
      ...Patterns,
      (value: AndNarrowed<Remaining, Patterns>, ...args: Args) => Next,
    ]
  ) => MatchMatcher<Input, AndRemaining<Remaining, Patterns>, Matched | Next, Kind, Args, Target>
  /** Matches inputs that do *not* satisfy `pattern`, narrowing the handler parameter to the complement. */
  not: <const Pattern extends MatchPattern<Remaining>, Next extends Target>(
    pattern: Pattern,
    handler: (value: MatchRemaining<Remaining, Pattern>, ...args: Args) => Next,
  ) => MatchMatcher<Input, MatchNarrowed<Remaining, Pattern>, Matched | Next, Kind, Args, Target>
  /** Matches one or more `_tag` discriminant values with a single narrowed handler. */
  tag: <
    const Tags extends readonly [TagsOf<Remaining> & string, ...(TagsOf<Remaining> & string)[]],
    Next extends Target,
  >(
    ...tagsAndHandler: [
      ...Tags,
      (value: Variant<Remaining, '_tag', Tags[number]>, ...args: Args) => Next,
    ]
  ) => MatchMatcher<
    Input,
    Exclude<Remaining, Readonly<Record<'_tag', CoveredLiterals<Tags>>>>,
    Matched | Next,
    Kind,
    Args,
    Target
  >
  /** Adds a partial handler table keyed by `_tag`; omitted tags remain in the unhandled union. */
  tags: <const Cases extends object>(
    handlers: Cases &
      PartialTable<Remaining, '_tag', Target, Args> &
      ExactHandlers<Cases, TagsOf<Remaining>>,
  ) => MatchMatcher<
    Input,
    Exclude<Remaining, Readonly<Record<'_tag', DefinedCaseKeys<Cases>>>>,
    Matched | HandlerOutput<Cases>,
    Kind,
    Args,
    Target
  >
  /** Completes the matcher with an exhaustive handler table covering every remaining `_tag`. */
  tagsExhaustive: <const Cases extends object>(
    handlers: Cases &
      Table<Remaining, '_tag', Target, Args> &
      ExactHandlers<Cases, TagsOf<Remaining>> &
      ([Remaining] extends [TableInput<Remaining, '_tag'>] ? unknown : never),
  ) => Output<Input, Matched | HandlerOutput<Cases>, Kind, Args>
  /** Completes the matcher only when `Remaining` has been narrowed to `never`. */
  exhaustive: (
    this: MatchMatcher<Input, Remaining, Matched, Kind, Args, Target> &
      ([Remaining] extends [never] ? unknown : MatchMissingCases<Remaining>),
  ) => Output<Input, Matched, Kind, Args>
  /** Completes the matcher with a fallback handler receiving any unhandled `Remaining` input. */
  orElse: <Next extends Target>(
    handler: (value: NoInfer<Remaining>, ...args: HandlerArgs<Args>) => Next,
  ) => Output<Input, Matched | Next, Kind, Args>
  /** Completes the matcher by throwing a `TypeError` at runtime if an unmatched value is reached. */
  orElseAbsurd: () => Output<Input, Matched, Kind, Args>
  /** Completes the matcher as `Ok(matchedValue)` or `Err(unmatchedRemainingInput)`. */
  result: () => Output<Input, Result<Matched, Remaining>, Kind, Args>
  /** Completes the matcher as `{ _tag: 'Some', value }` or `{ _tag: 'None' }`. */
  option: () => Output<Input, MatchOption<Matched>, Kind, Args>
}

type Handler = (value: never, ...args: readonly unknown[]) => unknown
type Case = (value: unknown) => Handler | undefined
type Selection = { readonly matched: false } | { readonly matched: true; readonly value: unknown }
const noMatch: Selection = { matched: false }
const unmatched = (): never => {
  throw new TypeError('Match: no case matched the input')
}
const property = (value: unknown, key: PropertyKey): unknown =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
    ? (value as Record<PropertyKey, unknown>)[key]
    : undefined
const predicateCase =
  (matches: (value: unknown) => boolean, handler: Handler): Case =>
  (input) =>
    matches(input) ? handler : undefined
const tableCases = (key: PropertyKey, handlers: object): readonly Case[] => {
  const table = new Map<PropertyKey, Handler>()
  for (const tag of Reflect.ownKeys(handlers)) {
    const handler = (handlers as Record<PropertyKey, unknown>)[tag]
    if (handler !== undefined) {
      if (typeof handler !== 'function') throw new TypeError('Match handlers must be functions')
      table.set(tag, handler as Handler)
    }
  }
  if (table.size === 0) return []
  return [
    (input: unknown) => {
      const actual = property(input, key)
      return table.get(typeof actual === 'number' ? String(actual) : (actual as PropertyKey))
    },
  ]
}

class Matcher extends Pipeable {
  readonly #kind: Mode
  readonly #input: unknown
  readonly #select: (...args: readonly unknown[]) => unknown
  readonly #cases: readonly Case[]
  readonly #selection: Selection
  // Internal persistent state has five independent fields.
  // eslint-disable-next-line max-params
  public constructor(
    kind: Mode,
    input: unknown,
    select: (...args: readonly unknown[]) => unknown,
    cases: readonly Case[] = [],
    selection: Selection = noMatch,
  ) {
    super()
    this.#kind = kind
    this.#input = input
    this.#select = select
    this.#cases = cases
    this.#selection = selection
  }
  public add(cases: readonly Case[]): Matcher {
    if (this.#kind !== 'value')
      return new Matcher(this.#kind, this.#input, this.#select, [...this.#cases, ...cases])
    if (this.#selection.matched) return this
    for (const resolveCase of cases) {
      const handler = resolveCase(this.#input)
      if (handler !== undefined)
        return new Matcher('value', this.#input, this.#select, [], {
          matched: true,
          value: handler(this.#input as never),
        })
    }
    return this
  }
  public when(pattern: unknown, handler: Handler): Matcher {
    return this.add([predicateCase(compileMatchPattern(pattern), handler)])
  }
  public whenOr(...patternsAndHandler: readonly unknown[]): Matcher {
    const patterns = patternsAndHandler.slice(0, -1).map(compileMatchPattern)
    return this.add([
      predicateCase(
        (input) => patterns.some((matches) => matches(input)),
        patternsAndHandler.at(-1) as Handler,
      ),
    ])
  }
  public whenAnd(...patternsAndHandler: readonly unknown[]): Matcher {
    const patterns = patternsAndHandler.slice(0, -1).map(compileMatchPattern)
    return this.add([
      predicateCase(
        (input) => patterns.every((matches) => matches(input)),
        patternsAndHandler.at(-1) as Handler,
      ),
    ])
  }
  public not(pattern: unknown, handler: Handler): Matcher {
    const matches = compileMatchPattern(pattern)
    return this.add([predicateCase((input) => !matches(input), handler)])
  }
  public tag(...tagsAndHandler: readonly unknown[]): Matcher {
    const tags = new Set(tagsAndHandler.slice(0, -1))
    return this.add([
      predicateCase((input) => tags.has(property(input, '_tag')), tagsAndHandler.at(-1) as Handler),
    ])
  }
  public tags(handlers: object): Matcher {
    return this.add(tableCases('_tag', handlers))
  }
  public tagsExhaustive(handlers: object): unknown {
    return this.tags(handlers).exhaustive()
  }
  public exhaustive(): unknown {
    return this.orElse(unmatched)
  }
  public orElseAbsurd(): unknown {
    return this.orElse(unmatched)
  }
  public orElse(handler: Handler): unknown {
    return this.finish((selected) => selected, handler)
  }
  public result(): unknown {
    return this.finish(ok, err)
  }
  public option(): unknown {
    return this.finish(
      (selected) => ({ _tag: 'Some', value: selected }),
      () => ({ _tag: 'None' }),
    )
  }
  public finish(matched: (value: unknown) => unknown, fallback: Handler): unknown {
    if (this.#kind === 'value')
      return this.#selection.matched
        ? matched(this.#selection.value)
        : fallback(this.#input as never)
    return (...args: readonly unknown[]) => {
      const input = this.#select(...args)
      let handlerArgs = args
      if (this.#kind === 'context') handlerArgs = args.slice(1)
      else if (this.#kind === 'type') handlerArgs = []
      for (const resolveCase of this.#cases) {
        const handler = resolveCase(input)
        if (handler !== undefined) return matched(handler(input as never, ...handlerArgs))
      }
      return fallback(input as never, ...handlerArgs)
    }
  }
}

const runtime = (self: object): Matcher => self as Matcher
const value = <const Input>(input: Input): MatchMatcher<Input> =>
  new Matcher('value', input, identity) as unknown as MatchMatcher<Input>
const type = <Input>(): MatchMatcher<Input, Input, never, 'type'> =>
  new Matcher('type', undefined, identity) as unknown as MatchMatcher<Input, Input, never, 'type'>
const fn = <Args extends readonly unknown[], Input>(
  select: (...args: Args) => Input,
): MatchMatcher<Input, Input, never, 'fn', Args> =>
  new Matcher(
    'fn',
    undefined,
    select as (...args: readonly unknown[]) => unknown,
  ) as unknown as MatchMatcher<Input, Input, never, 'fn', Args>

/** Match the first argument and pass the remaining arguments directly to each handler. */
const context = <Input, Args extends readonly unknown[]>(): MatchMatcher<
  Input,
  Input,
  never,
  'context',
  Args
> =>
  new Matcher('context', undefined, identity) as unknown as MatchMatcher<
    Input,
    Input,
    never,
    'context',
    Args
  >

const when =
  <
    Remaining,
    const Pattern extends MatchPattern<NoInfer<Remaining>>,
    Args extends readonly unknown[],
    Target,
    Next extends Target,
  >(
    pattern: Pattern,
    handler: (
      value: MatchNarrowed<NoInfer<Remaining>, Pattern>,
      ...args: HandlerArgs<Args>
    ) => Next,
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): MatchMatcher<Input, MatchRemaining<Remaining, Pattern>, Matched | Next, Kind, Args, Target> =>
    runtime(self).when(pattern, handler as unknown as Handler) as never
const whenOr =
  <
    Remaining,
    const Patterns extends readonly [
      MatchPattern<NoInfer<Remaining>>,
      ...MatchPattern<NoInfer<Remaining>>[],
    ],
    Args extends readonly unknown[],
    Target,
    Next extends Target,
  >(
    ...patternsAndHandler: [
      ...Patterns,
      (
        value: MatchNarrowed<NoInfer<Remaining>, Patterns[number]>,
        ...args: HandlerArgs<Args>
      ) => Next,
    ]
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): MatchMatcher<Input, OrRemaining<Remaining, Patterns>, Matched | Next, Kind, Args, Target> =>
    runtime(self).whenOr(...patternsAndHandler) as never
const whenAnd =
  <
    Remaining,
    const Patterns extends readonly [
      MatchPattern<NoInfer<Remaining>>,
      ...MatchPattern<NoInfer<Remaining>>[],
    ],
    Args extends readonly unknown[],
    Target,
    Next extends Target,
  >(
    ...patternsAndHandler: [
      ...Patterns,
      (value: AndNarrowed<Remaining, Patterns>, ...args: HandlerArgs<Args>) => Next,
    ]
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): MatchMatcher<Input, AndRemaining<Remaining, Patterns>, Matched | Next, Kind, Args, Target> =>
    runtime(self).whenAnd(...patternsAndHandler) as never
const not =
  <
    Remaining,
    const Pattern extends MatchPattern<NoInfer<Remaining>>,
    Args extends readonly unknown[],
    Target,
    Next extends Target,
  >(
    pattern: Pattern,
    handler: (
      value: MatchRemaining<NoInfer<Remaining>, Pattern>,
      ...args: HandlerArgs<Args>
    ) => Next,
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): MatchMatcher<
    Input,
    MatchNarrowed<NoInfer<Remaining>, Pattern>,
    Matched | Next,
    Kind,
    Args,
    Target
  > =>
    runtime(self).not(pattern, handler as unknown as Handler) as never
const tag =
  <
    Remaining,
    const Tags extends readonly [
      TagsOf<NoInfer<Remaining>> & string,
      ...(TagsOf<NoInfer<Remaining>> & string)[],
    ],
    Args extends readonly unknown[],
    Target,
    Next extends Target,
  >(
    ...tagsAndHandler: [
      ...Tags,
      (
        value: Variant<NoInfer<Remaining>, '_tag', Tags[number]>,
        ...args: HandlerArgs<Args>
      ) => Next,
    ]
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): MatchMatcher<
    Input,
    Exclude<Remaining, Readonly<Record<'_tag', CoveredLiterals<Tags>>>>,
    Matched | Next,
    Kind,
    Args,
    Target
  > =>
    runtime(self).tag(...tagsAndHandler) as never

type Contextual<Cases, Fallback> = [Cases] extends [never] ? Fallback : Cases
type TableShape<
  Remaining,
  Key extends PropertyKey,
  Target,
  Args extends readonly unknown[],
  Exhaustive extends boolean,
> = Exhaustive extends true
  ? Table<Remaining, Key, Target, Args>
  : PartialTable<Remaining, Key, Target, Args>
type AddTable<Key extends PropertyKey, Exhaustive extends boolean> = <
  Remaining,
  Args extends readonly unknown[],
  Target,
  const Cases extends TableShape<NoInfer<Remaining>, Key, Target, HandlerArgs<Args>, Exhaustive> &
    ExactHandlers<Cases, TagsOf<NoInfer<Remaining>, Key>>,
>(
  handlers: Contextual<
    Cases,
    TableShape<NoInfer<Remaining>, Key, Target, HandlerArgs<Args>, Exhaustive>
  >,
) => <Input, Matched, Kind extends Mode>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target> &
    (Exhaustive extends true
      ? [Remaining] extends [TableInput<Remaining, Key>]
        ? unknown
        : never
      : unknown),
) => Exhaustive extends true
  ? Output<Input, Matched | HandlerOutput<Cases>, Kind, Args>
  : MatchMatcher<
      Input,
      Exclude<Remaining, Readonly<Record<Key, DefinedCaseKeys<Cases>>>>,
      Matched | HandlerOutput<Cases>,
      Kind,
      Args,
      Target
    >

type AddDiscriminator<Key extends PropertyKey> = <
  Remaining,
  const Tags extends readonly [
    TagsOf<NoInfer<Remaining>, Key>,
    ...TagsOf<NoInfer<Remaining>, Key>[],
  ],
  Args extends readonly unknown[],
  Target,
  Next extends Target,
>(
  ...tagsAndHandler: [
    ...Tags,
    (value: Variant<NoInfer<Remaining>, Key, Tags[number]>, ...args: HandlerArgs<Args>) => Next,
  ]
) => <Input, Matched, Kind extends Mode>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
) => MatchMatcher<
  Input,
  Exclude<Remaining, Readonly<Record<Key, CoveredLiterals<Tags>>>>,
  Matched | Next,
  Kind,
  Args,
  Target
>

type AddPrefix<Key extends PropertyKey> = <
  Remaining,
  const Prefix extends string,
  Args extends readonly unknown[],
  Target,
  Next extends Target,
>(
  prefix: Prefix,
  handler: (
    value: Variant<NoInfer<Remaining>, Key, `${Prefix}${string}`>,
    ...args: HandlerArgs<Args>
  ) => Next,
) => <Input, Matched, Kind extends Mode>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
) => MatchMatcher<
  Input,
  Exclude<Remaining, Readonly<Record<Key, `${LiteralCoverage<Prefix>}${string}`>>>,
  Matched | Next,
  Kind,
  Args,
  Target
>

const discriminators =
  <Key extends PropertyKey>(key: Key): AddTable<Key, false> =>
  (handlers) => {
    const compiled = tableCases(key, handlers)
    return (self) => runtime(self).add(compiled) as never
  }
const discriminatorsExhaustive =
  <Key extends PropertyKey>(key: Key): AddTable<Key, true> =>
  (handlers) => {
    const compiled = tableCases(key, handlers)
    return (self) => runtime(self).add(compiled).exhaustive() as never
  }
const discriminator =
  <Key extends PropertyKey>(key: Key): AddDiscriminator<Key> =>
  (...tagsAndHandler) =>
  (self) => {
    const selected = new Set<unknown>(tagsAndHandler.slice(0, -1))
    return runtime(self).add([
      predicateCase(
        (input) => selected.has(property(input, key)),
        tagsAndHandler.at(-1) as Handler,
      ),
    ]) as never
  }
const discriminatorStartsWith =
  <Key extends PropertyKey>(key: Key): AddPrefix<Key> =>
  (prefix, handler) =>
  (self) =>
    runtime(self).add([
      predicateCase(
        (input) => {
          const discriminatorValue = property(input, key)
          return typeof discriminatorValue === 'string' && discriminatorValue.startsWith(prefix)
        },
        handler as unknown as Handler,
      ),
    ]) as never

const tags: AddTable<'_tag', false> = discriminators('_tag')
const tagsExhaustive: AddTable<'_tag', true> = discriminatorsExhaustive('_tag')
const tagStartsWith: AddPrefix<'_tag'> = discriminatorStartsWith('_tag')
const exhaustive = <Input, Matched, Kind extends Mode, Args extends readonly unknown[], Target>(
  self: MatchState<Input, never, Matched, Kind, Args, Target>,
): Output<Input, Matched, Kind, Args> =>
  runtime(self).exhaustive() as Output<Input, Matched, Kind, Args>
const orElseAbsurd = <
  Input,
  Remaining,
  Matched,
  Kind extends Mode,
  Args extends readonly unknown[],
  Target,
>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
): Output<Input, Matched, Kind, Args> =>
  runtime(self).orElseAbsurd() as Output<Input, Matched, Kind, Args>
const result = <
  Input,
  Remaining,
  Matched,
  Kind extends Mode,
  Args extends readonly unknown[],
  Target,
>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
): Output<Input, Result<Matched, Remaining>, Kind, Args> =>
  runtime(self).result() as Output<Input, Result<Matched, Remaining>, Kind, Args>
const option = <
  Input,
  Remaining,
  Matched,
  Kind extends Mode,
  Args extends readonly unknown[],
  Target,
>(
  self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
): Output<Input, MatchOption<Matched>, Kind, Args> =>
  runtime(self).option() as Output<Input, MatchOption<Matched>, Kind, Args>
const orElse =
  <Remaining, Args extends readonly unknown[], Target, Next extends Target>(
    handler: (value: NoInfer<Remaining>, ...args: HandlerArgs<Args>) => Next,
  ) =>
  <Input, Matched, Kind extends Mode>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Target>,
  ): Output<Input, Matched | Next, Kind, Args> =>
    runtime(self).orElse(handler as unknown as Handler) as never

const typeTags =
  <Input extends { readonly _tag: string }, Target = unknown>() =>
  <const Cases extends object>(
    handlers: Cases &
      Table<NoInfer<Input>, '_tag', Target, []> &
      ExactHandlers<Cases, Input['_tag']> &
      ([Input] extends [TableInput<Input, '_tag'>] ? unknown : never),
  ): ((input: Input) => HandlerOutput<Cases>) =>
    runtime(type<Input>()).tagsExhaustive(handlers) as (input: Input) => HandlerOutput<Cases>
function valueTags<Input extends { readonly _tag: string }, const Cases extends object>(
  input: TableInput<Input, '_tag'>,
  handlers: Cases &
    Table<NoInfer<Input>, '_tag', unknown, []> &
    ExactHandlers<Cases, Input['_tag']>,
): HandlerOutput<Cases>
function valueTags<Input extends { readonly _tag: string }, const Cases extends object>(
  handlers: Cases & Table<Input, '_tag', unknown, []> & ExactHandlers<Cases, Input['_tag']>,
): (input: TableInput<Input, '_tag'>) => HandlerOutput<Cases>
function valueTags(inputOrHandlers: object, handlers?: object): unknown {
  return handlers === undefined
    ? new Matcher('type', undefined, identity).tagsExhaustive(inputOrHandlers)
    : new Matcher('value', inputOrHandlers, identity).tagsExhaustive(handlers)
}
const withReturnType =
  <Target>() =>
  <Input, Remaining, Matched, Kind extends Mode, Args extends readonly unknown[], Previous>(
    self: MatchState<Input, Remaining, Matched, Kind, Args, Previous> &
      ([Matched] extends [Target] ? unknown : never),
  ): MatchMatcher<Input, Remaining, Matched, Kind, Args, Target> =>
    self as unknown as MatchMatcher<Input, Remaining, Matched, Kind, Args, Target>
const instanceOf = <Constructor extends abstract new (...args: never[]) => object>(
  constructor: Constructor,
): MatchRefinement<InstanceType<Constructor>, never> =>
  ((input: unknown) => input instanceof constructor) as MatchRefinement<
    InstanceType<Constructor>,
    never
  >
const instanceOfUnsafe = <Constructor extends abstract new (...args: never[]) => object>(
  constructor: Constructor,
): MatchRefinement<InstanceType<Constructor>> =>
  ((input: unknown) => input instanceof constructor) as MatchRefinement<InstanceType<Constructor>>
const is = <
  const Literals extends readonly [
    string | number | boolean | bigint | symbol | null | undefined,
    ...(string | number | boolean | bigint | symbol | null | undefined)[],
  ],
>(
  ...literals: Literals
): MatchRefinement<Literals[number], CoveredLiterals<Literals>> =>
  ((input: unknown) => literals.includes(input as Literals[number])) as MatchRefinement<
    Literals[number],
    CoveredLiterals<Literals>
  >

/**
 * Typed pattern matching with native `Result` finalization, pipeable combinators, and fluent methods.
 *
 * @example
 * ```ts
 * import { Match } from 'resultar'
 *
 * type Shape =
 *   | { readonly _tag: 'Circle'; readonly radius: number }
 *   | { readonly _tag: 'Square'; readonly side: number }
 *
 * const area = (shape: Shape): number =>
 *   Match.valueTags(shape, {
 *     Circle: ({ radius }) => Math.PI * radius ** 2,
 *     Square: ({ side }) => side ** 2,
 *   })
 * ```
 */
export const Match: {
  /** Match one value eagerly; the first matching handler executes as its case is added. */
  readonly value: typeof value
  /** Build a reusable matcher without executing any cases until invoked. */
  readonly type: typeof type
  /** Select from original arguments; handlers receive the selection followed by those arguments. */
  readonly fn: typeof fn
  /** Match an input and pass a typed context tuple to handlers without repeating the input. */
  readonly context: typeof context
  /** Dispatch a value directly through an exhaustive tag table; also accepts a curried table. */
  readonly valueTags: typeof valueTags
  /** Build a reusable exhaustive tag function with inferred returns or an explicit return contract. */
  readonly typeTags: typeof typeTags
  /** Add a literal, predicate, nested plain-object or array-prefix case. */
  readonly when: typeof when
  /** Add one case that accepts any of the supplied patterns. */
  readonly whenOr: typeof whenOr
  /** Add one case that requires every supplied pattern. */
  readonly whenAnd: typeof whenAnd
  /** Add a case for inputs that do not match the supplied pattern. */
  readonly not: typeof not
  /** Handle one or several `_tag` values with a narrowed callback. */
  readonly tag: typeof tag
  /** Add a partial `_tag` table; absent handlers leave their inputs unmatched. */
  readonly tags: typeof tags
  /** Complete with a table covering every remaining `_tag`. */
  readonly tagsExhaustive: typeof tagsExhaustive
  /** Match `_tag` values starting with a string literal prefix (`${Prefix}${string}`). */
  readonly tagStartsWith: typeof tagStartsWith
  /** Match exact values of a chosen discriminant property. */
  readonly discriminator: typeof discriminator
  /** Add a partial handler table for a chosen discriminant property. */
  readonly discriminators: typeof discriminators
  /** Complete with every remaining value of a chosen discriminant property. */
  readonly discriminatorsExhaustive: typeof discriminatorsExhaustive
  /** Match string values of a chosen discriminant property starting with a literal prefix. */
  readonly discriminatorStartsWith: typeof discriminatorStartsWith
  /** Complete only when every input case has been proved handled. */
  readonly exhaustive: typeof exhaustive
  /** Complete with a fallback receiving the remaining input and selector arguments. */
  readonly orElse: typeof orElse
  /** Complete with a runtime exception on unmatched input, without a coverage proof. */
  readonly orElseAbsurd: typeof orElseAbsurd
  /** Complete as a native Resultar `Ok` or `Err` containing the original unmatched input. */
  readonly result: typeof result
  /** Complete as a plain `Some` or `None` tagged value. */
  readonly option: typeof option
  /** Require subsequent handlers and existing branches to satisfy an output contract. */
  readonly withReturnType: typeof withReturnType
  /** Narrow class instances while retaining structural lookalikes as possible unmatched input. */
  readonly instanceOf: typeof instanceOf
  /** Opt into excluding structural class types after nominal instance matching. */
  readonly instanceOfUnsafe: typeof instanceOfUnsafe
  /** Match any of the supplied primitive literal values with full coverage tracking. */
  readonly is: typeof is
  /** Built-in refinement matching any `string`. */
  readonly string: (input: unknown) => input is string
  /** Built-in refinement matching any `number` (including `NaN` and infinities). */
  readonly number: (input: unknown) => input is number
  /** Built-in refinement matching any `boolean`. */
  readonly boolean: (input: unknown) => input is boolean
  /** Built-in refinement matching any `bigint`. */
  readonly bigint: (input: unknown) => input is bigint
  /** Built-in refinement matching any `symbol`. */
  readonly symbol: (input: unknown) => input is symbol
  /** Built-in refinement matching `null`. */
  readonly null: (input: unknown) => input is null
  /** Built-in refinement matching `Date` instances. */
  readonly date: (input: unknown) => input is Date
  /** Built-in refinement matching non-null, non-array objects without subtracting structural records. */
  readonly record: MatchRefinement<Record<PropertyKey, unknown>, never>
  /** Built-in refinement matching non-empty strings without subtracting `string`. */
  readonly nonEmptyString: MatchRefinement<string, never>
  /** Built-in refinement matching any non-nullish value (`!== null && !== undefined`). */
  readonly defined: (input: unknown) => input is DefinedValue
  /** Built-in refinement matching every input value (`unknown`). */
  readonly any: (input: unknown) => input is unknown
} = {
  value,
  type,
  fn,
  context,
  valueTags,
  typeTags,
  when,
  whenOr,
  whenAnd,
  not,
  tag,
  tags,
  tagsExhaustive,
  tagStartsWith,
  discriminator,
  discriminators,
  discriminatorsExhaustive,
  discriminatorStartsWith,
  exhaustive,
  orElse,
  orElseAbsurd,
  result,
  option,
  withReturnType,
  instanceOf,
  instanceOfUnsafe,
  is,
  string: (input): input is string => typeof input === 'string',
  number: (input): input is number => typeof input === 'number',
  boolean: (input): input is boolean => typeof input === 'boolean',
  bigint: (input): input is bigint => typeof input === 'bigint',
  symbol: (input): input is symbol => typeof input === 'symbol',
  null: (input): input is null => input === null,
  date: (input): input is Date => input instanceof Date,
  record: ((input: unknown) =>
    typeof input === 'object' && input !== null && !Array.isArray(input)) as MatchRefinement<
    Record<PropertyKey, unknown>,
    never
  >,
  nonEmptyString: ((input: unknown) =>
    typeof input === 'string' && input.length > 0) as MatchRefinement<string, never>,
  defined: (input): input is DefinedValue => input !== null && input !== undefined,
  any: (_input): _input is unknown => true,
}
