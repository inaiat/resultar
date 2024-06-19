import assert, {
  deepEqual,
  deepStrictEqual,
  equal,
  notDeepStrictEqual,
  notEqual,
  ok as isTrue,
  strictEqual,
} from 'node:assert'
import type * as fs from 'node:fs/promises'
import { afterEach, describe, it, mock } from 'node:test'
import * as td from 'testdouble'
import { errAsync, fromPromise, fromThrowableAsync, okAsync, ResultAsync } from '../src/result-async.js'
import { err, ok, Result } from '../src/result.js'

const validateUser = (user: Readonly<{ name: string }>): ResultAsync<{ name: string }, string> => {
  if (user.name === 'superadmin') {
    return errAsync('You are not allowed to register')
  }

  return okAsync(user)
}

await describe('Result.Ok', async () => {
  await it('Creates an Ok value', () => {
    const okVal = ok(12)

    equal(okVal.isOk(), true)
    equal(okVal.isErr(), false)
    ok(okVal instanceof Result)
  })

  await it('Creates an Ok value with null', () => {
    const okVal = ok(null)

    equal(okVal.isOk(), true)
    equal(okVal.isErr(), false)
    equal(okVal._unsafeUnwrap(), null)
  })

  await it('Creates an Ok value with undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined
    const okVal = ok(undefined)
    equal(okVal.isOk(), true)
    equal(okVal.isErr(), false)
    equal(okVal._unsafeUnwrap(), undefined)
  })

  await it('Is comparable', () => {
    deepStrictEqual(ok(42), ok(42))
    notDeepStrictEqual(ok(42), ok(43))
  })

  await it('Maps over an Ok value', () => {
    const value = 12
    const okVal = ok(value)

    const mapFn = mock.fn(String)

    const mapped = okVal.map(mapFn)

    isTrue(mapped.isOk())
    equal(mapped._unsafeUnwrap(), '12')
    equal(mapFn.mock.calls.length, 1)
  })

  await it('Skips `mapErr`', () => {
    const mapErrorFunc = mock.fn(String)

    const notMapped = ok(12).mapErr(mapErrorFunc)

    isTrue(notMapped.isOk())
    equal(mapErrorFunc.mock.calls.length, 0)
  })

  await describe('andThen', async () => {
    await it('Maps to an Ok', async () => {
      const okVal = ok(12)

      const data = { data: 'why not' }

      const flattened = okVal.andThen(_number =>
        // ...
        // complex logic
        // ...
        ok(data)
      )

      isTrue(flattened.isOk())
      strictEqual(flattened._unsafeUnwrap(), data)
    })

    await it('Maps to an Err', () => {
      const okval = ok(12)

      const flattened = okval.andThen(_number =>
        // ...
        // complex logic
        // ...
        err('Whoopsies!')
      )

      const nextFn = mock.fn(_val => ok('noop'))

      equal(flattened.isOk(), false)

      flattened.andThen(nextFn)

      equal(nextFn.mock.callCount.length, 0)
    })
  })

  await describe('if', async () => {
    await it('returns the "true" part of the statement', async () => {
      const okVal = ok(12)
      const result = okVal.if(val => val > 10)
        .true(v => ok(`The number ${v} is gerater than 10`))
        .false(v => ok(`The number ${v} is smaller or equal to 10`))
      deepEqual(result, ok('The number 12 is gerater than 10'))
    })

    await it('returns the "false" part of the statement', async () => {
      const okVal = ok(9)
      const result = okVal.if(val => val > 10)
        .true(v => ok(`The number ${v} is gerater than 10`))
        .false(v => ok(`The number ${v} is smaller or equal to 10`))
      deepEqual(result, ok('The number 9 is smaller or equal to 10'))
    })
  })

  await describe('orElse', async () => {
    await it('Skips orElse on an Ok value', async () => {
      const okVal = ok(12)
      const errorCallback = mock.fn(_val => err('It is now a string'))
      deepEqual(okVal.orElse(errorCallback), ok(12))
      equal(errorCallback.mock.calls.length, 0)
    })
  })

  await it('unwrapOr and return the Ok value', async () => {
    const okVal = ok(12)
    equal(okVal.unwrapOr(1), 12)
  })

  await it('Maps to a ResultAsync', async () => {
    const okVal = ok(12)

    const flattened = okVal.asyncAndThen(_number =>
      // ...
      // complex async logic
      // ...
      okAsync({ data: 'why not' })
    )

    isTrue(flattened instanceof ResultAsync)

    const newResult = await flattened

    isTrue(newResult.isOk())
    deepEqual(newResult._unsafeUnwrap(), { data: 'why not' })
  })

  await it('Maps to a promise', async () => {
    const asyncMapper = mock.fn(async (_val: number) => 'Very Nice!')

    const okVal = ok(12)

    const promise = okVal.asyncMap(asyncMapper)

    isTrue(promise instanceof ResultAsync)

    const newResult = await promise

    isTrue(newResult.isOk())
    equal(newResult._unsafeUnwrap(), 'Very Nice!')
    equal(asyncMapper.mock.calls.length, 1)
  })

  await it('Matches on an Ok', () => {
    const okMapper = mock.fn(_val => 'weeeeee')
    const errMapper = mock.fn(_val => 'wooooo')

    const matched = ok(12).match(okMapper, errMapper)

    equal(matched, 'weeeeee')
    equal(okMapper.mock.calls.length, 1)
    equal(errMapper.mock.calls.length, 0)
  })

  await it('Unwraps without issue', () => {
    const okVal = ok(12)

    equal(okVal._unsafeUnwrap(), 12)
  })

  await it('Can read the value after narrowing', () => {
    const fallible: () => Result<string, number> = () => ok('safe to read')
    const val = fallible()

    // After this check we val is narrowed to Ok<string, number>. Without this
    // line TypeScript will not allow accessing val.value.
    if (val.isErr()) {
      return
    }

    equal(val.value, 'safe to read')
  })

  await describe('log', async () => {
    const logSideEffect = mock.fn((v?: number, e?: number) => {
      console.log('Just a side effect log', v, e)
    })

    afterEach(() => {
      logSideEffect.mock.resetCalls()
    })

    await it('Log into an async ok value', async () => {
      const val = ok(20).log(logSideEffect)
      equal(val.isOk(), true)
      equal(val._unsafeUnwrap(), 20)
      equal(logSideEffect.mock.calls.length, 1)
    })

    await it('Taps into an async err value', async () => {
      const val = err(40).log(logSideEffect)
      equal(val.isOk(), false)
      equal(val._unsafeUnwrapErr(), 40)
      equal(logSideEffect.mock.calls.length, 1)
    })
  })

  await it('Taps into an Ok value', () => {
    const okVal = ok(12)

    // value can be accessed, but is not changed
    const sideEffect = mock.fn(number => {
      console.log(number)
    })

    const mapped = okVal.tap(sideEffect)

    isTrue(mapped.isOk())
    equal(mapped._unsafeUnwrap(), 12)
    equal(sideEffect.mock.calls.length, 1)
  })

  await it('Cannot change a value with .tap', () => {
    const original = { name: 'John' }
    const okVal = ok(original)

    // value can be accessed, but is not changed
    const sideEffect = mock.fn(_person => ({ name: 'Alice' }))

    const mapped = okVal.tap(sideEffect)

    isTrue(mapped.isOk())
    equal(mapped._unsafeUnwrap(), original)
    equal(sideEffect.mock.calls.length, 1)
  })

  await it('Skips `tap`', () => {
    const errVal = err('I am your father')

    const sideEffect = mock.fn(_value => {
      console.log('noooo')
    })

    const sideEffectErr = mock.fn(_value => {
      console.log('noooo')
    })

    const hopefullyNotMapped = errVal.tap(sideEffect).tapError(sideEffectErr)

    isTrue(hopefullyNotMapped.isErr())
    equal(sideEffect.mock.calls.length, 0)
    equal(sideEffectErr.mock.calls.length, 1)
    equal(hopefullyNotMapped._unsafeUnwrapErr(), errVal._unsafeUnwrapErr())
  })

  await it('Cannot change a value with .tap and does not raise exception if tap has one', () => {
    const original = { name: 'John' }
    const okVal = ok(original)

    // value can be accessed, but is not changed
    const sideEffect = mock.fn((value: number) => {
      if (value === 12) {
        throw new Error("Don't do that!")
      }

      return { name: 'Alice' }
    })

    const mapped = okVal.tap(_x => sideEffect(12))

    isTrue(mapped.isOk())
    equal(mapped._unsafeUnwrap(), original)
    equal(sideEffect.mock.calls.length, 1)
  })
})

await describe('Result.Err', async () => {
  await it('Creates an Err value', () => {
    const errVal = err('I have you now.')

    equal(errVal.isOk(), false)
    isTrue(errVal.isErr())
    isTrue(typeof errVal.error === 'string')
  })

  await it('Is comparable', () => {
    deepEqual(err(42), err(42))
    notEqual(err(42), err(43))
  })

  await it('Skips `map`', () => {
    const errVal = err('I am your father')

    const mapper = mock.fn(_value => 'noooo')

    const hopefullyNotMapped = errVal.map(mapper)

    isTrue(hopefullyNotMapped.isErr())
    equal(mapper.mock.calls.length, 0)
    equal(hopefullyNotMapped._unsafeUnwrapErr(), errVal._unsafeUnwrapErr())
  })

  await it('Maps over an Err', () => {
    const errVal = err('Round 1, Fight!')

    const mapper = mock.fn((error: string) => error.replace('1', '2'))

    const mapped = errVal.mapErr(mapper)

    isTrue(mapped.isErr())
    equal(mapper.mock.calls.length, 1)
    notEqual(mapped._unsafeUnwrapErr(), errVal._unsafeUnwrapErr())
  })

  await it('unwrapOr and return the default value', () => {
    const okVal = err<number, string>('Oh nooo')
    equal(okVal.unwrapOr(1), 1)
  })

  await it('Skips over andThen', () => {
    const errVal = err('Yolo')

    const mapper = mock.fn(_val => ok<string, string>('yooyo'))

    const hopefullyNotFlattened = errVal.andThen(mapper)

    isTrue(hopefullyNotFlattened.isErr())
    equal(mapper.mock.calls.length, 0)
    equal(errVal._unsafeUnwrapErr(), 'Yolo')
  })

  await it('Transforms error into ResultAsync within `asyncAndThen`', async () => {
    const errVal = err('Yolo')

    const asyncMapper = mock.fn(_val => okAsync<string, string>('yooyo'))

    const hopefullyNotFlattened = errVal.asyncAndThen(asyncMapper)

    equal(hopefullyNotFlattened instanceof ResultAsync, true)

    equal(asyncMapper.mock.calls.length, 0)

    const syncResult = await hopefullyNotFlattened
    equal(syncResult._unsafeUnwrapErr(), 'Yolo')
  })

  await it('Does not invoke callback within `asyncMap`', async () => {
    const asyncMapper = mock.fn(async _val =>
      // ...
      // complex logic
      // ..

      // db queries
      // network calls
      // disk io
      // etc ...
      'Very Nice!'
    )

    const errVal = err('nooooooo')

    const promise = errVal.asyncMap(asyncMapper)

    isTrue(promise instanceof ResultAsync)

    const sameResult = await promise

    isTrue(sameResult.isErr())
    equal(asyncMapper.mock.calls.length, 0)
    equal(sameResult._unsafeUnwrapErr(), errVal._unsafeUnwrapErr())
  })

  await it('Matches on an Err', () => {
    const okMapper = mock.fn(_val => 'weeeeee')
    const errMapper = mock.fn(_val => 'wooooo')

    const matched = err(12).match(okMapper, errMapper)

    equal(matched, 'wooooo')
    equal(okMapper.mock.calls.length, 0)
    equal(errMapper.mock.calls.length, 1)
  })

  await it('Throws when you unwrap an Err', () => {
    const errVal = err('woopsies')

    assert.throws(() => {
      errVal._unsafeUnwrap()
    }, { data: { type: 'Err', value: 'woopsies' }, message: 'Called `_unsafeUnwrap` on an Err', stack: undefined })
  })

  await it('Unwraps without issue', () => {
    const okVal = err(12)

    equal(okVal._unsafeUnwrapErr(), 12)
  })

  await describe('orElse', async () => {
    await it('invokes the orElse callback on an Err value', async () => {
      const okVal = err('BOOOM!')
      const errorCallback = mock.fn(_errVal => err(true))

      deepEqual(okVal.orElse(errorCallback), err(true))
      equal(errorCallback.mock.calls.length, 1)
    })
  })
})

await describe('ResultAsync', async () => {
  await it('Is awaitable to a Result', async () => {
    // For a success value
    const asyncVal = okAsync(12)
    equal(asyncVal instanceof ResultAsync, true)

    const val = await asyncVal

    equal(val._unsafeUnwrap(), 12)

    // For an error
    const asyncErr = errAsync('Wrong format')
    isTrue(asyncErr instanceof ResultAsync)

    const err = await asyncErr

    isTrue(err.isErr())
    equal(err._unsafeUnwrapErr(), 'Wrong format')
  })

  await describe('acting as a Promise<Result>', async () => {
    await it('Is chainable like any Promise', async () => {
      // For a success value
      const asyncValChained = okAsync(12).then(res => {
        if (res.isOk()) {
          return res.value + 2
        }
      })

      equal(asyncValChained instanceof Promise, true)
      const val = await asyncValChained
      equal(val, 14)

      // For an error
      const asyncErrChained = errAsync('Oops').then(res => {
        if (res.isErr()) {
          return res.error + '!'
        }
      })

      equal(asyncErrChained instanceof Promise, true)
      const err = await asyncErrChained
      equal(err, 'Oops!')
    })

    await it('Can be used with Promise.all', async () => {
      // eslint-disable-next-line unicorn/no-single-promise-in-promise-methods
      const allResult = await Promise.all([okAsync<string, Error>('1')])

      equal(allResult.length, 1)
      equal(allResult[0] instanceof Result, true)
      if (!(allResult[0] instanceof Result)) {
        return
      }

      isTrue(allResult[0].isOk())
      equal(allResult[0]._unsafeUnwrap(), '1')
    })
  })

  await describe('map', async () => {
    await it('Maps a value using a synchronous function', async () => {
      const asyncVal = okAsync(12)
      const mapSyncFn = mock.fn((v: number) => v.toString())
      const mapped = asyncVal.map(mapSyncFn)
      isTrue(mapped instanceof ResultAsync)
      const newVal = await mapped
      isTrue(newVal.isOk())
      equal(newVal._unsafeUnwrap(), '12')
      equal(mapSyncFn.mock.calls.length, 1)
    })
  })

  await describe('mapErr', async () => {
    await it('Maps an error using a synchronous function', async () => {
      const asyncErr = errAsync('Wrong format')

      const mapErrSyncFn = mock.fn((str: string) => 'Error: '.concat(str))

      const mappedErr = asyncErr.mapErr(mapErrSyncFn)

      isTrue(mappedErr instanceof ResultAsync)

      const newVal = await mappedErr

      isTrue(newVal.isErr())
      equal(newVal._unsafeUnwrapErr(), 'Error: Wrong format')
      equal(mapErrSyncFn.mock.calls.length, 1)
    })

    await it('Maps an error using an asynchronous function', async () => {
      const asyncErr = errAsync('Wrong format')

      const mapErrAsyncFn = mock.fn(async (str: string) => 'Error: '.concat(str))

      const mappedErr = asyncErr.mapErr(mapErrAsyncFn)

      isTrue(mappedErr instanceof ResultAsync)

      const newVal = await mappedErr

      isTrue(newVal.isErr())
      equal(newVal._unsafeUnwrapErr(), 'Error: Wrong format')
      equal(mapErrAsyncFn.mock.calls.length, 1)
    })

    await it('Skips a value', async () => {
      const asyncVal = okAsync(12)

      const mapErrSyncFn = mock.fn((str: string) => 'Error: '.concat(str))

      const notMapped = asyncVal.mapErr(mapErrSyncFn)

      isTrue(notMapped instanceof ResultAsync)

      const newVal = await notMapped

      isTrue(newVal.isOk())
      equal(newVal._unsafeUnwrap(), 12)
      equal(mapErrSyncFn.mock.calls.length, 0)
    })

    await it('Andthen chainning errors', async () => {
      const createUser = mock.fn((v: { name: string }) => okAsync(v.name))
      const result = await validateUser({ name: 'superadmin' }).andThen(createUser)
      equal(result._unsafeUnwrapErr(), 'You are not allowed to register')
    })

    await it('Andthen chaining success', async () => {
      const createUser = mock.fn((v: { name: string }) => okAsync('Welcome '.concat(v.name)))
      const result = await validateUser({ name: 'Elizeu Drummond' }).andThen(createUser)
      equal(result._unsafeUnwrap(), 'Welcome Elizeu Drummond')
    })
  })

  await describe('andThen', async () => {
    await it('Maps a value using a function returning a ResultAsync', async () => {
      const asyncVal = okAsync(12)

      const andThenResultAsyncFn = mock.fn(() => okAsync('good'))

      const mapped = asyncVal.andThen(andThenResultAsyncFn)

      isTrue(mapped instanceof ResultAsync)

      const newVal = await mapped

      isTrue(newVal.isOk())
      equal(newVal._unsafeUnwrap(), 'good')
      equal(andThenResultAsyncFn.mock.calls.length, 1)
    })

    await it('Maps a value using a function returning a Result', async () => {
      const asyncVal = okAsync(12)

      const andThenResultFn = mock.fn(() => ok('good'))

      const mapped = asyncVal.andThen(andThenResultFn)

      isTrue(mapped instanceof ResultAsync)

      const newVal = await mapped

      isTrue(newVal.isOk())
      equal(newVal._unsafeUnwrap(), 'good')
      equal(andThenResultFn.mock.calls.length, 1)
    })

    await it('Skips an Error', async () => {
      const asyncVal = errAsync<string, string>('Wrong format')

      const andThenResultFn = mock.fn(() => ok<string, string>('good'))

      const notMapped = asyncVal.andThen(andThenResultFn)

      isTrue(notMapped instanceof ResultAsync)

      const newVal = await notMapped

      isTrue(newVal.isErr())
      equal(newVal._unsafeUnwrapErr(), 'Wrong format')
      equal(andThenResultFn.mock.calls.length, 0)
    })
  })

  await describe('if', async () => {
    await it('returns the "true" part of the statement', async () => {
      const okVal = okAsync(12)
      const result = okVal.if(val => val > 10)
        .true(v => okAsync(`The number ${v} is gerater than 10`))
        .false(v => okAsync(`The number ${v} is smaller or equal to 10`))

      isTrue(result instanceof ResultAsync)
      deepEqual(result, okAsync('The number 12 is gerater than 10'))
    })

    await it('returns the "false" part of the statement', async () => {
      const okVal = okAsync(9)
      const result = okVal.if(val => val > 10)
        .true(v => okAsync(`The number ${v} is gerater than 10`))
        .false(v => okAsync(`The number ${v} is smaller or equal to 10`))
      isTrue(result instanceof ResultAsync)
      deepEqual(result, okAsync('The number 9 is smaller or equal to 10'))
    })
  })

  await describe('orElse', async () => {
    await it('Skips orElse on an Ok value', async () => {
      const okVal = okAsync(12)
      const errorCallback = mock.fn(_errVal => errAsync<number, string>('It is now a string'))

      const result = await okVal.orElse(errorCallback)

      deepEqual(result, ok(12))

      equal(errorCallback.mock.calls.length, 0)
    })

    await it('Invokes the orElse callback on an Err value', async () => {
      const myResult = errAsync('BOOOM!')
      const errorCallback = mock.fn(_errVal => errAsync(true))

      const result = await myResult.orElse(errorCallback)

      deepEqual(result, err(true))
      equal(errorCallback.mock.calls.length, 1)
    })

    await it('Accepts a regular Result in the callback', async () => {
      const myResult = errAsync('BOOOM!')
      const errorCallback = mock.fn(_errVal => err(true))

      const result = await myResult.orElse(errorCallback)

      deepEqual(result, err(true))
      equal(errorCallback.mock.calls.length, 1)
    })
  })

  await describe('match', async () => {
    await it('Matches on an Ok', async () => {
      const okMapper = mock.fn(_val => 'weeeeee')
      const errMapper = mock.fn(_val => 'wooooo')

      const matched = await okAsync(12).match(okMapper, errMapper)

      equal(matched, 'weeeeee')
      equal(okMapper.mock.calls.length, 1)
      equal(errMapper.mock.calls.length, 0)
    })

    await it('Matches on an Error', async () => {
      const okMapper = mock.fn(_val => 'weeeeee')
      const errMapper = mock.fn(_val => 'wooooo')

      const matched = await errAsync('bad').match(okMapper, errMapper)

      equal(matched, 'wooooo')
      equal(okMapper.mock.calls.length, 0)
      equal(errMapper.mock.calls.length, 1)
    })
  })

  await describe('unwrapOr', async () => {
    await it('returns a promise to the result value on an Ok', async () => {
      const unwrapped = await okAsync(12).unwrapOr(10)
      equal(unwrapped, 12)
    })

    await it('returns a promise to the provided default value on an Error', async () => {
      const unwrapped = await errAsync<number, number>(12).unwrapOr(10)
      equal(unwrapped, 10)
    })
  })

  await describe('fromSafePromise', async () => {
    await it('Creates a ResultAsync from a Promise', async () => {
      const res = ResultAsync.fromSafePromise(Promise.resolve(12))

      equal(res instanceof ResultAsync, true)

      const val = await res
      isTrue(val.isOk())
      equal(val._unsafeUnwrap(), 12)
    })
  })

  await describe('fromPromise', async () => {
    await it('Accepts an error handler as a second argument', async () => {
      const res = ResultAsync.fromPromise(Promise.reject('No!'), e => new Error('Oops: '.concat(String(e))))

      equal(res instanceof ResultAsync, true)

      const val = await res
      isTrue(val.isErr())
      deepEqual(val._unsafeUnwrapErr(), new Error('Oops: No!'))
    })
  })

  await describe('okAsync', async () => {
    await it('Creates a ResultAsync that resolves to an Ok', async () => {
      const val = okAsync(12)

      equal(val instanceof ResultAsync, true)

      const res = await val

      isTrue(res.isOk())
      equal(res._unsafeUnwrap(), 12)
    })
  })

  await describe('errAsync', async () => {
    await it('Creates a ResultAsync that resolves to an Err', async () => {
      const err = errAsync('bad')

      equal(err instanceof ResultAsync, true)

      const res = await err

      isTrue(res.isErr())
      equal(res._unsafeUnwrapErr(), 'bad')
    })
  })

  await it('Maps a value using an asynchronous function', async () => {
    const asyncVal = okAsync(12)

    const mapAsyncFn = mock.fn(async (v: number) => v.toString())

    const mapped = asyncVal.map(mapAsyncFn)

    isTrue(mapped instanceof ResultAsync)

    const newVal = await mapped

    isTrue(newVal.isOk())
    equal(newVal._unsafeUnwrap(), '12')
    equal(mapAsyncFn.mock.calls.length, 1)
  })

  await it('Skips an error', async () => {
    const asyncErr = errAsync<number, string>('Wrong format')

    const mapSyncFn = mock.fn((v: number) => v.toString())

    const notMapped = asyncErr.map(mapSyncFn)

    isTrue(notMapped instanceof ResultAsync)

    const newVal = await notMapped

    isTrue(newVal.isErr())
    equal(newVal._unsafeUnwrapErr(), 'Wrong format')
    equal(mapSyncFn.mock.calls.length, 0)
  })

  await describe('Result.fromThrowable', async () => {
    await it('Parser JSON', async () => {
      const safeJSONParse = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) =>
        Result.fromThrowable(JSON.parse, () => 'parser error')(text, reviver) as Result<{ name: string }, string>

      const result = safeJSONParse('{"name": "Elizeu Drummond"}')

      isTrue(result.isOk())
      deepEqual(result._unsafeUnwrap(), { name: 'Elizeu Drummond' })
    })

    await it('Creates a function that returns an OK result when the inner function does not throw', async () => {
      const hello = (): string => 'hello'
      const safeHello = Result.fromThrowable(hello)

      const result = hello()
      const safeResult = safeHello()

      isTrue(safeResult.isOk())
      equal(result, safeResult._unsafeUnwrap())
    })

    await it('Accepts an inner function which takes arguments', async () => {
      const hello = (fname: string): string => `hello, ${fname}`
      const safeHello = Result.fromThrowable(hello)

      const result = hello('Dikembe')
      const safeResult = safeHello('Dikembe')

      isTrue(safeResult.isOk())
      equal(result, safeResult._unsafeUnwrap())
    })

    await it('Creates a function that returns an err when the inner function throws', async () => {
      const thrower = (): string => {
        throw new Error() // eslint-disable-line unicorn/error-message
      }

      // type: () => Result<string, unknown>
      // received types from thrower fn, no errorFn is provides therefore Err type is unknown
      const safeThrower = Result.fromThrowable(thrower)
      const result = safeThrower()

      isTrue(result.isErr())
      isTrue(result._unsafeUnwrapErr() instanceof Error)
    })

    await it('Accepts an error handler as a second argument', async () => {
      const thrower = (): string => {
        throw new Error() // eslint-disable-line unicorn/error-message
      }

      type MessageObject = { message: string }
      const toMessageObject = (): MessageObject => ({ message: 'error' })

      // type: () => Result<string, MessageObject>
      // received types from thrower fn and errorFn return type
      const safeThrower = Result.fromThrowable(thrower, toMessageObject)
      const result = safeThrower()

      isTrue(result.isErr())
      isTrue(!result.isOk())
      isTrue(result instanceof Result)
      deepEqual(result._unsafeUnwrapErr(), { message: 'error' })
    })
  })

  await it('From promise rejected', async () => {
    const x = await ResultAsync.fromPromise(Promise.reject('No!'), String)
    isTrue(x.isErr())
    equal(x.error, 'No!')
  })

  await it('From promise rejected destructuring', async () => {
    const getUserName = async (): Promise<{ user: string }> => ({ user: 'Elizeu Drummond' })

    const x = getUserName()
    const user = ResultAsync.fromPromise(x, () => 'No!')
      .andThen(({ user }) => okAsync(user))

    const result = await user

    if (result.isErr()) {
      isTrue(result.isErr())
      equal(result.error, 'No!')
    }

    isTrue(result._unsafeUnwrap(), 'Elizeu Drummond')
  })

  await it('From promise ok', async () => {
    const x = await ResultAsync.fromPromise(Promise.resolve('Yes!'), e => new Error('Oops: ' + String(e)))
    isTrue(x.isOk())
    type R = string
    if (x.isOk()) {
      const r: R = x.value
      equal(r, 'Yes!')
    }

    if (x.isErr()) {
      const r = x.error
      equal(r, 'No!')
    }
  })

  await it('From promise error', async () => {
    const x = await ResultAsync.fromPromise(Promise.reject('boom'), e => 'Oops: ' + String(e))

    type R = string
    if (x.isErr()) {
      const r: R = x.error
      equal(r, 'Oops: boom')
    }

    await describe('ResultAsync.fromThrowable', async () => {
      const readFile = mock.fn(async (file: string) => {
        if (file === 'foo.txt') {
          return Buffer.from('foo')
        }

        throw new Error('File not found')
      })

      const safeFileReader = fromThrowableAsync(
        async (file: string) => readFile(file),
        e => new Error('Oops: '.concat(String(e))),
      )

      await it('creates a new function that returns a ResultAsync', async () => {
        const example = fromThrowableAsync(async (a: number, b: number) => a + b)
        const res = example(4, 8)
        isTrue(res instanceof ResultAsync)

        const val = await res
        isTrue(val.isOk())
        equal(val._unsafeUnwrap(), 12)
      })

      await it('handles synchronous errors', async () => {
        const example = fromThrowableAsync(async () => {
          if (1 > 0) { // eslint-disable-line no-constant-condition
            throw new Error('Oops: No!')
          }

          return 12
        })

        const val = await example()
        isTrue(val.isErr())
        deepEqual(val._unsafeUnwrapErr(), new Error('Oops: No!'))
      })

      await it('handles asynchronous errors', async () => {
        const example = fromThrowableAsync(async () => {
          if (1 > 0) { // eslint-disable-line no-constant-condition
            throw new Error('Oops: No!')
          }

          return 12
        })

        const val = await example()
        isTrue(val.isErr())
        deepEqual(val._unsafeUnwrapErr(), new Error('Oops: No!'))
      })

      await it('Accepts an error handler as a second argument', async () => {
        const example = fromThrowableAsync(
          async () => {
            throw new Error('No!')
          },
          e => new Error('Oops: '.concat((e as Error).message)),
        )

        const val = await example()
        isTrue(val.isErr())
        deepEqual(val._unsafeUnwrapErr(), new Error('Oops: No!'))
      })

      await it('fromThrowableAsync for readfile ok', async () => {
        const value = await safeFileReader('foo.txt')
          .match(buffer => buffer.toString(), error => error.message)

        equal(value, 'foo')
      })

      await it('fromThrowableAsync for readfile not found', async () => {
        const value = await safeFileReader('bar.txt')
          .match(buffer => buffer.toString(), error => error.message)

        equal(value, 'Oops: Error: File not found')
      })
    })
  })

  await describe('log result async', async () => {
    const logSideEffect = mock.fn((v?: number, e?: number) => {
      console.log('Just a side effect log', v, e)
    })

    afterEach(() => {
      logSideEffect.mock.resetCalls()
    })

    await it('Log into an async ok value', async () => {
      const asyncVal = okAsync(20)
      const mapped = asyncVal.log(logSideEffect)
      const newVal = await mapped
      equal(newVal.isOk(), true)
      equal(newVal._unsafeUnwrap(), 20)
      equal(logSideEffect.mock.calls.length, 1)
    })

    await it('Taps into an async err value', async () => {
      const asyncVal = errAsync(40)
      const mapped = asyncVal.log(logSideEffect)
      const newVal = await mapped
      equal(newVal.isOk(), false)
      equal(newVal._unsafeUnwrapErr(), 40)
      equal(logSideEffect.mock.calls.length, 1)
    })
  })

  await describe('tap', async () => {
    await it('Taps into an async value', async () => {
      const asyncVal = okAsync(12)

      const sideEffect = mock.fn(number => {
        console.log(number)
      })

      const mapped = asyncVal.tap(sideEffect)

      isTrue(mapped instanceof ResultAsync)

      const newVal = await mapped

      isTrue(newVal.isOk())
      equal(newVal._unsafeUnwrap(), 12)
      equal(sideEffect.mock.calls.length, 1)
    })

    await it('Cannot change an async value with .tap', async () => {
      const original = { name: 'John' }
      const asyncVal = okAsync(original)

      const sideEffect = mock.fn(_person => okAsync({ name: 'Alice' }))

      // @ts-expect-error  Ignoring this to run "dangerous code"
      const mapped = asyncVal.tap(sideEffect)

      isTrue(mapped instanceof ResultAsync)

      const newVal = await mapped

      isTrue(newVal.isOk())
      deepEqual(newVal._unsafeUnwrap(), original)
      equal(sideEffect.mock.calls.length, 1)
    })

    await it('Skips side effect ok and taps into an error', async () => {
      const asyncErr = errAsync<number, string>('Wrong format')

      const sideEffect = mock.fn(number => {
        console.log(number)
      })

      const sideEffectErr = mock.fn(number => {
        console.error(number)
      })

      const notMapped = asyncErr.tap(sideEffect).tapError(sideEffectErr)

      isTrue(notMapped instanceof ResultAsync)

      const newVal = await notMapped

      isTrue(newVal.isErr())
      equal(newVal._unsafeUnwrapErr(), 'Wrong format')
      equal(sideEffect.mock.calls.length, 0)
      equal(sideEffectErr.mock.calls.length, 1)
    })
  })
})

await describe('OrElse', async () => {
  const foo = () => okAsync('foo')
  const bar = () => errAsync(new Error('bar'))

  class FooError extends Error {}
  class BarError extends Error {}
  class XooError extends Error {}

  await it('Infer result', async () => {
    type R = Result<string | number, never>
    const result: R = await foo().orElse(() => okAsync(1))
    equal(result._unsafeUnwrap(), 'foo')
  })

  await it('Set explicit type', async () => {
    type R = Result<string | boolean, never>
    const result: R = await foo().orElse<string | boolean, never>(() => okAsync(true))
    equal(result._unsafeUnwrap(), 'foo')
  })

  await it('Infer multiples types', async () => {
    type R = Result<string | undefined, string | Error>
    const result: R = await bar().orElse(e => {
      if (e instanceof BarError) {
        // eslint-disable-next-line unicorn/no-useless-undefined
        return okAsync(undefined)
      }

      if (e instanceof FooError) {
        return okAsync('foo')
      }

      if (e instanceof XooError) {
        return errAsync('xoo')
      }

      return errAsync(e)
    })
    deepStrictEqual(result._unsafeUnwrapErr(), new Error('bar'))
  })
})

await describe('Finally', async () => {
  interface FileSystem {
    open: typeof fs.open
    close: fs.FileHandle['close']
  }

  const buffer = 'Not all those who wander are lost' // - J.R.R. Tolkien'

  await it('Finally should be called', () => {
    const closeFile = mock.fn(() => {
      console.log('closing file')
    })
    const file = {
      file: 'file.txt',
      content: 'line 1',
      close: closeFile,
    }

    const reader = ok(file)

    const result = reader.map(it => it.content).finally(_ => {
      file.close()
    })

    isTrue(result.isOk())
    equal(result._unsafeUnwrap(), 'line 1')
    equal(closeFile.mock.calls.length, 1)
  })

  await it('Finally should be called with error', () => {
    const foo = err('foo')
    const arrayResult = new Array<string>()
    foo.map(_p => 'boo').tap(x => x)
    const result = foo.map(_p => 'boo').finally((x, y) => {
      isTrue(x === undefined)
      arrayResult.push(y, 'finalized')
    })
    isTrue(result.isErr())
    equal(arrayResult.length, 2)
    deepEqual(arrayResult, ['foo', 'finalized'])
  })

  await it('Finally should be called with ok async', async () => {
    const fileHandle = td.object<fs.FileHandle>()
    const fileSystem = (await td.replaceEsm('node:fs/promises')).default as FileSystem
    td.when(fileSystem.open('foo.txt', 'w')).thenResolve(fileHandle)
    td.when(fileHandle.write(buffer)).thenResolve({ bytesWritten: 32, buffer })

    const result = await fromPromise(fileSystem.open('foo.txt', 'w'), String)
      .andThen(
        handle => fromPromise(handle.write(buffer), String),
      )
      .finally(async (v, _) => {
        equal(v.buffer, buffer)
        await fileHandle.close()
      })

    td.verify(fileHandle.close(), { times: 1 })

    equal(result.isOk(), true)
    equal(result._unsafeUnwrap().bytesWritten, 32)
  })

  await it('Finally should be called with error async', async () => {
    const fileHandle = td.object<fs.FileHandle>()
    const fileSystem = (await td.replaceEsm('node:fs/promises')).default as FileSystem
    td.when(fileSystem.open('bar.txt', 'w')).thenResolve(fileHandle)
    td.when(fileHandle.write(buffer)).thenReject(new Error("Oops: Error: EACCES: permission denied, open 'foo.txt'"))

    const result = await fromPromise(fileSystem.open('bar.txt', 'w'), String)
      .andThen(
        handle => fromPromise(handle.write(buffer), String),
      )
      .finally(async (_, e) => {
        isTrue(typeof e === 'string')
        await fileHandle.close()
      })

    td.verify(fileHandle.close(), { times: 1 })

    equal(result.isErr(), true)
    equal(result._unsafeUnwrapErr(), "Error: Oops: Error: EACCES: permission denied, open 'foo.txt'")
  })
})

await describe('Utils', async () => {
  await describe('`Result.combine`', async () => {
    await describe('Synchronous `combine`', async () => {
      await it('Combines a list of results into an Ok value', async () => {
        const resultList = [ok(123), ok(456), ok(789)]

        const result = Result.combine(resultList)

        isTrue(result.isOk())
        deepEqual(result._unsafeUnwrap(), [123, 456, 789])
      })
    })

    await it('Combines a list of results into an Err value', async () => {
      const resultList: Array<Result<number, string>> = [
        ok(123),
        err('boooom!'),
        ok(456),
        err('ahhhhh!'),
      ]

      const result = Result.combine(resultList)

      isTrue(result.isErr())
      equal(result._unsafeUnwrapErr(), 'boooom!')
    })

    await it('Combines heterogeneous lists', async () => {
      type HeterogenousList = [Result<string, string>, Result<number, number>, Result<boolean, boolean>]

      const heterogenousList: HeterogenousList = [
        ok('Yooooo'),
        ok(123),
        ok(true),
      ]

      type ExpecteResult = Result<[string, number, boolean], string | number | boolean>

      const result: ExpecteResult = Result.combine(heterogenousList)

      deepEqual(result._unsafeUnwrap(), ['Yooooo', 123, true])
    })

    await it('Does not destructure / concatenate arrays', async () => {
      type HomogenousList = [
        Result<string[], boolean>,
        Result<number[], string>,
      ]

      const homogenousList: HomogenousList = [
        ok(['hello', 'world']),
        ok([1, 2, 3]),
      ]

      type ExpectedResult = Result<[string[], number[]], boolean | string>

      const result: ExpectedResult = Result.combine(homogenousList)

      deepEqual(result._unsafeUnwrap(), [['hello', 'world'], [1, 2, 3]])
    })

    await describe('`ResultAsync.combine`', async () => {
      await it('Combines a list of async results into an Ok value', async () => {
        const asyncResultList = [okAsync(123), okAsync(456), okAsync(789)]

        const resultAsync: ResultAsync<number[], never[]> = ResultAsync.combine(asyncResultList)

        isTrue(resultAsync instanceof ResultAsync)

        const result = await ResultAsync.combine(asyncResultList)

        isTrue(result.isOk())
        deepEqual(result._unsafeUnwrap(), [123, 456, 789])
      })

      await it('Combines a list of results into an Err value', async () => {
        const resultList: Array<ResultAsync<number, string>> = [
          okAsync(123),
          errAsync('boooom!'),
          okAsync(456),
          errAsync('ahhhhh!'),
        ]

        const result = await ResultAsync.combine(resultList)

        isTrue(result.isErr())
        equal(result._unsafeUnwrapErr(), 'boooom!')
      })

      await it('Combines heterogeneous lists', async () => {
        type HeterogenousList = [
          ResultAsync<string, string>,
          ResultAsync<number, number>,
          ResultAsync<boolean, boolean>,
          ResultAsync<number[], string>,
        ]

        const heterogenousList: HeterogenousList = [
          okAsync('Yooooo'),
          okAsync(123),
          okAsync(true),
          okAsync([1, 2, 3]),
        ]

        type ExpecteResult = Result<[string, number, boolean, number[]], string | number | boolean>

        const result: ExpecteResult = await ResultAsync.combine(heterogenousList)

        deepEqual(result._unsafeUnwrap(), ['Yooooo', 123, true, [1, 2, 3]])
      })
    })
  })

  await describe('`Result.combineWithAllErrors`', async () => {
    await describe('Synchronous `combineWithAllErrors`', async () => {
      await it('Combines a list of results into an Ok value', async () => {
        const resultList = [ok(123), ok(456), ok(789)]

        const result = Result.combineWithAllErrors(resultList)

        isTrue(result.isOk())
        deepEqual(result._unsafeUnwrap(), [123, 456, 789])
      })

      await it('Combines a list of results into an Err value', async () => {
        const resultList: Array<Result<number, string>> = [
          ok(123),
          err('boooom!'),
          ok(456),
          err('ahhhhh!'),
        ]

        const result = Result.combineWithAllErrors(resultList)

        isTrue(result.isErr())
        deepEqual(result._unsafeUnwrapErr(), ['boooom!', 'ahhhhh!'])
      })

      await it('Combines heterogeneous lists', async () => {
        type HeterogenousList = [Result<string, string>, Result<number, number>, Result<boolean, boolean>]

        const heterogenousList: HeterogenousList = [
          ok('Yooooo'),
          ok(123),
          ok(true),
        ]

        type ExpecteResult = Result<[string, number, boolean], Array<string | number | boolean>>

        const result: ExpecteResult = Result.combineWithAllErrors(heterogenousList)

        deepEqual(result._unsafeUnwrap(), ['Yooooo', 123, true])
      })

      await it('Does not destructure / concatenate arrays', async () => {
        type HomogenousList = [
          Result<string[], boolean>,
          Result<number[], string>,
        ]

        const homogenousList: HomogenousList = [
          ok(['hello', 'world']),
          ok([1, 2, 3]),
        ]

        type ExpectedResult = Result<[string[], number[]], Array<boolean | string>>

        const result: ExpectedResult = Result.combineWithAllErrors(homogenousList)

        deepEqual(result._unsafeUnwrap(), [['hello', 'world'], [1, 2, 3]])
      })
    })

    await describe('`ResultAsync.combineWithAllErrors`', async () => {
      await it('Combines a list of async results into an Ok value', async () => {
        const asyncResultList = [okAsync(123), okAsync(456), okAsync(789)]

        const result = await ResultAsync.combineWithAllErrors(asyncResultList)

        isTrue(result.isOk())
        deepEqual(result._unsafeUnwrap(), [123, 456, 789])
      })

      await it('Combines a list of results into an Err value', async () => {
        const asyncResultList: Array<ResultAsync<number, string>> = [
          okAsync(123),
          errAsync('boooom!'),
          okAsync(456),
          errAsync('ahhhhh!'),
        ]

        const result = await ResultAsync.combineWithAllErrors(asyncResultList)

        isTrue(result.isErr())
        deepEqual(result._unsafeUnwrapErr(), ['boooom!', 'ahhhhh!'])
      })

      await it('Combines heterogeneous lists', async () => {
        type HeterogenousList = [
          ResultAsync<string, string>,
          ResultAsync<number, number>,
          ResultAsync<boolean, boolean>,
        ]

        const heterogenousList: HeterogenousList = [
          okAsync('Yooooo'),
          okAsync(123),
          okAsync(true),
        ]

        type ExpecteResult = Result<[string, number, boolean], [string, number, boolean]>

        const result: ExpecteResult = await ResultAsync.combineWithAllErrors(heterogenousList)

        deepEqual(result._unsafeUnwrap(), ['Yooooo', 123, true])
      })
    })

    await describe('testdouble `ResultAsync.combine`', async () => {
      interface ITestInterface {
        getName(): string
        setName(name: string): void
        getAsyncResult(): ResultAsync<ITestInterface, Error>
      }

      await it('Combines `testdouble` proxies from mocks generated via interfaces', async () => {
        const mock = td.object<ITestInterface>()

        const result = await ResultAsync.combine([okAsync(mock)] as const)

        isTrue(result !== undefined)
        isTrue(result.isOk())
        const unwrappedResult = result._unsafeUnwrap()
        equal(unwrappedResult.length, 1)
        strictEqual(unwrappedResult[0], mock)
      })
    })
  })
})
