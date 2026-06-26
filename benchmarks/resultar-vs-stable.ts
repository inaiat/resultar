import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import * as localResultar from 'resultar'

type ResultarModule = typeof localResultar
type BenchFn = () => unknown
type AsyncBenchFn = () => Promise<unknown>

interface Bench {
  readonly name: string
  readonly local: BenchFn | AsyncBenchFn
  readonly stable: BenchFn | AsyncBenchFn
  readonly type: 'async' | 'sync'
}

interface StablePackage {
  readonly cleanup: () => void
  readonly module: ResultarModule
  readonly spec: string
  readonly version: string
}

type BenchTarget = 'local' | 'stable'

const localPackage = JSON.parse(
  readFileSync(new URL('../packages/resultar/package.json', import.meta.url), 'utf8'),
) as { readonly version: string }

const okValue = 10
const errValue = 3
const payload = { id: 1 }
const errorPayload = { code: 'boom' }

let sink: unknown

const consume = (value: unknown): void => {
  sink = value
}

const collectGarbage = (): void => {
  const gc = (globalThis as { readonly gc?: () => void }).gc

  if (gc !== undefined) {
    gc()
  }
}

const run = (command: string, args: readonly string[], cwd: string): string => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  return result.stdout.trim()
}

const loadStablePackage = async (): Promise<StablePackage> => {
  const entry = process.env.RESULTAR_STABLE_ENTRY

  if (entry) {
    return {
      cleanup: () => undefined,
      module: (await import(pathToFileURL(entry).href)) as ResultarModule,
      spec: entry,
      version: 'custom',
    }
  }

  const spec = process.env.RESULTAR_STABLE_SPEC ?? 'resultar@latest'
  const directory = mkdtempSync(join(tmpdir(), 'resultar-stable-'))

  try {
    const tarballName = run('npm', ['pack', '--silent', spec, '--pack-destination', directory], directory)
      .split('\n')
      .at(-1)

    if (!tarballName) {
      throw new Error(`npm pack ${spec} did not return a tarball name`)
    }

    run('tar', ['-xzf', join(directory, tarballName), '-C', directory], directory)

    const packageDirectory = join(directory, 'package')
    const packageJson = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as {
      readonly version: string
    }
    const module = (await import(pathToFileURL(join(packageDirectory, 'dist/index.js')).href)) as
      ResultarModule

    return {
      cleanup: () => {
        rmSync(directory, { force: true, recursive: true })
      },
      module,
      spec,
      version: packageJson.version,
    }
  } catch (error) {
    rmSync(directory, { force: true, recursive: true })
    throw error
  }
}

const createBenches = (stable: ResultarModule): readonly Bench[] => {
  const localOk = localResultar.ok<number, number>(okValue)
  const localErr = localResultar.err<number, number>(errValue)
  const stableOk = stable.ok<number, number>(okValue)
  const stableErr = stable.err<number, number>(errValue)

  const localAllOkList = [localResultar.ok(1), localResultar.ok(2), localResultar.ok(3)]
  const stableAllOkList = [stable.ok(1), stable.ok(2), stable.ok(3)]
  const localWithErrList = [localResultar.ok(1), localResultar.err(2), localResultar.ok(3)]
  const stableWithErrList = [stable.ok(1), stable.err(2), stable.ok(3)]
  const localAllOkSet = new Set(localAllOkList)
  const stableAllOkSet = new Set(stableAllOkList)
  const localRecord = { a: localResultar.ok(1), b: localResultar.ok(2), c: localResultar.ok(3) }
  const stableRecord = { a: stable.ok(1), b: stable.ok(2), c: stable.ok(3) }
  const localRecordWithErr = { a: localResultar.ok(1), b: localResultar.err(2), c: localResultar.err(3) }
  const stableRecordWithErr = { a: stable.ok(1), b: stable.err(2), c: stable.err(3) }
  const numbers = [1, 2, 3, 4, 5]

  const localDoubleAsync = (value: number): localResultar.ResultAsync<number, number> =>
    localResultar.okAsync(value * 2)
  const stableDoubleAsync = (value: number): localResultar.ResultAsync<number, number> =>
    stable.okAsync(value * 2) as localResultar.ResultAsync<number, number>

  return [
    {
      local: () => localResultar.ok(payload),
      name: 'sync/ok construction',
      stable: () => stable.ok(payload),
      type: 'sync',
    },
    {
      local: () => localResultar.err(errorPayload),
      name: 'sync/err construction',
      stable: () => stable.err(errorPayload),
      type: 'sync',
    },
    {
      local: () => localOk.isOk(),
      name: 'sync/isOk on Ok',
      stable: () => stableOk.isOk(),
      type: 'sync',
    },
    {
      local: () => localErr.isErr(),
      name: 'sync/isErr on Err',
      stable: () => stableErr.isErr(),
      type: 'sync',
    },
    {
      local: () => localOk.map((value) => value * 2),
      name: 'sync/map on Ok',
      stable: () => stableOk.map((value) => value * 2),
      type: 'sync',
    },
    {
      local: () => localOk.andThen((value) => localResultar.ok(value * 2)),
      name: 'sync/andThen on Ok',
      stable: () => stableOk.andThen((value) => stable.ok(value * 2)),
      type: 'sync',
    },
    {
      local: () => localOk.match((value) => value * 2, (error) => error),
      name: 'sync/match positional on Ok',
      stable: () => stableOk.match((value) => value * 2, (error) => error),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.combine(localAllOkList),
      name: 'sync/combine array all Ok',
      stable: () => stable.Result.combine(stableAllOkList),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.combine(localAllOkSet),
      name: 'sync/combine iterable all Ok',
      stable: () => stable.Result.combine(stableAllOkSet),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.combine(localWithErrList),
      name: 'sync/combine array with Err',
      stable: () => stable.Result.combine(stableWithErrList),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.combine(localRecord),
      name: 'sync/combine record all Ok',
      stable: () => stable.Result.combine(stableRecord),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.combineWithAllErrors(localRecordWithErr),
      name: 'sync/combineWithAllErrors record',
      stable: () => stable.Result.combineWithAllErrors(stableRecordWithErr),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.validateAll(localAllOkList),
      name: 'sync/validateAll no mapper',
      stable: () => stable.Result.validateAll(stableAllOkList),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.validateAll(numbers, (value) => localResultar.ok(value * 2)),
      name: 'sync/validateAll mapper',
      stable: () => stable.Result.validateAll(numbers, (value) => stable.ok(value * 2)),
      type: 'sync',
    },
    {
      local: () =>
        localResultar.Result.firstSuccessOf([
          () => localResultar.err('a'),
          () => localResultar.err('b'),
          () => localResultar.ok(1),
        ]),
      name: 'sync/firstSuccessOf after failures',
      stable: () =>
        stable.Result.firstSuccessOf([
          () => stable.err('a'),
          () => stable.err('b'),
          () => stable.ok(1),
        ]),
      type: 'sync',
    },
    {
      local: () =>
        localResultar.Result.loop(0, {
          body: (state) => localResultar.ok(state + 1),
          step: (state) => state + 1,
          while: (state) => state < 5,
        }),
      name: 'sync/loop collect',
      stable: () =>
        stable.Result.loop(0, {
          body: (state) => stable.ok(state + 1),
          step: (state) => state + 1,
          while: (state) => state < 5,
        }),
      type: 'sync',
    },
    {
      local: () =>
        localResultar.Result.loop(0, {
          body: (state) => localResultar.ok(state + 1),
          discard: true,
          step: (state) => state + 1,
          while: (state) => state < 5,
        }),
      name: 'sync/loop discard',
      stable: () =>
        stable.Result.loop(0, {
          body: (state) => stable.ok(state + 1),
          discard: true,
          step: (state) => state + 1,
          while: (state) => state < 5,
        }),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.forEach(numbers, (value) => localResultar.ok(value * 2)),
      name: 'sync/forEach collect',
      stable: () => stable.Result.forEach(numbers, (value) => stable.ok(value * 2)),
      type: 'sync',
    },
    {
      local: () =>
        localResultar.Result.forEach(numbers, (value) => localResultar.ok(value * 2), {
          discard: true,
        }),
      name: 'sync/forEach discard',
      stable: () =>
        stable.Result.forEach(numbers, (value) => stable.ok(value * 2), {
          discard: true,
        }),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.when(() => true, () => localResultar.ok(1)),
      name: 'sync/when lazy true',
      stable: () => stable.Result.when(() => true, () => stable.ok(1)),
      type: 'sync',
    },
    {
      local: () => localResultar.Result.unless(() => false, () => localResultar.ok(1)),
      name: 'sync/unless lazy false',
      stable: () => stable.Result.unless(() => false, () => stable.ok(1)),
      type: 'sync',
    },
    {
      local: async () => localResultar.okAsync(okValue),
      name: 'async/okAsync await',
      stable: async () => stable.okAsync(okValue),
      type: 'async',
    },
    {
      local: async () => localResultar.okAsync(okValue).map((value) => value * 2),
      name: 'async/map on Ok',
      stable: async () => stable.okAsync(okValue).map((value) => value * 2),
      type: 'async',
    },
    {
      local: async () => localResultar.okAsync(okValue).andThen(localDoubleAsync),
      name: 'async/andThen on Ok',
      stable: async () => stable.okAsync(okValue).andThen(stableDoubleAsync),
      type: 'async',
    },
    {
      local: async () => localResultar.ResultAsync.combine(numbers.map(localResultar.okAsync)),
      name: 'async/combine array all Ok',
      stable: async () => stable.ResultAsync.combine(numbers.map(stable.okAsync)),
      type: 'async',
    },
    {
      local: async () =>
        localResultar.ResultAsync.forEach(numbers, (value) => localResultar.okAsync(value * 2), {
          discard: true,
        }),
      name: 'async/forEach discard',
      stable: async () =>
        stable.ResultAsync.forEach(numbers, (value) => stable.okAsync(value * 2), {
          discard: true,
        }),
      type: 'async',
    },
    {
      local: async () =>
        localResultar.ResultAsync.retry(
          (attempt) => (attempt === 0 ? localResultar.errAsync('retry') : localResultar.okAsync(1)),
          { times: 1 },
        ),
      name: 'async/retry once no hook',
      stable: async () =>
        stable.ResultAsync.retry(
          (attempt) => (attempt === 0 ? stable.errAsync('retry') : stable.okAsync(1)),
          { times: 1 },
        ),
      type: 'async',
    },
    {
      local: async () =>
        localResultar.ResultAsync.retry(
          (attempt) => (attempt === 0 ? localResultar.errAsync('retry') : localResultar.okAsync(1)),
          { onRetry: () => undefined, times: 1 },
        ),
      name: 'async/retry once with hook',
      stable: async () =>
        stable.ResultAsync.retry(
          (attempt) => (attempt === 0 ? stable.errAsync('retry') : stable.okAsync(1)),
          { onRetry: () => undefined, times: 1 },
        ),
      type: 'async',
    },
    {
      local: async () =>
        localResultar.ResultAsync.race(
          () => localResultar.okAsync(1),
          () => localResultar.okAsync(2),
        ),
      name: 'async/race immediate Ok',
      stable: async () =>
        stable.ResultAsync.race(
          () => stable.okAsync(1),
          () => stable.okAsync(2),
        ),
      type: 'async',
    },
  ]
}

const parsePositiveInteger = (name: string, fallback: number): number => {
  const value = process.env[name]

  if (value === undefined) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}=${value}`)
  }

  return parsed
}

const selectBenches = (benches: readonly Bench[]): readonly Bench[] => {
  const filter = process.env.BENCH_FILTER

  if (filter === undefined || filter === '') {
    return benches
  }

  const selected = benches.filter((bench) => bench.name.includes(filter))

  if (selected.length === 0) {
    throw new Error(`No benchmark tests matched BENCH_FILTER=${filter}`)
  }

  return selected
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number)
}

const runSyncBench = (fn: BenchFn, iterations: number): number => {
  for (let index = 0; index < Math.min(iterations, 1_000); index += 1) {
    consume(fn())
  }

  collectGarbage()

  const start = performance.now()

  for (let index = 0; index < iterations; index += 1) {
    consume(fn())
  }

  return iterations / ((performance.now() - start) / 1_000)
}

const runAsyncBench = async (fn: AsyncBenchFn, iterations: number): Promise<number> => {
  for (let index = 0; index < Math.min(iterations, 100); index += 1) {
    consume(await fn())
  }

  collectGarbage()

  const start = performance.now()

  for (let index = 0; index < iterations; index += 1) {
    consume(await fn())
  }

  return iterations / ((performance.now() - start) / 1_000)
}

const measureOne = async (
  bench: Bench,
  target: 'local' | 'stable',
  iterations: number,
): Promise<number> => {
  const fn = bench[target]

  return bench.type === 'async'
    ? await runAsyncBench(fn as AsyncBenchFn, iterations)
    : runSyncBench(fn as BenchFn, iterations)
}

const measurePair = async (
  bench: Bench,
  iterations: number,
  rounds: number,
): Promise<{ readonly localOps: number; readonly stableOps: number }> => {
  const localSamples: number[] = []
  const stableSamples: number[] = []

  for (let round = 0; round < rounds; round += 1) {
    if (round % 2 === 0) {
      localSamples.push(await measureOne(bench, 'local', iterations))
      stableSamples.push(await measureOne(bench, 'stable', iterations))
    } else {
      stableSamples.push(await measureOne(bench, 'stable', iterations))
      localSamples.push(await measureOne(bench, 'local', iterations))
    }
  }

  return {
    localOps: median(localSamples),
    stableOps: median(stableSamples),
  }
}

const measureTarget = async (
  bench: Bench,
  target: BenchTarget,
  iterations: number,
  rounds: number,
): Promise<number> => {
  const samples: number[] = []

  for (let round = 0; round < rounds; round += 1) {
    samples.push(await measureOne(bench, target, iterations))
  }

  return median(samples)
}

const parseBenchTarget = (): BenchTarget | undefined => {
  const target = process.env.BENCH_TARGET

  if (target === undefined || target === '') {
    return undefined
  }

  if (target === 'local' || target === 'stable') {
    return target
  }

  throw new Error(`BENCH_TARGET must be "local" or "stable"; got ${target}`)
}

const formatOps = (value: number): string =>
  Math.round(value).toLocaleString('en-US', { maximumFractionDigits: 0 })

const formatDelta = (localOps: number, stableOps: number): string => {
  const delta = (localOps / stableOps - 1) * 100
  const sign = delta >= 0 ? '+' : ''

  return `${sign}${delta.toFixed(1)}%`
}

const printRow = (columns: readonly string[], widths: readonly number[]): void => {
  console.log(columns.map((column, index) => column.padEnd(widths[index] as number)).join('  '))
}

const stablePackage = await loadStablePackage()

try {
  const syncIterations = parsePositiveInteger('BENCH_SYNC_ITERATIONS', 100_000)
  const asyncIterations = parsePositiveInteger('BENCH_ASYNC_ITERATIONS', 5_000)
  const rounds = parsePositiveInteger('BENCH_ROUNDS', 5)
  const target = parseBenchTarget()
  const benches = selectBenches(createBenches(stablePackage.module))
  const rows: string[][] = []

  console.log(
    `Comparing local workspace resultar@${localPackage.version} against ${stablePackage.spec} (${stablePackage.version})`,
  )
  console.log(
    `Rounds: ${rounds}; sync iterations/round: ${syncIterations}; async iterations/round: ${asyncIterations}`,
  )
  console.log('')

  if (target !== undefined) {
    for (const bench of benches) {
      const iterations = bench.type === 'async' ? asyncIterations : syncIterations
      const ops = await measureTarget(bench, target, iterations, rounds)

      rows.push([bench.name, bench.type, target, formatOps(ops)])
    }

    const headers = ['benchmark', 'type', 'target', 'ops/s']
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => (row[index] as string).length)),
    )

    printRow(headers, widths)
    printRow(
      widths.map((width) => '-'.repeat(width)),
      widths,
    )
    for (const row of rows) {
      printRow(row, widths)
    }
  } else {
    for (const bench of benches) {
      const iterations = bench.type === 'async' ? asyncIterations : syncIterations
      const { localOps, stableOps } = await measurePair(bench, iterations, rounds)

      rows.push([
        bench.name,
        bench.type,
        formatOps(localOps),
        formatOps(stableOps),
        formatDelta(localOps, stableOps),
      ])
    }

    const headers = ['benchmark', 'type', 'local ops/s', 'stable ops/s', 'local delta']
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => (row[index] as string).length)),
    )

    printRow(headers, widths)
    printRow(
      widths.map((width) => '-'.repeat(width)),
      widths,
    )

    for (const row of rows) {
      printRow(row, widths)
    }
  }
} finally {
  stablePackage.cleanup()
  void sink
}
