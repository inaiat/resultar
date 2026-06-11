import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Result, ResultAsync, err, errAsync, ok, okAsync } from '../src/index.js'

type PendingState = { readonly cursor: number; readonly status: 'pending' }

type DoneState = { readonly status: 'done' }

type LoopState = DoneState | PendingState

const isPendingState = (state: LoopState): state is PendingState => state.status === 'pending'
const resultForEach: typeof Result.forEach = Result.forEach
const resultAsyncForEach: typeof ResultAsync.forEach = ResultAsync.forEach

describe('Result loop helpers', () => {
  it('collects Result.loop body values', () => {
    const result = Result.loop(1, {
      while: (state) => state <= 3,
      step: (state) => state + 1,
      body: (state) => ok<number, string>(state * 2),
    })

    deepEqual(result._unsafeUnwrap(), [2, 4, 6])
  })

  it('discards Result.loop body values', () => {
    const visited: number[] = []

    const result = Result.loop(1, {
      while: (state) => state <= 3,
      step: (state) => state + 1,
      body: (state) => {
        visited.push(state)
        return ok<number, string>(state)
      },
      discard: true,
    })

    equal(result._unsafeUnwrap(), undefined)
    deepEqual(visited, [1, 2, 3])
  })

  it('skips Result.loop body when the initial condition is false', () => {
    let calls = 0

    const result = Result.loop(1, {
      while: (state) => state > 1,
      step: (state) => state + 1,
      body: (state) => {
        calls += 1
        return ok<number, string>(state)
      },
    })

    deepEqual(result._unsafeUnwrap(), [])
    equal(calls, 0)
  })

  it('stops Result.loop on first Err and does not call step after Err', () => {
    const steps: number[] = []

    const result = Result.loop(1, {
      while: (state) => state <= 3,
      step: (state) => {
        steps.push(state)
        return state + 1
      },
      body: (state) => (state === 2 ? err<number, string>('failed') : ok<number, string>(state)),
    })

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(steps, [1])
  })

  it('returns the final Result.iterate state', () => {
    const result = Result.iterate(1, {
      while: (state) => state <= 5,
      body: (state) => ok<number, string>(state + 1),
    })

    equal(result._unsafeUnwrap(), 6)
  })

  it('returns the initial Result.iterate state when the condition is false', () => {
    const result = Result.iterate(10, {
      while: (state) => state < 10,
      body: (state) => ok<number, string>(state + 1),
    })

    equal(result._unsafeUnwrap(), 10)
  })

  it('short-circuits Result.iterate on Err', () => {
    const result = Result.iterate(1, {
      while: (state) => state < 5,
      body: (state) =>
        state === 3 ? err<number, string>('failed') : ok<number, string>(state + 1),
    })

    equal(result._unsafeUnwrapErr(), 'failed')
  })

  it('passes value and index to resultForEach and collects results', () => {
    const indexes: number[] = []

    const result = resultForEach(['a', 'b', 'c'], (value, index) => {
      indexes.push(index)
      return ok<string, string>(`${index}:${value}`)
    })

    deepEqual(result._unsafeUnwrap(), ['0:a', '1:b', '2:c'])
    deepEqual(indexes, [0, 1, 2])
  })

  it('discards resultForEach results', () => {
    const visited: string[] = []

    const result = resultForEach(
      ['a', 'b'],
      (value, index) => {
        visited.push(`${index}:${value}`)
        return ok<string, string>(value)
      },
      { discard: true },
    )

    equal(result._unsafeUnwrap(), undefined)
    deepEqual(visited, ['0:a', '1:b'])
  })

  it('handles empty resultForEach input', () => {
    const collected = resultForEach([], (value: string) => ok<string, string>(value))
    const discarded = resultForEach([], (value: string) => ok<string, string>(value), {
      discard: true,
    })

    deepEqual(collected._unsafeUnwrap(), [])
    equal(discarded._unsafeUnwrap(), undefined)
  })

  it('stops resultForEach before later elements on Err', () => {
    const calls: number[] = []

    const result = resultForEach([1, 2, 3], (value) => {
      calls.push(value)
      return value === 2 ? err<number, string>('failed') : ok<number, string>(value)
    })

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(calls, [1, 2])
  })

  it('infers sync loop helper result types', () => {
    const loop = Result.loop({ status: 'pending', cursor: 0 } as LoopState, {
      while: isPendingState,
      step: (state): LoopState =>
        state.cursor >= 1 ? { status: 'done' } : { status: 'pending', cursor: state.cursor + 1 },
      body: (state) => ok<number, 'loop-error'>(state.cursor),
    })
    const discarded = Result.loop(1, {
      while: (state) => state <= 1,
      step: (state) => state + 1,
      body: (state) => ok<number, 'discard-error'>(state),
      discard: true,
    })
    const iterated = Result.iterate({ status: 'pending', cursor: 0 } as LoopState, {
      while: isPendingState,
      body: (state) =>
        ok<LoopState, 'iterate-error'>(
          state.cursor >= 1 ? { status: 'done' } : { status: 'pending', cursor: state.cursor + 1 },
        ),
    })
    const each = resultForEach([1, 2] as const, (value) =>
      value === 1 ? ok<number, 'ok-error'>(value) : err<string, 'err-error'>('err-error'),
    )

    expectTypeOf(loop).toEqualTypeOf<Result<readonly number[], 'loop-error'>>()
    expectTypeOf(discarded).toEqualTypeOf<Result<void, 'discard-error'>>()
    expectTypeOf(iterated).toEqualTypeOf<Result<LoopState, 'iterate-error'>>()
    expectTypeOf(each).toEqualTypeOf<
      Result<readonly (number | string)[], 'ok-error' | 'err-error'>
    >()
  })
})

describe('ResultAsync loop helpers', () => {
  it('collects ResultAsync.loop body values', async () => {
    const result = await ResultAsync.loop(1, {
      while: (state) => state <= 3,
      step: (state) => state + 1,
      body: (state) => okAsync<number, string>(state * 2),
    })

    deepEqual(result._unsafeUnwrap(), [2, 4, 6])
  })

  it('discards ResultAsync.loop body values', async () => {
    const visited: number[] = []

    const result = await ResultAsync.loop(1, {
      while: (state) => state <= 3,
      step: (state) => state + 1,
      body: (state) => {
        visited.push(state)
        return okAsync<number, string>(state)
      },
      discard: true,
    })

    equal(result._unsafeUnwrap(), undefined)
    deepEqual(visited, [1, 2, 3])
  })

  it('skips ResultAsync.loop body when the initial condition is false', async () => {
    let calls = 0

    const result = await ResultAsync.loop(1, {
      while: (state) => state > 1,
      step: (state) => state + 1,
      body: (state) => {
        calls += 1
        return okAsync<number, string>(state)
      },
    })

    deepEqual(result._unsafeUnwrap(), [])
    equal(calls, 0)
  })

  it('stops ResultAsync.loop on first Err and does not call step after Err', async () => {
    const steps: number[] = []

    const result = await ResultAsync.loop(1, {
      while: (state) => state <= 3,
      step: (state) => {
        steps.push(state)
        return state + 1
      },
      body: (state) =>
        state === 2 ? errAsync<number, string>('failed') : okAsync<number, string>(state),
    })

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(steps, [1])
  })

  it('returns the final ResultAsync.iterate state', async () => {
    const result = await ResultAsync.iterate(1, {
      while: (state) => state <= 5,
      body: (state) => okAsync<number, string>(state + 1),
    })

    equal(result._unsafeUnwrap(), 6)
  })

  it('returns the initial ResultAsync.iterate state when the condition is false', async () => {
    const result = await ResultAsync.iterate(10, {
      while: (state) => state < 10,
      body: (state) => okAsync<number, string>(state + 1),
    })

    equal(result._unsafeUnwrap(), 10)
  })

  it('short-circuits ResultAsync.iterate on Err', async () => {
    const result = await ResultAsync.iterate(1, {
      while: (state) => state < 5,
      body: (state) =>
        state === 3 ? errAsync<number, string>('failed') : okAsync<number, string>(state + 1),
    })

    equal(result._unsafeUnwrapErr(), 'failed')
  })

  it('runs resultAsyncForEach sequentially and collects results', async () => {
    const calls: number[] = []
    let active = 0
    let maxActive = 0

    const result = await resultAsyncForEach(
      [1, 2, 3],
      (value) =>
        new ResultAsync<number, string>(
          Promise.try(async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            calls.push(value)
            await Promise.resolve()
            active -= 1

            return Result.ok<number, string>(value * 2)
          }),
        ),
    )

    deepEqual(result._unsafeUnwrap(), [2, 4, 6])
    deepEqual(calls, [1, 2, 3])
    equal(maxActive, 1)
  })

  it('discards resultAsyncForEach results', async () => {
    const visited: string[] = []

    const result = await resultAsyncForEach(
      ['a', 'b'],
      (value, index) => {
        visited.push(`${index}:${value}`)
        return okAsync<string, string>(value)
      },
      { discard: true },
    )

    equal(result._unsafeUnwrap(), undefined)
    deepEqual(visited, ['0:a', '1:b'])
  })

  it('handles empty resultAsyncForEach input', async () => {
    const collected = await resultAsyncForEach([], (value: string) =>
      okAsync<string, string>(value),
    )
    const discarded = await resultAsyncForEach(
      [],
      (value: string) => okAsync<string, string>(value),
      { discard: true },
    )

    deepEqual(collected._unsafeUnwrap(), [])
    equal(discarded._unsafeUnwrap(), undefined)
  })

  it('stops resultAsyncForEach before later elements on Err', async () => {
    const calls: number[] = []

    const result = await resultAsyncForEach([1, 2, 3], (value) => {
      calls.push(value)
      return value === 2 ? errAsync<number, string>('failed') : okAsync<number, string>(value)
    })

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(calls, [1, 2])
  })

  it('infers async loop helper result types', () => {
    const loop = ResultAsync.loop({ status: 'pending', cursor: 0 } as LoopState, {
      while: isPendingState,
      step: (state): LoopState =>
        state.cursor >= 1 ? { status: 'done' } : { status: 'pending', cursor: state.cursor + 1 },
      body: (state) => okAsync<number, 'loop-error'>(state.cursor),
    })
    const discarded = ResultAsync.loop(1, {
      while: (state) => state <= 1,
      step: (state) => state + 1,
      body: (state) => okAsync<number, 'discard-error'>(state),
      discard: true,
    })
    const iterated = ResultAsync.iterate({ status: 'pending', cursor: 0 } as LoopState, {
      while: isPendingState,
      body: (state) =>
        okAsync<LoopState, 'iterate-error'>(
          state.cursor >= 1 ? { status: 'done' } : { status: 'pending', cursor: state.cursor + 1 },
        ),
    })
    const each = resultAsyncForEach([1, 2] as const, (value) =>
      value === 1 ? okAsync<number, 'ok-error'>(value) : errAsync<string, 'err-error'>('err-error'),
    )

    expectTypeOf(loop).toEqualTypeOf<ResultAsync<readonly number[], 'loop-error'>>()
    expectTypeOf(discarded).toEqualTypeOf<ResultAsync<void, 'discard-error'>>()
    expectTypeOf(iterated).toEqualTypeOf<ResultAsync<LoopState, 'iterate-error'>>()
    expectTypeOf(each).toEqualTypeOf<
      ResultAsync<readonly (number | string)[], 'ok-error' | 'err-error'>
    >()
  })
})
