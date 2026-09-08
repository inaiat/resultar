import { performance } from 'node:perf_hooks'
import { strictEqual } from 'node:assert'
import { ResultTask, okAsync } from 'resultar'

const measure = async (name: string, fn: () => Promise<unknown>): Promise<number> => {
  // Warmup
  await fn()

  const start = performance.now()
  await fn()
  const durationMs = performance.now() - start
  console.log(`- ${name}: ${durationMs.toFixed(2)}ms`)
  return durationMs
}

const run = async (): Promise<void> => {
  console.log('=== ResultTask Chain Benchmarks ===\n')

  console.log('1. Lazy Task Construction (without running):')
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Build ${n} flatMaps`, async () => {
      let t = ResultTask.succeed(0)
      for (let i = 0; i < n; i++) {
        t = t.flatMap((x) => ResultTask.succeed(x + 1))
      }
    })
  }

  console.log('\n2. Sequential Execution (ResultTask flatMap chains):')
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Run ${n} flatMaps`, async () => {
      let t = ResultTask.succeed(0)
      for (let i = 0; i < n; i++) {
        t = t.flatMap((x) => ResultTask.succeed(x + 1))
      }
      const result = await ResultTask.runPromise(t)
      strictEqual(result, n)
    })
  }

  console.log('\n3. Sequential Execution (ResultTask map chains):')
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Run ${n} maps`, async () => {
      let t = ResultTask.succeed(0)
      for (let i = 0; i < n; i++) {
        t = t.map((x) => x + 1)
      }
      const result = await ResultTask.runPromise(t)
      strictEqual(result, n)
    })
  }

  console.log('\n4. Comparison: ResultTask vs ResultAsync (1,000 chained andThen):')
  await measure('ResultTask 1,000 flatMaps', async () => {
    let t = ResultTask.succeed(0)
    for (let i = 0; i < 1_000; i++) {
      t = t.flatMap((x) => ResultTask.succeed(x + 1))
    }
    strictEqual(await ResultTask.runPromise(t), 1_000)
  })

  await measure('ResultAsync 1,000 andThen', async () => {
    let a = okAsync(0)
    for (let i = 0; i < 1_000; i++) {
      a = a.andThen((x) => okAsync(x + 1))
    }
    const res = await a
    strictEqual(res._unsafeUnwrap(), 1_000)
  })

  console.log('\n=== Benchmarks Completed Successfully ===')
}

void run()
