/* eslint-disable require-yield */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { deepEqual, equal, ok as isOk } from 'node:assert'
import { describe, it } from 'node:test'
import type { ResultAsync } from '../src/result-async.js'
import { errAsync, okAsync } from '../src/result-async.js'
import { err, ok, Result, safeTry } from '../src/result.js'

await describe('safeTryAsync', async () => {
  const fooValue = okAsync('foo')
  const barValue = okAsync('bar')
  const errValue = errAsync('boom')

  await it('SafeTryAsync with all Ok', async () => {
    const resultAsync = safeTry(async function*() {
      const okValues = new Array<string>()

      const okFoo = yield* fooValue
      okValues.push(okFoo)

      const okBar = yield* barValue
      okValues.push(okBar)

      return ok(okValues)
    })

    const result = await resultAsync

    isOk(result.isOk())
    deepEqual(result._unsafeUnwrap(), ['foo', 'bar'])
  })

  await it('SafeTryAsync with Err', async () => {
    const resultAsync = safeTry(async function*() {
      const okValues = new Array<string>()
      const okFoo = yield* fooValue
      okValues.push(okFoo)

      const okBar = yield* barValue
      okValues.push(okBar)

      deepEqual(okValues, ['foo', 'bar'])

      yield* errValue

      throw new Error('This line should not be executed')
    })

    const result = await resultAsync

    isOk(result.isErr())
    deepEqual(result._unsafeUnwrapErr(), (await errValue)._unsafeUnwrapErr())
  })
})

await describe('Returns what is returned from the generator function', async () => {
  const val = 'value'

  it('With synchronous Ok', () => {
    const res = safeTry(function*() {
      return ok(val)
    })
    isOk(res instanceof Result)
    equal(res._unsafeUnwrap(), val)
  })

  it('With synchronous Err', () => {
    const res = safeTry(function*() {
      return err(val)
    })

    isOk(res.isErr())
    equal(res._unsafeUnwrapErr(), val)
  })

  it('With async Ok', async () => {
    const res = await safeTry(async function*() {
      return okAsync(val)
    })
    isOk(res.isOk())
    equal(res._unsafeUnwrap(), val)
  })

  it('With async Err', async () => {
    const res = await safeTry(async function*() {
      return errAsync(val)
    })
    isOk(res.isErr())
    equal(res._unsafeUnwrapErr(), val)
  })
})

await describe("Returns the first occurence of Err instance as yiled*'s operand", async () => {
  it('With synchronous results', () => {
    const errVal = 'err'
    const okValues = new Array<string>()

    const result = safeTry(function*() {
      const okFoo = yield* ok('foo')
      okValues.push(okFoo)

      const okBar = yield* ok('bar')
      okValues.push(okBar)

      yield* err(errVal)

      throw new Error('This line should not be executed')
    })

    deepEqual(okValues, ['foo', 'bar'])

    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), errVal)
  })

  it('With async results', async () => {
    const errVal = 'err'
    const okValues = new Array<string>()

    const result = await safeTry(async function*() {
      const okFoo = yield* okAsync('foo')
      okValues.push(okFoo)

      const okBar = yield* okAsync('bar')
      okValues.push(okBar)

      yield* errAsync(errVal)

      throw new Error('This line should not be executed')
    })

    deepEqual(okValues, ['foo', 'bar'])

    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), errVal)
  })

  it('Mix results of synchronous and async in AsyncGenerator', async () => {
    const errVal = 'err'
    const okValues = new Array<string>()

    const result = await safeTry(async function*() {
      const okFoo = yield* okAsync('foo')
      okValues.push(okFoo)

      const okBar = yield* ok('bar')
      okValues.push(okBar)

      yield* err(errVal)

      throw new Error('This line should not be executed')
    })

    deepEqual(okValues, ['foo', 'bar'])

    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), errVal)
  })
})

await describe("Tests if README's examples work", async () => {
  const okValue = 3
  const errValue = 'err!'
  function good(): Result<number, string> {
    return ok(okValue)
  }

  function bad(): Result<number, string> {
    return err(errValue)
  }

  async function promiseGood(): Promise<Result<number, string>> {
    return ok(okValue)
  }

  async function promiseBad(): Promise<Result<number, string>> {
    return err(errValue)
  }

  function asyncGood(): ResultAsync<number, string> {
    return okAsync(okValue)
  }

  function asyncBad(): ResultAsync<number, string> {
    return errAsync(errValue)
  }

  it('mayFail2 error', () => {
    function myFunc(): Result<number, string> {
      return safeTry<number, string>(function*() {
        return ok(
          (yield* good()
            .mapErr(e => `1st, ${e}`)) +
            (yield* bad()
              .mapErr(e => `2nd, ${e}`)),
        )
      })
    }

    const result = myFunc()
    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), `2nd, ${errValue}`)
  })

  it('all ok', () => {
    function myFunc(): Result<number, string> {
      return safeTry<number, string>(function*() {
        return ok(
          (yield* good()
            .mapErr(e => `1st, ${e}`)) +
            (yield* good()
              .mapErr(e => `2nd, ${e}`)),
        )
      })
    }

    const result = myFunc()
    isOk(result.isOk())
    equal(result._unsafeUnwrap(), okValue + okValue)
  })

  it('async mayFail1 error', async () => {
    function myFunc(): ResultAsync<number, string> {
      return safeTry<number, string>(async function*() {
        return ok(
          (yield* (await promiseBad())
            .mapErr(e => `1st, ${e}`)) +
            (yield* asyncGood()
              .mapErr(e => `2nd, ${e}`)),
        )
      })
    }

    const result = await myFunc()
    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), `1st, ${errValue}`)
  })

  it('async mayFail2 error', async () => {
    function myFunc(): ResultAsync<number, string> {
      return safeTry<number, string>(async function*() {
        return ok(
          (yield* (await promiseGood())
            .mapErr(e => `1st, ${e}`)) +
            (yield* asyncBad()
              .mapErr(e => `2nd, ${e}`)),
        )
      })
    }

    const result = await myFunc()
    isOk(result.isErr())
    equal(result._unsafeUnwrapErr(), `2nd, ${errValue}`)
  })

  it('promise async all ok', async () => {
    function myFunc(): ResultAsync<number, string> {
      return safeTry<number, string>(async function*() {
        return ok(
          (yield* (await promiseGood())
            .mapErr(e => `1st, ${e}`)) +
            (yield* asyncGood()
              .mapErr(e => `2nd, ${e}`)),
        )
      })
    }

    const result = await myFunc()
    isOk(result.isOk())
    equal(result._unsafeUnwrap(), okValue + okValue)
  })

  await describe('it yields and works without safeUnwrap', () => {
    it('With synchronous Ok', () => {
      const res: Result<string, string> = ok('ok')

      const actual = safeTry(function*() {
        const x = yield* res
        return ok(x)
      })

      isOk(actual.isOk())
      equal(actual._unsafeUnwrap(), 'ok')
    })

    it('With synchronous Err', () => {
      const res: Result<number, string> = err('error')

      const actual = safeTry(function*() {
        const x = yield* res
        return ok(x)
      })

      isOk(actual.isErr())
      equal(actual._unsafeUnwrapErr(), 'error')
    })

    const okValue = 3
    const errValue = 'err!'

    function good(): Result<number, string> {
      return ok(okValue)
    }
    function bad(): Result<number, string> {
      return err(errValue)
    }
    function promiseGood(): Promise<Result<number, string>> {
      return Promise.resolve(ok(okValue))
    }
    function promiseBad(): Promise<Result<number, string>> {
      return Promise.resolve(err(errValue))
    }
    function asyncGood(): ResultAsync<number, string> {
      return okAsync(okValue)
    }
    function asyncBad(): ResultAsync<number, string> {
      return errAsync(errValue)
    }

    it('mayFail2 error', () => {
      function fn(): Result<number, string> {
        return safeTry<number, string>(function*() {
          const first = yield* good().mapErr((e) => `1st, ${e}`)
          const second = yield* bad().mapErr((e) => `2nd, ${e}`)

          return ok(first + second)
        })
      }

      const result = fn()
      isOk(result.isErr())
      equal(result._unsafeUnwrapErr(), `2nd, ${errValue}`)
    })

    it('all ok', () => {
      function myFunc(): Result<number, string> {
        return safeTry<number, string>(function*() {
          const first = yield* good().mapErr((e) => `1st, ${e}`)
          const second = yield* good().mapErr((e) => `2nd, ${e}`)
          return ok(first + second)
        })
      }

      const result = myFunc()
      isOk(result.isOk())
      equal(result._unsafeUnwrap(), okValue + okValue)
    })

    it('async mayFail1 error', async () => {
      function myFunc(): ResultAsync<number, string> {
        return safeTry<number, string>(async function*() {
          const first = yield* (await promiseBad()).mapErr((e) => `1st, ${e}`)
          const second = yield* asyncGood().mapErr((e) => `2nd, ${e}`)
          return ok(first + second)
        })
      }

      const result = await myFunc()
      isOk(result.isErr())
      equal(result._unsafeUnwrapErr(), `1st, ${errValue}`)
    })

    it('async mayFail2 error', async () => {
      function myFunc(): ResultAsync<number, string> {
        return safeTry<number, string>(async function*() {
          const goodResult = await promiseGood()
          const value = yield* goodResult.mapErr((e) => `1st, ${e}`)
          const value2 = yield* asyncBad().mapErr((e) => `2nd, ${e}`)

          return okAsync(value + value2)
        })
      }

      const result = await myFunc()
      isOk(result.isErr())
      equal(result._unsafeUnwrapErr(), `2nd, ${errValue}`)
    })

    it('promise async all ok', async () => {
      function myFunc(): ResultAsync<number, string> {
        return safeTry<number, string>(async function*() {
          const first = yield* (await promiseGood()).mapErr((e) => `1st, ${e}`)
          const second = yield* asyncGood().mapErr((e) => `2nd, ${e}`)
          return ok(first + second)
        })
      }

      const result = await myFunc()
      isOk(result.isOk())
      equal(result._unsafeUnwrap(), okValue + okValue)
    })
  })
})
