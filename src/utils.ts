import { ResultAsync } from './result-async.js'
import type { Result } from './result.js'
import { err, ok } from './result.js'

// Deduplicates the result, as the result type is a union of Err and Ok types.
export type Dedup<T> = T extends Result<infer RL, infer RR> ? Result<RL, RR>
  : T

// Given a union, this gives the array of the union members.
export type MemberListOf<T> = (
  (T extends unknown ? (t: T) => T : never) extends infer U
    ? (U extends unknown ? (u: U) => unknown : never) extends (v: infer V) => unknown ? V
    : never
    : never
) extends (_: unknown) => infer W ? [...MemberListOf<Exclude<T, W>>, W]
  : []

// Given a list of Results, this extracts all the different `T` types from that list
export type ExtractOkTypes<T extends ReadonlyArray<Result<unknown, unknown>>> = {
  [idx in keyof T]: T[idx] extends Result<infer U, unknown> ? U : never
}

// Given a list of ResultAsyncs, this extracts all the different `T` types from that list
export type ExtractOkAsyncTypes<T extends ReadonlyArray<ResultAsync<unknown, unknown>>> = {
  [idx in keyof T]: T[idx] extends ResultAsync<infer U, unknown> ? U : never
}

// Given a list of Results, this extracts all the different `E` types from that list
export type ExtractErrTypes<T extends ReadonlyArray<Result<unknown, unknown>>> = {
  [idx in keyof T]: T[idx] extends Result<unknown, infer E> ? E : never
}

// Given a list of ResultAsyncs, this extracts all the different `E` types from that list
export type ExtractErrAsyncTypes<T extends ReadonlyArray<ResultAsync<unknown, unknown>>> = {
  [idx in keyof T]: T[idx] extends ResultAsync<unknown, infer E> ? E : never
}

export type InferOkTypes<R> = R extends Result<infer T, unknown> ? T : never
export type InferErrTypes<R> = R extends Result<unknown, infer E> ? E : never

export type InferAsyncOkTypes<R> = R extends ResultAsync<infer T, unknown> ? T : never
export type InferAsyncErrTypes<R> = R extends ResultAsync<unknown, infer E> ? E : never

// Checks if the given type is a literal array.
export type IsLiteralArray<T> = T extends { length: infer L } ? L extends number ? number extends L ? 0
    : 1
  : 0
  : 0

// Converts an empty array to never.
//
// The second type parameter here will affect how to behave to `never[]`s.
// If a precise type is required, pass `1` here so that it will resolve
// a literal array such as `[ never, never ]`. Otherwise, set `0` or the default
// type value will cause this to resolve the arrays containing only `never`
// items as `never` only.
export type EmptyArrayToNever<T, NeverArrayToNever extends number = 0> = T extends [] ? never
  : NeverArrayToNever extends 1 ? T extends [never, ...infer Rest] ? [EmptyArrayToNever<Rest>] extends [never] ? never
      : T
    : T
  : T

// #region Combine - Types

// This is a helper type to prevent infinite recursion in typing rules.
//
// Use this with your `depth` variable in your types.
type Prev = [
  never,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  44,
  45,
  46,
  47,
  48,
  49,
  ...Array<0>,
]

// Transposes an array
//
// A          - The array source
// Transposed - The collected transposed array
// Depth      - The maximum depth.
export type Transpose<
  A,
  Transposed extends unknown[][] = [],
  Depth extends number = 10,
> = A extends [infer T, ...infer Rest]
  ? T extends [infer L, infer R]
    ? Transposed extends [infer PL, infer PR]
      ? PL extends unknown[] ? PR extends unknown[] ? Transpose<Rest, [[...PL, L], [...PR, R]], Prev[Depth]>
        : never
      : never
    : Transpose<Rest, [[L], [R]], Prev[Depth]>
  : Transposed
  : Transposed

// Collects the results array into separate tuple array.
//
// T         - The array of the results
// Collected - The collected tuples.
// Depth     - The maximum depth.
type CollectResults<T, Collected extends unknown[] = [], Depth extends number = 50> = [
  Depth,
] extends [never] ? []
  : T extends [infer H, ...infer Rest]
  // And test whether the head of the list is a result
    ? H extends Result<infer L, infer R>
      // Continue collecting...
      ? CollectResults<
        // the rest of the elements
        Rest,
        // The collected
        [...Collected, [L, R]],
        // and one less of the current depth
        Prev[Depth]
      >
    : never // Impossible
  : Collected

// Converts the `unknown` items of an array to `never`s.
type UnknownMembersToNever<T> = T extends [infer H, ...infer R]
  ? [[unknown] extends [H] ? never : H, ...UnknownMembersToNever<R>]
  : T

// Gets the member type of the array or never.
export type MembersToUnion<T> = T extends unknown[] ? T[number] : never

// Combines the both sides of the array of the results into a tuple of the
// union of the ok types and the union of the err types.
//
// T     - The array of the results
// Depth - The maximum depth.
export type Combine<T, Depth extends number = 5> = Transpose<CollectResults<T>, [], Depth> extends [
  infer L,
  infer R,
] ? [UnknownMembersToNever<L>, UnknownMembersToNever<R>]
  : Transpose<CollectResults<T>, [], Depth> extends [] ? [[], []]
  : never

// Traverses an array of results and returns a single result containing
// the oks and errs union-ed/combined.
type Traverse<T, Depth extends number = 5> = Combine<T, Depth> extends [infer Oks, infer Errs]
  ? Result<EmptyArrayToNever<Oks, 1>, MembersToUnion<Errs>>
  : never

// Traverses an array of results and returns a single result containing
// the oks combined and the array of errors combined.
type TraverseWithAllErrors<T, Depth extends number = 5> = Combine<T, Depth> extends [
  infer Oks,
  infer Errs,
] ? Result<EmptyArrayToNever<Oks>, EmptyArrayToNever<Errs>>
  : never

const appendValueToEndOfList = <T>(value: T) => (list: T[]): T[] => [...list, value]

export type CombineResults<
  T extends ReadonlyArray<Result<unknown, unknown>>,
> = IsLiteralArray<T> extends 1 ? Traverse<T>
  : Result<ExtractOkTypes<T>, ExtractErrTypes<T>[number]>

// Combines the array of results into one result with all errors.
export type CombineResultsWithAllErrorsArray<
  T extends ReadonlyArray<Result<unknown, unknown>>,
> = IsLiteralArray<T> extends 1 ? TraverseWithAllErrors<T>
  : Result<ExtractOkTypes<T>, Array<ExtractErrTypes<T>[number]>>

/* This is the typesafe version of Promise.all
 *
 * Takes a list of ResultAsync<T, E> and success if all inner results are Ok values
 * or fails if one (or more) of the inner results are Err values
 */
export const combineResultAsyncList = <T, E>(
  asyncResultList: ReadonlyArray<ResultAsync<T, E>>,
): ResultAsync<readonly T[], E> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen(
    combineResultList,
  ) as ResultAsync<T[], E>

/**
 * Short circuits on the FIRST Err value that we find
 */
export const combineResultList = <T, E>(
  resultList: ReadonlyArray<Result<T, E>>,
): Result<readonly T[], E> =>
  resultList.reduce<Result<T[], E>>( // eslint-disable-line unicorn/no-array-reduce
    (acc, result) =>
      acc.isOk()
        ? (result.isErr()
          ? err(result.error)
          : acc.map(appendValueToEndOfList(result.value)))
        : acc,
    ok([]),
  )

/* This is the typesafe version of Promise.all
 *
 * Takes a list of ResultAsync<T, E> and success if all inner results are Ok values
 * or fails if one (or more) of the inner results are Err values
 */
export const combineResultAsyncListWithAllErrors = <T, E>(
  asyncResultList: ReadonlyArray<ResultAsync<T, E>>,
): ResultAsync<readonly T[], E[]> => {
  const x = ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen(
    combineResultListWithAllErrors,
  )
  return x as ResultAsync<T[], E[]>
}

/**
 * Give a list of all the errors we find
 */
export const combineResultListWithAllErrors = <T, E>(
  resultList: ReadonlyArray<Result<T, E>>,
): Result<readonly T[], E[]> =>
  resultList.reduce<Result<T[], E[]>>( // eslint-disable-line unicorn/no-array-reduce
    (acc, result) =>
      result.isErr()
        ? (acc.isErr()
          ? err([...acc.error, result.error])
          : err([result.error]))
        : (acc.isErr()
          ? acc
          : ok([...acc.value, result.value])),
    ok([]),
  )
