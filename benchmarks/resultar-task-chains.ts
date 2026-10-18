import { performance } from 'node:perf_hooks'
import { strictEqual } from 'node:assert'
import { ResultTask } from 'resultar'

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
  let constructedTask = ResultTask.ok(0)
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Build ${n} andThen steps`, async () => {
      let t = ResultTask.ok(0)
      for (let i = 0; i < n; i++) {
        t = t.andThen((x) => ResultTask.ok(x + 1))
      }
      constructedTask = t
    })
    // Consume the constructed chain outside the timed region.
    strictEqual(await ResultTask.runPromise(constructedTask), n)
  }

  console.log('\n2. Sequential Execution (ResultTask andThen chains):')
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Run ${n} andThen steps`, async () => {
      let t = ResultTask.ok(0)
      for (let i = 0; i < n; i++) {
        t = t.andThen((x) => ResultTask.ok(x + 1))
      }
      const result = await ResultTask.runPromise(t)
      strictEqual(result, n)
    })
  }

  console.log('\n3. Sequential Execution (ResultTask map chains):')
  for (const n of [10, 100, 1_000, 10_000]) {
    await measure(`Run ${n} maps`, async () => {
      let t = ResultTask.ok(0)
      for (let i = 0; i < n; i++) {
        t = t.map((x) => x + 1)
      }
      const result = await ResultTask.runPromise(t)
      strictEqual(result, n)
    })
  }

  console.log('\n4. ResultTask synchronous vs Promise-producing steps (1,000 chained andThen):')
  await measure('ResultTask 1,000 synchronous andThen steps', async () => {
    let t = ResultTask.ok(0)
    for (let i = 0; i < 1_000; i++) {
      t = t.andThen((x) => ResultTask.ok(x + 1))
    }
    strictEqual(await ResultTask.runPromise(t), 1_000)
  })

  await measure('ResultTask 1,000 Promise-producing andThen steps', async () => {
    let task = ResultTask.ok<number, string>(0)
    for (let i = 0; i < 1_000; i++) {
      task = task.andThen((value) =>
        ResultTask.tryPromise({ try: () => Promise.resolve(value + 1), catch: String }),
      )
    }
    strictEqual(await ResultTask.runPromise(task), 1_000)
  })

  console.log('\n=== Benchmarks Completed Successfully ===')
}

void run()
