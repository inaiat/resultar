import { expect, test } from 'vite-plus/test'
import { ResultTask } from '../src/index.js'

test('curried tokens retain identity and support named inline provisioning', async () => {
  const tag = ResultTask.service<number>()
  const First = tag('shared')
  const Second = ResultTask.service<string>()('shared')
  expect(First.key).not.toBe(Second.key)
  const isolated = ResultTask.gen(function* () {
    return [yield* First, yield* Second]
  })
    .provideService(First, 1)
    .provideService(Second, '2')
  expect(await ResultTask.runPromise(isolated)).toEqual([1, '2'])

  const inline = ResultTask.gen(function* () {
    return yield* ResultTask.service<number>()('shared')
  })
  expect(await ResultTask.runPromise(inline.provideServices({ shared: 42 }))).toBe(42)
  // Token provisioning also supplies the existing named fallback for separately created tags.
  expect(await ResultTask.runPromise(inline.provideService(First, 1))).toBe(1)
})

test('token provisioning takes precedence over a named environment', async () => {
  const Tag = ResultTask.service<number>()('value')
  const task = ResultTask.gen(function* () {
    return yield* Tag
  }).provideService(Tag, 1)
  const program = ResultTask.gen(function* () {
    yield* ResultTask.service<number>()('value')
    return yield* task
  }).provideServices({ value: 2 })
  expect(await ResultTask.runPromise(program)).toBe(1)
})
