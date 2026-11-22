import { deepEqual, equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Result, err, ok } from '../src/index.js'

type PendingState = { readonly cursor: number; readonly status: 'pending' }

type DoneState = { readonly status: 'done' }

type LoopState = DoneState | PendingState

const isPendingState = (state: LoopState): state is PendingState => state.status === 'pending'
const resultForEach: typeof Result.forEach = Result.forEach

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

  it('stops discarded Result.loop on first Err', () => {
    const steps: number[] = []

    const result = Result.loop(1, {
      while: (state) => state <= 3,
      step: (state) => {
        steps.push(state)
        return state + 1
      },
      body: (state) => (state === 2 ? err<number, string>('failed') : ok<number, string>(state)),
      discard: true,
    })

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(steps, [1])
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

  it('stops discarded resultForEach before later elements on Err', () => {
    const calls: number[] = []

    const result = resultForEach(
      [1, 2, 3],
      (value) => {
        calls.push(value)
        return value === 2 ? err<number, string>('failed') : ok<number, string>(value)
      },
      { discard: true },
    )

    equal(result._unsafeUnwrapErr(), 'failed')
    deepEqual(calls, [1, 2])
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
