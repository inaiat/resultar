import { expect, expectTypeOf, test } from 'vite-plus/test'
import { Result, tryResult } from '../src/index.js'

interface Models {
  account: { readonly name: string; active?: boolean }
  project: { title: string }
}
const models: Models = { account: { name: 'a' }, project: { title: 'p' } }
const failure = () => ({ _tag: 'DecodeError' as const })
const read = <K extends keyof Models>(key: K): Result<Models[K], ReturnType<typeof failure>> =>
  Result.try(() => models[key], failure)
const readObject = <K extends keyof Models>(
  key: K,
): Result<Models[K], ReturnType<typeof failure>> =>
  tryResult({ try: () => models[key], catch: failure })

test('indexed synchronous results preserve their keys and mapper types', () => {
  expectTypeOf(read('account')).toEqualTypeOf<
    Result<Models['account'], ReturnType<typeof failure>>
  >()
  expectTypeOf(readObject('project')).toEqualTypeOf<
    Result<Models['project'], ReturnType<typeof failure>>
  >()
  expect(read('account').unwrapOrThrow()).toBe(models.account)
  expectTypeOf(
    Result.try(() => {
      throw new Error('fail')
    }, failure),
  ).toEqualTypeOf<Result<never, ReturnType<typeof failure>>>()
})
const negative = () => {
  // @ts-expect-error Async callbacks are not synchronous boundaries.
  Result.try(async () => 1, failure)
  // @ts-expect-error Native Promise values are forbidden.
  tryResult({ try: () => Promise.resolve(1), catch: failure })
  // @ts-expect-error Mixed native Promise unions are forbidden.
  Result.try(() => (Math.random() > 0.5 ? 1 : Promise.resolve(1)), failure)
  const thenable = { then: () => 1 }
  expectTypeOf(Result.try(() => thenable, failure)).toEqualTypeOf<
    Result<typeof thenable, ReturnType<typeof failure>>
  >()
}
expectTypeOf(negative).toBeFunction()

const readUnmapped = <K extends keyof Models>(key: K): Result<Models[K], unknown> =>
  Result.try(() => models[key])
const readUnmappedObject = <K extends keyof Models>(key: K): Result<Models[K], unknown> =>
  tryResult({ try: () => models[key] })
test('union keys and unmapped boundaries retain indexed results', () => {
  const key: keyof Models = Math.random() > 0.5 ? 'account' : 'project'
  expectTypeOf(read(key)).toEqualTypeOf<Result<Models[keyof Models], ReturnType<typeof failure>>>()
  expectTypeOf(readUnmapped('account')).toEqualTypeOf<Result<Models['account'], unknown>>()
  expectTypeOf(readUnmappedObject('project')).toEqualTypeOf<Result<Models['project'], unknown>>()
  let calls = 0
  const error = new Error('mapped')
  const value = Result.try(
    () => {
      calls += 1
      throw error
    },
    (cause) => ({ cause }),
  )
  expect(calls).toBe(1)
  expect(value.isErr() && value.error.cause).toBe(error)
  expect(() =>
    Result.try(
      () => {
        throw error
      },
      () => {
        throw error
      },
    ),
  ).toThrow(error)
})
