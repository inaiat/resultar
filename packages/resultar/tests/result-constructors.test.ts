import { deepEqual, equal, throws } from 'node:assert/strict'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Result, createTaggedError, pipe } from '../src/index.js'
import type { StrictResult } from '../src/index.js'

class MissingValue extends createTaggedError({
  name: 'MissingValue',
  message: 'Value is missing',
}) {}

describe('Result.fromNullishOr', () => {
  it('rejects null and undefined with the original input and calls the factory once', () => {
    for (const value of [null, undefined]) {
      let calls = 0
      const error = new MissingValue()
      const result = Result.fromNullishOr(value, (input) => {
        calls += 1
        equal(input, value)
        return error
      })

      equal(result.isErr(), true)
      equal(result._unsafeUnwrapErr(), error)
      equal(calls, 1)
    }
  })

  it('keeps every present value, including falsy values and object identity', () => {
    const values = [0, false, '', Number.NaN, {}, () => 42]
    for (const value of values) {
      const result = Result.fromNullishOr(value, () => {
        throw new Error('Present values must not invoke onNullish')
      })
      equal(result._unsafeUnwrap(), value)
    }
  })

  it('supports reusable curried construction without evaluating the callback early', () => {
    let calls = 0
    const required = Result.fromNullishOr((value: string | null | undefined) => {
      calls += 1
      return { _tag: 'Missing' as const, input: value }
    })

    equal(calls, 0)
    equal(pipe('Ada', required)._unsafeUnwrap(), 'Ada')
    deepEqual(required(null)._unsafeUnwrapErr(), { _tag: 'Missing', input: null })
    deepEqual(required(undefined)._unsafeUnwrapErr(), { _tag: 'Missing', input: undefined })
    equal(calls, 2)
  })

  it('preserves NonNullable and concrete error types in direct and curried forms', () => {
    const value = 'Ada' as string | null | undefined
    const direct = Result.fromNullishOr(value, () => new MissingValue())
    const curried = Result.fromNullishOr(() => new MissingValue())(value)
    const literal = pipe(
      'Ada' as const,
      Result.fromNullishOr(() => 'missing' as const),
    )
    const absent = Result.fromNullishOr(null, () => new MissingValue())
    const strict: StrictResult<string, MissingValue> = direct

    expectTypeOf(direct).toEqualTypeOf<Result<string, MissingValue>>()
    expectTypeOf(curried).toEqualTypeOf<Result<string, MissingValue>>()
    expectTypeOf(literal).toEqualTypeOf<Result<'Ada', 'missing'>>()
    expectTypeOf(absent).toEqualTypeOf<Result<never, MissingValue>>()
    equal(strict.isOk(), true)

    if (false) {
      // @ts-expect-error An annotated callback constrains the accepted input.
      Result.fromNullishOr((input: string | null) => input)(42)
    }
  })

  it('propagates error-factory exceptions in both forms', () => {
    const defect = new Error('factory defect')
    const fail = (): never => {
      throw defect
    }
    throws(
      () => Result.fromNullishOr(undefined, fail),
      (error) => error === defect,
    )
    throws(
      () => Result.fromNullishOr(fail)(null),
      (error) => error === defect,
    )
  })
})

describe('Result.liftPredicate', () => {
  it('runs the predicate once and only creates errors for rejected inputs', () => {
    const inputs: number[] = []
    const rejected: number[] = []
    const positive = Result.liftPredicate(
      (value: number) => {
        inputs.push(value)
        return value > 0
      },
      (value) => {
        rejected.push(value)
        return { _tag: 'NotPositive' as const, value }
      },
    )

    deepEqual(inputs, [])
    equal(pipe(2, positive)._unsafeUnwrap(), 2)
    deepEqual(positive(0)._unsafeUnwrapErr(), { _tag: 'NotPositive', value: 0 })
    deepEqual(inputs, [2, 0])
    deepEqual(rejected, [0])
  })

  it('preserves direct object identity and supplies the rejected value to onFalse', () => {
    const value = { active: true }
    equal(
      Result.liftPredicate(
        value,
        (input) => input.active,
        () => 'inactive',
      )._unsafeUnwrap(),
      value,
    )
    const inactive = { active: false }
    const result = Result.liftPredicate(
      inactive,
      (input) => input.active,
      (input) => input,
    )
    equal(result._unsafeUnwrapErr(), inactive)
  })

  it('narrows success using refinements in both forms', () => {
    const isString = (value: unknown): value is string => typeof value === 'string'
    const value: unknown = 'Ada'
    const direct = Result.liftPredicate(value, isString, () => new MissingValue())
    const curried = pipe(
      value,
      Result.liftPredicate(isString, () => new MissingValue()),
    )
    const literal = Result.liftPredicate(isString, () => 'invalid' as const)('Ada' as const)

    expectTypeOf(direct).toEqualTypeOf<Result<string, MissingValue>>()
    expectTypeOf(curried).toEqualTypeOf<Result<string, MissingValue>>()
    expectTypeOf(literal).toEqualTypeOf<Result<'Ada', 'invalid'>>()
    equal(direct._unsafeUnwrap().toUpperCase(), 'ADA')
    equal(curried._unsafeUnwrap(), 'Ada')
    equal(Result.liftPredicate(42, isString, () => 'not-string').isErr(), true)
  })

  it('keeps the input type for boolean predicates and rejects incompatible inputs', () => {
    const predicate = (value: string | number): boolean => typeof value === 'number' && value > 0
    const value = 2 as string | number
    const direct = Result.liftPredicate(value, predicate, () => 'invalid' as const)
    const curried = Result.liftPredicate(predicate, () => 'invalid' as const)

    expectTypeOf(direct).toEqualTypeOf<Result<string | number, 'invalid'>>()
    expectTypeOf(curried(2 as const)).toEqualTypeOf<Result<2, 'invalid'>>()
    equal(direct.isOk(), true)

    if (false) {
      // @ts-expect-error The predicate does not accept boolean input.
      curried(false)
      Result.liftPredicate(
        1,
        // @ts-expect-error Predicates must be synchronous boolean callbacks.
        async () => true,
        () => 'invalid',
      )
      Result.liftPredicate(
        // @ts-expect-error Refinements must narrow to a subtype of their input.
        (input: string): input is number => input.length > 0,
        () => 'invalid',
      )
    }
  })

  it('propagates predicate and error-factory exceptions', () => {
    const defect = new Error('callback defect')
    const fail = (): never => {
      throw defect
    }
    throws(
      () => Result.liftPredicate(1, fail, () => 'invalid'),
      (error) => error === defect,
    )
    throws(
      () => Result.liftPredicate(fail, () => 'invalid')(1),
      (error) => error === defect,
    )
    throws(
      () => Result.liftPredicate(1, () => false, fail),
      (error) => error === defect,
    )
    throws(
      () => Result.liftPredicate(() => false, fail)(1),
      (error) => error === defect,
    )
  })
})
