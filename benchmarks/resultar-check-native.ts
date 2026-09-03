import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

interface Command {
  readonly args: readonly string[]
  readonly bin: string
  readonly label: string
}

interface Summary {
  readonly mean: number
  readonly median: number
  readonly min: number
}

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(benchmarkRoot, '..')
const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
const nodeCli = join(benchmarkRoot, 'node_modules', '.bin', `resultar-check${executableSuffix}`)
const nativeCli = join(workspaceRoot, 'packages', 'check', 'native', 'resultar-check-native')

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)

  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  return value
}

const requirePath = (path: string): string => {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run the benchmark through its pnpm script.`)
  }

  return path
}

const fixtureSource = (index: number): string => `
type Result<T, E> = {
  readonly value?: T
  readonly error?: E
  map<X>(fn: (value: T) => X): Result<X, E>
  andThen<X, F>(fn: (value: T) => Result<X, F>): Result<X, E | F>
  orElse<F>(fn: (error: E) => Result<T, F>): Result<T, F>
  catchTag<X, F>(tag: string, fn: (error: E) => Result<X, F>): Result<T | X, F>
  mapErr<F>(fn: (error: E) => F): Result<T, F>
}
type ResultAsync<T, E> = { readonly value?: T; readonly error?: E }
declare const Result: {
  combine<T, E>(values: readonly Result<T, E>[]): Result<T[], E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function err<E, T = never>(error: E): Result<T, E>
declare function save${index}(): Result<string, Error>
declare function fallback${index}(): Result<string, Error>
declare function asyncFallback${index}(): ResultAsync<string, Error>
declare function asyncSave${index}(value: number): Promise<void>
declare function fromThrowable<T>(fn: () => T): Result<T, unknown>
declare function validate${index}(value: number): Result<string, Error>
declare function safeTry(body: unknown): unknown
declare function createTaggedError(options: { readonly message?: string; readonly name: string }): new (...args: readonly unknown[]) => Error
declare const values${index}: readonly number[]
declare const nested${index}: Result<string, { reason: { _tag: string } }>
declare const infallible${index}: Result<string, never>

save${index}()
const unhandled${index} = save${index}()
ok(${index}).map(asyncSave${index})
declare const unsafe${index}: Result<string, unknown>
void unsafe${index}
void save${index}().orElse(() => err(new Error("mapped")))
void save${index}().map(() => fallback${index}())
void save${index}().map(() => asyncFallback${index}())
void save${index}().andThen((value) => ok(value.length))
void save${index}().orElse(() => fallback${index}()).orElse(() => fallback${index}())
void fromThrowable(() => ${index})
void Result.combine(values${index}.map(validate${index}))
void nested${index}.catchTag("Nested", (error) => error.reason._tag === "Missing" ? nested${index} : nested${index})
void err(new Error("channel"))
class NativeError${index} extends Error { readonly native = ${index} }
class OtherError${index} extends Error { readonly other = ${index} }
class TaggedError${index} extends createTaggedError({ name: "WrongTaggedError${index}" }) {
  constructor() {
    super()
  }
}
declare const union${index}: Result<string, NativeError${index} | OtherError${index}>
void infallible${index}.mapErr((error) => error)
const narrowed${index} = union${index} as Result<string, NativeError${index}>
safeTry(async function* () {
  yield nested${index}
  await Promise.resolve(${index})
  try {
    void ${index}
  } finally {}
})
async function rawPromise${index}(): Promise<number> {
  return await Promise.resolve(${index})
}
try {
  throw new Error("failed")
} catch {}
`

const createFixture = (fileCount: number): string => {
  const directory = mkdtempSync(join(benchmarkRoot, '.resultar-native-'))
  const sourceDirectory = join(directory, 'src')

  mkdirSync(sourceDirectory)

  const files: string[] = []

  for (let index = 0; index < fileCount; index += 1) {
    const file = join(sourceDirectory, `case-${index}.ts`)

    writeFileSync(file, fixtureSource(index))
    files.push(file)
  }

  writeFileSync(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          plugins: [
            {
              name: 'resultar-check',
              noAwaitInSafeTry: 'error',
              noDiscard: 'error',
              noPromiseInResultSuccess: 'warning',
              noTaggedErrorConstructorOverride: 'warning',
              noThrow: 'warning',
              noTryCatch: 'warning',
              noTryCatchInSafeTry: 'warning',
              noUnsafeAwait: 'warning',
              noUnsafeAwaitMode: 'all',
              noUnknownResultError: 'suggestion',
              noUselessRecovery: 'warning',
              preferAndThen: 'warning',
              preferCatchReason: 'warning',
              preferFirstSuccessOf: 'warning',
              preferMap: 'warning',
              preferMapErr: 'warning',
              preferResultForEach: 'warning',
              preferTaggedError: 'warning',
              taggedErrorNameMatch: 'warning',
              typedCatchMapper: 'warning',
              unsafeResultTypeAssertion: 'warning',
              yieldStarInSafeTry: 'warning',
            },
          ],
          skipLibCheck: true,
          strict: true,
          target: 'ES2022',
          types: [],
        },
        files,
      },
      null,
      2,
    )}\n`,
  )

  return directory
}

const run = (
  command: Command,
  cwd: string,
): { readonly elapsed: number; readonly output: string } => {
  const start = performance.now()
  const result = spawnSync(command.bin, command.args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const elapsed = performance.now() - start

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 1) {
    throw new Error(
      `${command.label} exited with ${result.status ?? 'no status'}\n${result.stderr}`,
    )
  }

  return { elapsed, output: `${result.stdout}${result.stderr}` }
}

const summarize = (samples: readonly number[]): Summary => {
  const sorted = samples.toSorted((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
      : (sorted[midpoint] ?? 0)

  return {
    mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
    median,
    min: sorted[0] ?? 0,
  }
}

const diagnosticPattern =
  /resultar\/(no-await-in-safe-try|no-discard|no-promise-in-result-success|no-tagged-error-constructor-override|no-throw|no-try-catch-in-safe-try|no-try-catch|no-unsafe-await|no-unknown-result-error|no-useless-recovery|prefer-and-then|prefer-catch-reason|prefer-first-success-of|prefer-map-err|prefer-map|prefer-result-for-each|prefer-tagged-error|tagged-error-name-match|typed-catch-mapper|unsafe-result-type-assertion|yield-star-in-safe-try)\b/g

const diagnosticHistogram = (output: string): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {}

  for (const match of output.matchAll(diagnosticPattern)) {
    const rule = match[1]

    if (rule !== undefined) {
      counts[rule] = (counts[rule] ?? 0) + 1
    }
  }

  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)),
  )
}

const main = (): void => {
  const fileCount = positiveInteger('RESULTAR_NATIVE_BENCH_FILES', 120)
  const runs = positiveInteger('RESULTAR_NATIVE_BENCH_RUNS', 7)
  const warmups = positiveInteger('RESULTAR_NATIVE_BENCH_WARMUPS', 2)
  const directory = createFixture(fileCount)
  const project = join(directory, 'tsconfig.json')
  const commands: readonly Command[] = [
    { args: ['--project', project], bin: requirePath(nodeCli), label: 'npm CLI launcher' },
    { args: ['--project', project], bin: requirePath(nativeCli), label: 'native executable' },
  ]

  try {
    for (let index = 0; index < warmups; index += 1) {
      for (const command of commands) {
        run(command, directory)
      }
    }

    const samples = new Map(commands.map((command) => [command.label, [] as number[]]))
    const histograms = new Map<string, Readonly<Record<string, number>>>()

    for (let index = 0; index < runs; index += 1) {
      const ordered = index % 2 === 0 ? commands : commands.toReversed()

      for (const command of ordered) {
        const result = run(command, directory)

        samples.get(command.label)?.push(result.elapsed)
        histograms.set(command.label, diagnosticHistogram(result.output))
      }
    }

    const launcherHistogram = histograms.get('npm CLI launcher') ?? {}
    const nativeHistogram = histograms.get('native executable') ?? {}

    if (JSON.stringify(launcherHistogram) !== JSON.stringify(nativeHistogram)) {
      throw new Error(
        `diagnostic histogram mismatch:\nlauncher=${JSON.stringify(launcherHistogram)}\nnative=${JSON.stringify(nativeHistogram)}`,
      )
    }

    if (Object.keys(nativeHistogram).length !== 21) {
      throw new Error(
        `benchmark fixture did not exercise all 21 rules: ${JSON.stringify(nativeHistogram)}`,
      )
    }

    const nativeCount = Object.values(nativeHistogram).reduce((total, count) => total + count, 0)

    const launcherSummary = summarize(samples.get('npm CLI launcher') ?? [])
    const nativeSummary = summarize(samples.get('native executable') ?? [])
    const overhead = launcherSummary.median - nativeSummary.median

    process.stdout.write(
      [
        'Resultar Check native launcher benchmark',
        `files: ${fileCount}`,
        `diagnostics: ${nativeCount}`,
        `warmups: ${warmups}; runs: ${runs}`,
        '',
        'tool                    median ms    mean ms     min ms',
        `npm CLI launcher       ${launcherSummary.median.toFixed(1).padStart(9)} ${launcherSummary.mean.toFixed(1).padStart(10)} ${launcherSummary.min.toFixed(1).padStart(10)}`,
        `native executable      ${nativeSummary.median.toFixed(1).padStart(9)} ${nativeSummary.mean.toFixed(1).padStart(10)} ${nativeSummary.min.toFixed(1).padStart(10)}`,
        '',
        `launcher overhead: ${overhead.toFixed(1)} ms`,
        '',
      ].join('\n'),
    )
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

main()
