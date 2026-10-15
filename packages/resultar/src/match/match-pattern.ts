type Primitive = string | number | boolean | bigint | symbol | null | undefined
type Predicate<Input> = (value: Input) => boolean
declare const refinementType: unique symbol

/** Separates callback narrowing from types proven to be fully covered by a predicate. */
export type MatchRefinement<Narrowed, Covered = Narrowed> = ((value: unknown) => boolean) & {
  readonly [refinementType]: { readonly narrowed: Narrowed; readonly covered: Covered }
}

type UnknownPattern =
  | Primitive
  | Predicate<unknown>
  | { readonly [key: string]: UnknownPattern; readonly [key: symbol]: UnknownPattern }
  | readonly UnknownPattern[]

/** Literals, predicates, partial object patterns and array-prefix patterns. */
export type MatchPattern<Input> =
  | Predicate<Input>
  | (unknown extends Input
      ? UnknownPattern
      : Input extends Primitive
        ? Input
        : Input extends readonly unknown[]
          ? { readonly [Key in keyof Input]?: MatchPattern<Input[Key]> }
          : Input extends object
            ? { readonly [Key in keyof Input]?: MatchPattern<Input[Key]> }
            : never)

type GuardShape<Pattern, Input> = Pattern extends ((
  value: Input,
) => value is Input & (infer Narrowed))
  ? Input & Narrowed
  : unknown

type GuardCoverage<Pattern, Input> = Pattern extends ((
  value: Input,
) => value is Input & (infer Narrowed))
  ? Input & Narrowed
  : never

type PatternShape<Pattern> =
  Pattern extends MatchRefinement<infer Narrowed, infer _Covered>
    ? Narrowed
    : Pattern extends (value: infer Input) => boolean
      ? GuardShape<Pattern, Input>
      : Pattern extends Primitive
        ? Pattern
        : Pattern extends readonly unknown[]
          ? readonly [...{ [Key in keyof Pattern]: PatternShape<Pattern[Key]> }, ...unknown[]]
          : { readonly [Key in keyof Pattern]: PatternShape<Pattern[Key]> }

/** Narrows the selected branch without widening the original input. */
export type MatchNarrowed<Input, Pattern> = Input extends infer Member
  ? Member extends PatternShape<Pattern>
    ? Member
    : Member & PatternShape<Pattern>
  : never

type IsUnion<Value, Whole = Value> = Value extends Whole
  ? [Whole] extends [Value]
    ? false
    : true
  : never

// A variable containing one of several literals does not handle every literal in its type.
export type LiteralCoverage<Value> =
  true extends IsUnion<Value>
    ? never
    : string extends Value
      ? never
      : number extends Value
        ? never
        : bigint extends Value
          ? never
          : symbol extends Value
            ? never
            : Value

export type MatchCoverage<Pattern> =
  true extends IsUnion<Pattern>
    ? never
    : [Pattern] extends [MatchRefinement<infer _Narrowed, infer Covered>]
      ? Covered
      : [Pattern] extends [(value: infer Input) => boolean]
        ? GuardCoverage<Pattern, Input>
        : [Pattern] extends [Primitive]
          ? LiteralCoverage<Pattern>
          : Pattern extends readonly unknown[]
            ? number extends Pattern['length']
              ? never
              : true extends IsUnion<Pattern['length']>
                ? never
                : readonly [
                    ...{ [Key in keyof Pattern]: MatchCoverage<Pattern[Key]> },
                    ...unknown[],
                  ]
            : [FiniteKeys<Pattern>] extends [never]
              ? never
              : { readonly [Key in keyof Pattern]-?: MatchCoverage<Pattern[Key]> }

type FiniteKeys<Pattern> = string extends keyof Pattern
  ? never
  : number extends keyof Pattern
    ? never
    : symbol extends keyof Pattern
      ? never
      : keyof Pattern

type SubtractProperty<Input, Pattern, Key extends keyof Pattern> =
  Input extends Record<Key, infer Value>
    ? MatchRemaining<Value, Pattern[Key]> extends infer Remaining
      ? [Remaining] extends [never]
        ? never
        : [Value] extends [Remaining]
          ? Input
          : Omit<Input, Key> & Readonly<Record<Key, Remaining>>
      : Input
    : Input

// An object fails a conjunction when any required property fails. Keeping each
// complement as a union member preserves correlations across later cases.
type SubtractProperties<Input, Pattern> = {
  [Key in FiniteKeys<Pattern>]-?: SubtractProperty<Input, Pattern, Key>
}[FiniteKeys<Pattern>]

type RemainingMember<Input, Pattern> = Input extends (value: never) => unknown
  ? Pattern extends (value: never) => boolean
    ? Input extends MatchCoverage<Pattern>
      ? never
      : Input
    : Input
  : Input extends MatchCoverage<Pattern>
    ? never
    : Pattern extends object
      ? Pattern extends (value: never) => boolean
        ? Input
        : Pattern extends readonly unknown[]
          ? Input
          : [FiniteKeys<Pattern>] extends [never]
            ? Input
            : SubtractProperties<Input, Pattern>
      : Input

/** Boolean predicates never claim coverage; finite object patterns subtract literal field combinations. */
export type MatchRemaining<Input, Pattern> =
  true extends IsUnion<Pattern>
    ? Input
    : Input extends unknown
      ? RemainingMember<Input, Pattern>
      : never

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

/** Compile once so reusable matchers do not inspect their patterns on every invocation. */
export const compileMatchPattern = (pattern: unknown): Predicate<unknown> => {
  if (typeof pattern === 'function') return pattern as Predicate<unknown>

  if (Array.isArray(pattern)) {
    const elements = (pattern as readonly unknown[]).map(compileMatchPattern)
    return (value) =>
      Array.isArray(value) &&
      value.length >= elements.length &&
      elements.every((matches, index) => matches(value[index]))
  }

  if (isObject(pattern)) {
    const prototype: unknown = Object.getPrototypeOf(pattern)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Match object patterns must be plain objects')
    }
    const entries = Reflect.ownKeys(pattern).map(
      (key) => [key, compileMatchPattern(pattern[key])] as const,
    )
    return (value) =>
      isObject(value) && entries.every(([key, matches]) => key in value && matches(value[key]))
  }

  return (value) => value === pattern
}
