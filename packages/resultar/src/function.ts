/* eslint-disable max-params */
import { runPipe } from './pipe.js'
import type { PipeFn } from './pipe.js'

/** Returns its input, preserving its type and reference. */
export const identity = <A>(value: A): A => value

/** Captures a value and returns it on every call without copying or recomputing it. */
export const constant =
  <A>(value: A): (() => A) =>
  () =>
    value

/** Applies zero through eight synchronous transformations from left to right. */
export function pipe<A>(value: A): A
export function pipe<A, B>(value: A, f0: PipeFn<A, B>): B
export function pipe<A, B, C>(value: A, f0: PipeFn<A, B>, f1: PipeFn<B, C>): C
export function pipe<A, B, C, D>(value: A, f0: PipeFn<A, B>, f1: PipeFn<B, C>, f2: PipeFn<C, D>): D
export function pipe<A, B, C, D, E>(
  value: A,
  f0: PipeFn<A, B>,
  f1: PipeFn<B, C>,
  f2: PipeFn<C, D>,
  f3: PipeFn<D, E>,
): E
export function pipe<A, B, C, D, E, F>(
  value: A,
  f0: PipeFn<A, B>,
  f1: PipeFn<B, C>,
  f2: PipeFn<C, D>,
  f3: PipeFn<D, E>,
  f4: PipeFn<E, F>,
): F
export function pipe<A, B, C, D, E, F, G>(
  value: A,
  f0: PipeFn<A, B>,
  f1: PipeFn<B, C>,
  f2: PipeFn<C, D>,
  f3: PipeFn<D, E>,
  f4: PipeFn<E, F>,
  f5: PipeFn<F, G>,
): G
export function pipe<A, B, C, D, E, F, G, H>(
  value: A,
  f0: PipeFn<A, B>,
  f1: PipeFn<B, C>,
  f2: PipeFn<C, D>,
  f3: PipeFn<D, E>,
  f4: PipeFn<E, F>,
  f5: PipeFn<F, G>,
  f6: PipeFn<G, H>,
): H
export function pipe<A, B, C, D, E, F, G, H, I>(
  value: A,
  f0: PipeFn<A, B>,
  f1: PipeFn<B, C>,
  f2: PipeFn<C, D>,
  f3: PipeFn<D, E>,
  f4: PipeFn<E, F>,
  f5: PipeFn<F, G>,
  f6: PipeFn<G, H>,
  f7: PipeFn<H, I>,
): I
export function pipe(value: unknown, ...functions: readonly PipeFn<never, unknown>[]): unknown {
  return runPipe(value, functions)
}

/** Composes functions, preserving the arguments and receiver of the first function. */
export function flow<First extends (...args: never[]) => unknown>(
  first: First,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => ReturnType<First>
export function flow<First extends (...args: never[]) => unknown, B>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => B
export function flow<First extends (...args: never[]) => unknown, B, C>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => C
export function flow<First extends (...args: never[]) => unknown, B, C, D>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => D
export function flow<First extends (...args: never[]) => unknown, B, C, D, E>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
  f4: PipeFn<D, E>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => E
export function flow<First extends (...args: never[]) => unknown, B, C, D, E, F>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
  f4: PipeFn<D, E>,
  f5: PipeFn<E, F>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => F
export function flow<First extends (...args: never[]) => unknown, B, C, D, E, F, G>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
  f4: PipeFn<D, E>,
  f5: PipeFn<E, F>,
  f6: PipeFn<F, G>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => G
export function flow<First extends (...args: never[]) => unknown, B, C, D, E, F, G, H>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
  f4: PipeFn<D, E>,
  f5: PipeFn<E, F>,
  f6: PipeFn<F, G>,
  f7: PipeFn<G, H>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => H
export function flow<First extends (...args: never[]) => unknown, B, C, D, E, F, G, H, I>(
  first: First,
  f1: PipeFn<ReturnType<First>, B>,
  f2: PipeFn<B, C>,
  f3: PipeFn<C, D>,
  f4: PipeFn<D, E>,
  f5: PipeFn<E, F>,
  f6: PipeFn<F, G>,
  f7: PipeFn<G, H>,
  f8: PipeFn<H, I>,
): (this: ThisParameterType<First>, ...args: Parameters<First>) => I
export function flow(
  first: (...args: never[]) => unknown,
  ...functions: readonly PipeFn<never, unknown>[]
): (this: unknown, ...args: readonly unknown[]) => unknown {
  return function (this: unknown, ...args: readonly unknown[]): unknown {
    return runPipe(first.apply(this, args as never[]), functions)
  }
}
