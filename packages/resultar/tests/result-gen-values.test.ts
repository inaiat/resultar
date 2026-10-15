/* eslint-disable require-yield -- Completion without yields is part of the Result.gen contract under test. */
/* eslint-disable @typescript-eslint/no-deprecated -- These tests preserve the supported safeTry alias contract. */
import { deepEqual, equal, rejects, throws } from 'node:assert/strict'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  Result,
  ResultAsync,
  ResultTask,
  createTaggedError,
  err,
  errAsync,
  ok,
  okAsync,
  safeTry,
} from '../src/index.js'
import type { AsyncResultGenOptions, ResultGenOptions } from '../src/result.js'

describe('Result.gen completed values', () => {
  it('wraps primitives and absent values while preserving literal types', () => {
    const number = Result.gen(function* () {
      return 42
    })
    const literal = Result.gen(function* () {
      return 'ready' as const
    })
    const boolean = Result.gen(function* () {
      return false
    })
    const absent = Result.gen(function* () {
      return undefined
    })
    const empty = Result.gen(function* () {
      // Complete without a success value.
    })

    expectTypeOf(number).toEqualTypeOf<Result<number, never>>()
    expectTypeOf(literal).toEqualTypeOf<Result<'ready', never>>()
    expectTypeOf(boolean).toEqualTypeOf<Result<boolean, never>>()
    expectTypeOf(absent).toEqualTypeOf<Result<undefined, never>>()
    expectTypeOf(empty).toEqualTypeOf<Result<void, never>>()
    equal(number._unsafeUnwrap(), 42)
    equal(literal._unsafeUnwrap(), 'ready')
    equal(boolean._unsafeUnwrap(), false)
    equal(absent._unsafeUnwrap(), undefined)
    equal(empty._unsafeUnwrap(), undefined)
  })

  it('keeps plain object and array payload identity', () => {
    const user = { id: 'user-1', name: 'Ada' }
    const values = [1, 2, 3]
    const object = Result.gen(function* () {
      return user
    })
    const array = Result.gen(function* () {
      return values
    })

    expectTypeOf(object).toEqualTypeOf<Result<typeof user, never>>()
    expectTypeOf(array).toEqualTypeOf<Result<number[], never>>()
    equal(object._unsafeUnwrap(), user)
    equal(array._unsafeUnwrap(), values)
  })

  it('keeps objects with only partial Result methods as raw payloads', () => {
    const native = ok(42)
    const payload = {
      value: 42,
      isOk: () => true,
      isErr: () => false,
      *[Symbol.iterator]() {
        return 42
      },
      map: (f: (value: number) => unknown) => native.map(f),
      mapErr: (f: (error: never) => unknown) => native.mapErr(f),
      andThen: (f: (value: number) => Result<unknown, unknown>) => native.andThen(f),
      orElse: (f: (error: never) => Result<unknown, unknown>) => native.orElse(f),
      match: (handlers: {
        readonly ok: (value: number) => unknown
        readonly error: () => unknown
      }) => native.match(handlers),
    }
    const result = Result.gen(function* () {
      return payload
    })

    expectTypeOf(result).toEqualTypeOf<Result<typeof payload, never>>()
    equal(result._unsafeUnwrap(), payload)
  })

  it('keeps ordinary Proxy payloads without inspecting their prototype', () => {
    let prototypes = 0
    const payload = new Proxy(
      { id: 'user-1' },
      {
        getPrototypeOf: () => {
          prototypes += 1
          throw new Error('opaque prototype')
        },
      },
    )
    const result = Result.gen(function* () {
      return payload
    })

    expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, never>>()
    equal(result._unsafeUnwrap(), payload)
    equal(prototypes, 0)
  })

  it('combines yielded failures with plain value and delegated return branches', () => {
    const workflow = (branch: 'raw' | 'ok' | 'err') =>
      Result.gen(function* () {
        const value = yield* ok<number, 'read'>(2)
        if (branch === 'raw') return value
        if (branch === 'ok') return yield* ok<string, 'write'>(String(value))
        return yield* err<never, 'validate'>('validate')
      })
    const result = workflow('raw')

    expectTypeOf(result).toEqualTypeOf<Result<number | string, 'read' | 'write' | 'validate'>>()
    equal(result._unsafeUnwrap(), 2)
    equal(workflow('ok')._unsafeUnwrap(), '2')
    equal(workflow('err')._unsafeUnwrapErr(), 'validate')
  })

  it('preserves final Results and explicit nested success values on deprecated safeTry', () => {
    const success = ok<number, 'expected'>(42)
    const failure = err<number, 'expected'>('expected')
    const nested = ok(failure)
    const plain = safeTry(function* () {
      return success
    })
    const explicit = safeTry<number, 'expected'>(function* () {
      yield* success
      return failure
    })
    const boxed = safeTry<Result<number, 'expected'>, never>(function* () {
      return nested
    })

    expectTypeOf(plain).toEqualTypeOf<Result<number, 'expected'>>()
    expectTypeOf(explicit).toEqualTypeOf<Result<number, 'expected'>>()
    expectTypeOf(boxed).toEqualTypeOf<Result<Result<number, 'expected'>, never>>()
    equal(plain, success)
    equal(explicit, failure)
    equal(boxed, nested)
    equal(boxed._unsafeUnwrap(), failure)
  })

  it('maps sync defects without mapping yielded errors or losing precise catch types', () => {
    const defect = new Error('unexpected')
    let catches = 0
    const fail = (): void => {
      throw defect
    }
    const failed = Result.gen({
      *try() {
        yield* ok<number, 'read'>(1)
        fail()
        return 'ready' as const
      },
      catch: (cause) => {
        expectTypeOf(cause).toEqualTypeOf<unknown>()
        catches += 1
        return { _tag: 'Unexpected' as const, cause }
      },
    })
    const expected = Result.gen({
      *try() {
        yield* err<number, 'read'>('read')
        return 'ready' as const
      },
      catch: () => {
        catches += 1
        return 'caught' as const
      },
    })

    expectTypeOf(failed).toEqualTypeOf<
      Result<'ready', 'read' | { _tag: 'Unexpected'; cause: unknown }>
    >()
    expectTypeOf(expected).toEqualTypeOf<Result<'ready', 'read' | 'caught'>>()
    deepEqual(failed._unsafeUnwrapErr(), { _tag: 'Unexpected', cause: defect })
    equal(expected._unsafeUnwrapErr(), 'read')
    equal(catches, 1)
  })

  it('infers never success for bodies that always throw and retains ordinary thrown defects', () => {
    const defect = new Error('unexpected')
    const caught = Result.gen({
      *try() {
        throw defect
      },
      catch: () => 'unexpected' as const,
    })

    expectTypeOf(caught).toEqualTypeOf<Result<never, 'unexpected'>>()
    equal(caught._unsafeUnwrapErr(), 'unexpected')
    throws(
      () =>
        Result.gen(function* () {
          throw defect
        }),
      (error) => error === defect,
    )
  })

  it('supports declared object options and accounts for optional catch mappers', () => {
    const plain: ResultGenOptions<Result<never, 'read'>, number> = {
      *try() {
        return yield* ok<number, 'read'>(42)
      },
    }
    const withCatch: ResultGenOptions<Result<never, 'read'>, number, 'unexpected'> = {
      *try() {
        return yield* ok<number, 'read'>(42)
      },
      catch: () => 'unexpected',
    }
    const result = Result.gen(plain)
    const caught = Result.gen(withCatch)

    expectTypeOf(result).toEqualTypeOf<Result<number, 'read'>>()
    expectTypeOf(caught).toEqualTypeOf<Result<number, 'read' | 'unexpected'>>()
    equal(result._unsafeUnwrap(), 42)
    equal(caught._unsafeUnwrap(), 42)
  })

  it('preserves sync catch errors for unions with and without a mapper', () => {
    const defect = new Error('unexpected')
    const body = function* (): Generator<never, number> {
      throw defect
    }
    const mapped = { try: body, catch: (_cause: unknown) => 'caught' as const }
    const unhandled = { try: body }
    const run = (input: typeof mapped | typeof unhandled) => Result.gen(input)
    const caught = run(mapped)

    expectTypeOf(caught).toEqualTypeOf<Result<number, 'caught'>>()
    equal(caught._unsafeUnwrapErr(), 'caught')
    throws(
      () => run(unhandled),
      (error) => error === defect,
    )
  })

  it('preserves broad return annotations without widening to unknown', () => {
    const payload = { id: 'user-1' }
    const asObject = (): object => payload
    const asUnknown = (): unknown => payload
    const object = Result.gen(function* () {
      return asObject()
    })
    const unknown = Result.gen(function* () {
      return asUnknown()
    })

    expectTypeOf(object).toEqualTypeOf<Result<object, never>>()
    expectTypeOf(unknown).toEqualTypeOf<Result<unknown, never>>()
    equal(object._unsafeUnwrap(), payload)
    equal(unknown._unsafeUnwrap(), payload)
  })

  it('rejects returned Result, Promise, ResultAsync, and ResultTask values in Result.gen while leaving safeTry typed to final Results', () => {
    if (false) {
      // @ts-expect-error Result.gen requires plain return values or yield* delegation, not returned Ok.
      Result.gen(function* () {
        return ok(1)
      })
      // @ts-expect-error Result.gen requires yield* err(...), not returned Err.
      Result.gen(function* () {
        return err('boom')
      })
      // @ts-expect-error Async Result.gen requires plain return values or yield* delegation, not returned Ok.
      Result.gen(async function* () {
        return ok(1)
      })
      // @ts-expect-error Async Result.gen requires yield* err(...), not returned Err.
      Result.gen(async function* () {
        return err('boom')
      })
      // @ts-expect-error Async Result.gen requires yield* okAsync(...), not returned ResultAsync.
      Result.gen(async function* () {
        return okAsync(1)
      })
      // @ts-expect-error Async Result.gen requires yield* errAsync(...), not returned ResultAsync.
      Result.gen(async function* () {
        return errAsync('boom')
      })
      // @ts-expect-error Sync generators cannot return a Promise as implicit success.
      Result.gen(function* () {
        return Promise.resolve(1)
      })
      // @ts-expect-error Sync generators cannot return eager ResultAsync work implicitly.
      Result.gen(function* () {
        return okAsync(1)
      })
      // @ts-expect-error Sync generators cannot return lazy ResultTask work implicitly.
      Result.gen(function* () {
        return ResultTask.ok(1)
      })
      // @ts-expect-error Async generators cannot implicitly return an unexecuted ResultTask.
      Result.gen(async function* () {
        return ResultTask.ok(1)
      })
      // @ts-expect-error The deprecated alias preserves its original final-Result signature.
      safeTry(function* () {
        return 42
      })
    }
    equal(true, true)
  })
})

describe('async Result.gen completed values', () => {
  it('starts eagerly and composes mixed sync and async yields into a raw value', async () => {
    const events: string[] = []
    const pending = Result.gen(async function* () {
      events.push('started')
      const first = yield* okAsync<number, 'async read'>(2)
      const second = yield* ok<number, 'sync read'>(3)
      return first + second
    })

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<number, 'async read' | 'sync read'>>()
    deepEqual(events, ['started'])
    equal((await pending)._unsafeUnwrap(), 5)
  })

  it('delegates final success/failure via yield* in Result.gen and preserves awaited ResultAsync returns in safeTry', async () => {
    const success = ok<number, 'returned'>(42)
    const failure = err<number, 'returned'>('returned')
    const succeeded = Result.gen(async function* () {
      return yield* success
    })
    const failed = Result.gen(async function* () {
      yield* okAsync<number, 'yielded'>(1)
      return yield* failure
    })
    const legacy = safeTry<number, 'returned'>(async function* () {
      return okAsync<number, 'returned'>(42)
    })

    expectTypeOf(succeeded).toEqualTypeOf<ResultAsync<number, 'returned'>>()
    expectTypeOf(failed).toEqualTypeOf<ResultAsync<number, 'yielded' | 'returned'>>()
    expectTypeOf(legacy).toEqualTypeOf<ResultAsync<number, 'returned'>>()
    equal((await succeeded)._unsafeUnwrap(), 42)
    equal(await failed, failure)
    equal((await legacy)._unsafeUnwrap(), 42)
  })

  it('uses JavaScript awaiting for completed Promise values and preserves undefined returns', async () => {
    const object = { id: 'user-1' }
    const pending = Result.gen(async function* () {
      // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject -- Verify native async-generator return assimilation.
      return Promise.resolve(object)
    })
    const absent = Result.gen(async function* () {
      return undefined
    })

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<typeof object, never>>()
    expectTypeOf(absent).toEqualTypeOf<ResultAsync<undefined, never>>()
    equal((await pending)._unsafeUnwrap(), object)
    equal((await absent)._unsafeUnwrap(), undefined)
  })

  it('preserves completed Promise payloads from structural async generators', async () => {
    const complete = async (): Promise<IteratorResult<never, Promise<number>>> => ({
      done: true,
      value: Promise.resolve(42),
    })
    const generator: AsyncGenerator<never, Promise<number>> = {
      next: complete,
      return: complete,
      throw: complete,
      [Symbol.asyncIterator]: () => generator,
      [Symbol.asyncDispose]: async () => {
        // This generator fixture has no resources.
      },
    }
    const pending = Result.gen(() => generator)

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<Promise<number>, never>>()
    equal(await (await pending)._unsafeUnwrap(), 42)
  })

  it('does not await native async generator payloads a second time', async () => {
    let reads = 0
    const payload = {
      id: 'user-1',
      get then(): undefined {
        reads += 1
        if (reads > 1) throw new Error('second then read')
        return undefined
      },
    }
    const pending = Result.gen(async function* () {
      return payload
    })

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<typeof payload, never>>()
    equal((await pending)._unsafeUnwrap(), payload)
    equal(reads, 1)
  })

  it('preserves explicit boxed task payloads without executing them', async () => {
    let executed = 0
    const task = ResultTask.sync(() => {
      executed += 1
      return 42
    })
    const pending = Result.gen(async function* () {
      return { task }
    })

    expectTypeOf(pending).toEqualTypeOf<
      ResultAsync<{ task: ResultTask<number, never, never> }, never>
    >()
    equal((await pending)._unsafeUnwrap().task, task)
    equal(executed, 0)
  })

  it('keeps early async Err identity and leaves finally undrained for raw success returns', async () => {
    const failure = err<never, 'read'>('read')
    const events: string[] = []
    const pending = Result.gen(async function* () {
      try {
        yield* errAsync<number, 'read'>('read')
        events.push('continued')
        return 42
      } finally {
        events.push('finally')
      }
    })
    const syncYield = Result.gen(async function* () {
      yield* failure
      return 42
    })

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<number, 'read'>>()
    equal((await pending)._unsafeUnwrapErr(), 'read')
    equal(await syncYield, failure)
    deepEqual(events, [])
  })

  it('maps asynchronous defects and infers never for rejected bodies', async () => {
    const defect = new Error('unexpected')
    const rejected = Result.gen(async function* () {
      throw defect
    })
    const caught = Result.gen({
      async *try() {
        yield* okAsync<number, 'read'>(1)
        // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject -- Verify rejected final Promises map through the object catch.
        return Promise.reject<number>(defect)
      },
      catch: (cause) => {
        expectTypeOf(cause).toEqualTypeOf<unknown>()
        return { _tag: 'Unexpected' as const, cause }
      },
    })
    const always = Result.gen({
      async *try() {
        throw defect
      },
      catch: () => 'unexpected' as const,
    })

    expectTypeOf(rejected).toEqualTypeOf<ResultAsync<never, never>>()
    expectTypeOf(caught).toEqualTypeOf<
      ResultAsync<number, 'read' | { _tag: 'Unexpected'; cause: unknown }>
    >()
    expectTypeOf(always).toEqualTypeOf<ResultAsync<never, 'unexpected'>>()
    await rejects(Promise.resolve(rejected), (error) => error === defect)
    deepEqual((await caught)._unsafeUnwrapErr(), { _tag: 'Unexpected', cause: defect })
    equal((await always)._unsafeUnwrapErr(), 'unexpected')
  })

  it('supports declared asynchronous object options with optional catches', async () => {
    const options: AsyncResultGenOptions<Result<never, 'read'>, number, 'unexpected'> = {
      async *try() {
        return yield* okAsync<number, 'read'>(42)
      },
      catch: () => 'unexpected',
    }
    const pending = Result.gen(options)

    expectTypeOf(pending).toEqualTypeOf<ResultAsync<number, 'read' | 'unexpected'>>()
    equal((await pending)._unsafeUnwrap(), 42)
  })

  it('preserves async catch errors for unions with and without a mapper', async () => {
    const defect = new Error('unexpected')
    const body = async function* (): AsyncGenerator<never, number> {
      throw defect
    }
    const mapped = { try: body, catch: (_cause: unknown) => 'caught' as const }
    const unhandled = { try: body }
    const run = (input: typeof mapped | typeof unhandled) => Result.gen(input)
    const caught = run(mapped)

    expectTypeOf(caught).toEqualTypeOf<ResultAsync<number, 'caught'>>()
    equal((await caught)._unsafeUnwrapErr(), 'caught')
    await rejects(Promise.resolve(run(unhandled)), (error) => error === defect)
  })
})

describe('Result.fn', () => {
  class MissingIdError extends createTaggedError({
    name: 'MissingId',
    message: 'Missing id $id',
  }).withProps<{ readonly id: string }>() {}

  it('wraps synchronous generator functions with parameters, this binding, and post-body pipeline operators', () => {
    const parsePositive = (raw: string): Result<number, MissingIdError> => {
      const parsed = Number(raw)
      return parsed > 0 ? ok(parsed) : MissingIdError.err({ id: raw })
    }

    const compute = Result.fn(
      function* (this: { readonly base: number }, raw: string, multiplier: number) {
        const value = yield* parsePositive(raw)
        return (this.base + value) * multiplier
      },
      Result.map((n) => n + 1),
      (result, raw, multiplier) =>
        result.mapErr((error) => `${error._tag}:${raw}:${multiplier}` as const),
    )

    expectTypeOf(compute).toEqualTypeOf<
      (
        this: { readonly base: number },
        raw: string,
        multiplier: number,
      ) => Result<number, `MissingId:${string}:${number}`>
    >()

    const ctx = { base: 10 }
    deepEqual(compute.call(ctx, '5', 2), ok(31))
    deepEqual(compute.call(ctx, '0', 3), err('MissingId:0:3'))

    const eightSteps = Result.fn(
      function* (seed: number) {
        const v = yield* ok<number, 'bad'>(seed)
        return v
      },
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      Result.map((n) => n + 1),
      (res, seed) => res.map((n) => `${seed}->${n}`),
    )

    expectTypeOf(eightSteps).toEqualTypeOf<(seed: number) => Result<string, 'bad'>>()
    deepEqual(eightSteps(2), ok('2->9'))

    if (false) {
      // @ts-expect-error Result.fn sync generator must return a plain value, not a Result.
      Result.fn(function* (x: number) {
        return ok(x)
      })
      // @ts-expect-error Result.fn sync generator must not return a Promise.
      Result.fn(function* (x: number) {
        return Promise.resolve(x)
      })
    }
  })

  it('wraps async generator functions and pipes ResultAsync operators with original arguments', async () => {
    const fetchScore = (id: string): ResultAsync<number, MissingIdError> =>
      id === 'missing' ? ResultAsync.err(new MissingIdError({ id })) : okAsync(id.length * 10)

    const loadUserScore = Result.fn(
      async function* (id: string, bonus: number) {
        const base = yield* fetchScore(id)
        const extra = yield* ok<number, never>(bonus)
        return base + extra
      },
      ResultAsync.map((total) => total * 2),
      ResultAsync.catchTag('MissingId', (e) => ok(e.id.length)),
      (asyncRes, id, bonus) => asyncRes.map((score) => `${id}:${bonus}=${score}`),
    )

    expectTypeOf(loadUserScore).toEqualTypeOf<
      (id: string, bonus: number) => ResultAsync<string, never>
    >()

    equal((await loadUserScore('abcd', 5))._unsafeUnwrap(), 'abcd:5=90')
    equal((await loadUserScore('missing', 5))._unsafeUnwrap(), 'missing:5=7')

    if (false) {
      // @ts-expect-error Result.fn async generator must not return a ResultTask.
      Result.fn(async function* () {
        return ResultTask.ok(1)
      })
    }
  })
})
