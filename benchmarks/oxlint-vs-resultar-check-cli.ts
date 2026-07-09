import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface Command {
  readonly allowNonZero?: boolean
  readonly args: readonly string[]
  readonly bin: string
  readonly cwd: string
  readonly label: string
}

interface BenchSubject {
  readonly oxlintTarget: string
  readonly projectDir: string
  readonly resultarCheckCwd: string
  readonly rootDir: string
  readonly sourceLabel: string
}

interface Summary {
  readonly max: number
  readonly mean: number
  readonly median: number
  readonly min: number
  readonly samples: readonly number[]
}

interface CommandRun {
  readonly elapsed: number
  readonly output: string
  readonly status: number
}

const benchmarkRoot = dirname(fileURLToPath(import.meta.url))
const nodeModulesBin = join(benchmarkRoot, 'node_modules', '.bin')
const tempRoot = join(benchmarkRoot, '.tmp')
const executableSuffix = process.platform === 'win32' ? '.cmd' : ''
const denoBin = process.env.DENO_BIN ?? 'deno'

const astRuleSeverities = {
  'resultar/no-await-in-safe-try': 'error',
  'resultar/no-tagged-error-constructor-override': 'error',
  'resultar/no-throw': 'error',
  'resultar/no-try-catch-in-safe-try': 'error',
  'resultar/prefer-tagged-error': 'error',
  'resultar/tagged-error-name-match': 'error',
  'resultar/typed-catch-mapper': 'error',
  'resultar/yield-star-in-safe-try': 'error',
} as const
const astRuleNames = Object.keys(astRuleSeverities).map((ruleId) =>
  ruleId.replace('resultar/', ''),
)

const sharedResultarCheckPluginOptions = {
  ignoreFilePatterns: [],
  name: 'resultar-check',
  noAwaitInSafeTry: 'error',
  noDiscard: 'off',
  noTaggedErrorConstructorOverride: 'error',
  noThrow: 'error',
  noTryCatchInSafeTry: 'error',
  noUnsafeAwait: 'off',
  noUselessRecovery: 'off',
  preferAndThen: 'off',
  preferMapErr: 'off',
  preferTaggedError: 'error',
  taggedErrorNameMatch: 'error',
  typedCatchMapper: 'error',
  unsafeResultTypeAssertion: 'off',
  yieldStarInSafeTry: 'error',
} as const

const parsePositiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]

  if (raw === undefined || raw === '') {
    return fallback
  }

  const parsed = Number(raw)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  return parsed
}

const requireExistingPath = (path: string, label: string): string => {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}. Run pnpm install before benchmarking.`)
  }

  return path
}

const readPackageVersion = (packageName: string): string => {
  const packageJsonPath = join(benchmarkRoot, 'node_modules', packageName, 'package.json')
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { readonly version?: unknown }

  return typeof parsed.version === 'string' ? parsed.version : 'unknown'
}

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const findNearestTsconfig = (startPath: string): string => {
  let currentDir = startPath

  while (currentDir !== dirname(currentDir)) {
    const candidate = join(currentDir, 'tsconfig.json')

    if (existsSync(candidate)) {
      return candidate
    }

    currentDir = dirname(currentDir)
  }

  throw new Error(`Unable to find tsconfig.json for ${startPath}`)
}

const writeOxlintConfig = (projectDir: string): void => {
  const pluginPath = requireExistingPath(
    join(benchmarkRoot, 'node_modules', 'resultar-check', 'dist', 'eslint', 'plugin.js'),
    'resultar-check Oxlint plugin',
  )

  writeJson(join(projectDir, 'oxlint.config.json'), {
    jsPlugins: [{ name: 'resultar', specifier: pluginPath }],
    rules: astRuleSeverities,
  })
}

const writeEslintConfig = (projectDir: string): void => {
  writeFileSync(
    join(projectDir, 'eslint.config.mjs'),
    `import parser from '@babel/eslint-parser'
import resultar from 'resultar-check/eslint'

export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: {
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: {
            plugins: ['typescript'],
          },
          plugins: ['@babel/plugin-syntax-typescript'],
        },
        ecmaVersion: 'latest',
        requireConfigFile: false,
        sourceType: 'module',
      },
    },
    plugins: { resultar },
    rules: ${JSON.stringify(astRuleSeverities, null, 6)},
  },
]
`,
  )
}

const writeDenoConfig = (projectDir: string): void => {
  const pluginPath = requireExistingPath(
    join(benchmarkRoot, 'node_modules', 'resultar-check', 'dist', 'deno', 'plugin.js'),
    'resultar-check Deno plugin',
  )

  writeJson(join(projectDir, 'deno.json'), {
    lint: {
      plugins: [pathToFileURL(pluginPath).href],
      rules: { include: Object.keys(astRuleSeverities) },
    },
  })
}

const writeBenchConfigs = (projectDir: string): void => {
  writeOxlintConfig(projectDir)
  writeEslintConfig(projectDir)
  writeDenoConfig(projectDir)
}

const countLines = (text: string): number =>
  (text.match(/\n/g)?.length ?? 0) + (text.endsWith('\n') ? 0 : 1)

const createFixtureFile = (index: number): string => `import {
  createTaggedError,
  ok,
  safeTry,
  tryResult,
  type StrictResult,
} from "resultar";

interface Payload${index} {
  readonly value: number;
}

class FixtureError${index} extends createTaggedError({
  name: "FixtureError${index}",
  message: "Fixture ${index} failed",
}) {}

const parsePayload${index} = (input: string): StrictResult<Payload${index}, FixtureError${index}> =>
  tryResult(
    () => JSON.parse(input) as Payload${index},
    (cause) => new FixtureError${index}({ cause }),
  );

export const compute${index} = (input: string): StrictResult<number, FixtureError${index}> =>
  safeTry(function* () {
    const payload = yield* parsePayload${index}(input);

    return ok(payload.value + ${index});
  });

void compute${index}('{"value":${index + 1}}');
`

const createGeneratedSubject = (fileCount: number): BenchSubject => {
  mkdirSync(tempRoot, { recursive: true })

  const rootDir = mkdtempSync(join(tempRoot, 'resultar-check-cli-bench-'))
  const projectDir = join(rootDir, 'project')
  const srcDir = join(projectDir, 'src')

  mkdirSync(srcDir, { recursive: true })

  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(srcDir, `case-${index}.ts`), createFixtureFile(index))
  }

  writeJson(join(projectDir, 'tsconfig.json'), {
    compilerOptions: {
      declaration: false,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      module: 'NodeNext',
      moduleDetection: 'force',
      moduleResolution: 'NodeNext',
      noEmit: true,
      plugins: [sharedResultarCheckPluginOptions],
      skipLibCheck: true,
      strict: true,
      target: 'ESNext',
      types: [],
    },
    include: ['src/**/*.ts'],
  })

  writeBenchConfigs(projectDir)

  return {
    oxlintTarget: srcDir,
    projectDir,
    resultarCheckCwd: projectDir,
    rootDir,
    sourceLabel: `generated clean fixture (${fileCount} files)`,
  }
}

const createTargetSubject = (targetPath: string, copyCount: number): BenchSubject => {
  const absoluteTarget = requireExistingPath(resolve(targetPath), 'benchmark target')
  const sourceTsconfig = findNearestTsconfig(dirname(absoluteTarget))
  const sourceProjectDir = dirname(sourceTsconfig)

  mkdirSync(tempRoot, { recursive: true })

  const rootDir = mkdtempSync(join(tempRoot, 'resultar-check-cli-target-bench-'))
  const projectDir = join(rootDir, 'project')

  mkdirSync(projectDir, { recursive: true })

  if (copyCount > 1) {
    const srcDir = join(projectDir, 'src')
    const sourceText = readFileSync(absoluteTarget, 'utf8')
    const files: string[] = []

    mkdirSync(srcDir, { recursive: true })

    for (let index = 0; index < copyCount; index += 1) {
      const copyPath = join(srcDir, `target-copy-${String(index + 1).padStart(2, '0')}.ts`)

      writeFileSync(copyPath, sourceText)
      files.push(copyPath)
    }

    writeJson(join(projectDir, 'tsconfig.json'), {
      compilerOptions: {
        plugins: [sharedResultarCheckPluginOptions],
        types: [],
      },
      extends: sourceTsconfig,
      files,
      include: [],
    })
    writeBenchConfigs(projectDir)

    return {
      oxlintTarget: srcDir,
      projectDir,
      resultarCheckCwd: projectDir,
      rootDir,
      sourceLabel: `${absoluteTarget} copied into ${copyCount} files (${countLines(sourceText) * copyCount} total lines)`,
    }
  }

  writeJson(join(projectDir, 'tsconfig.json'), {
    compilerOptions: {
      plugins: [sharedResultarCheckPluginOptions],
      types: [],
    },
    extends: sourceTsconfig,
    files: [absoluteTarget],
    include: [],
  })
  writeBenchConfigs(projectDir)

  return {
    oxlintTarget: absoluteTarget,
    projectDir,
    resultarCheckCwd: sourceProjectDir,
    rootDir,
    sourceLabel: absoluteTarget,
  }
}

const runCommand = (command: Command): CommandRun => {
  const startedAt = performance.now()
  const result = spawnSync(command.bin, command.args, {
    cwd: command.cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const elapsed = performance.now() - startedAt

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 0 && command.allowNonZero !== true) {
    throw new Error(
      [
        `${command.label} failed with exit code ${result.status ?? 1}`,
        `command: ${command.bin} ${command.args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  return { elapsed, output: `${result.stdout}${result.stderr}`, status: result.status ?? 1 }
}

const summarize = (samples: readonly number[]): Summary => {
  const sorted = samples.toSorted((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
      : sorted[midpoint] ?? 0
  const sum = samples.reduce((total, sample) => total + sample, 0)

  return {
    max: sorted.at(-1) ?? 0,
    mean: sum / samples.length,
    median,
    min: sorted[0] ?? 0,
    samples,
  }
}

const formatMs = (value: number): string => value.toFixed(1).padStart(9)
const formatRatio = (value: number): string => `${value.toFixed(2)}x`.padStart(7)
const countMatches = (output: string, pattern: RegExp): number => output.match(pattern)?.length ?? 0
const countResultarDiagnostics = (output: string): number =>
  astRuleNames.reduce(
    (total, ruleName) =>
      total +
      countMatches(output, new RegExp(`\\bresultar/${ruleName}\\b`, 'g')) +
      countMatches(output, new RegExp(`\\bresultar\\(${ruleName}\\)`, 'g')),
    0,
  )

const readDenoVersion = (): string => {
  const result = spawnSync(denoBin, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const versionLine = result.stdout.split('\n')[0] ?? ''

  return versionLine.replace(/^deno\s+/, '') || 'unknown'
}

const runBenchmark = (): void => {
  const fileCount = parsePositiveInteger('RESULTAR_CHECK_CLI_BENCH_FILES', 120)
  const runs = parsePositiveInteger('RESULTAR_CHECK_CLI_BENCH_RUNS', 7)
  const warmups = parsePositiveInteger('RESULTAR_CHECK_CLI_BENCH_WARMUPS', 2)
  const targetCopies = parsePositiveInteger('RESULTAR_CHECK_CLI_BENCH_TARGET_COPIES', 1)
  const keepFixture = process.env.RESULTAR_CHECK_CLI_BENCH_KEEP === '1'
  const targetPath = process.env.RESULTAR_CHECK_CLI_BENCH_TARGET
  const subject =
    targetPath === undefined || targetPath === ''
      ? createGeneratedSubject(fileCount)
      : createTargetSubject(targetPath, targetCopies)
  const allowNonZero = targetPath !== undefined && targetPath !== ''

  try {
    const commands: readonly Command[] = [
      {
        allowNonZero,
        args: [
          '--config',
          join(subject.projectDir, 'oxlint.config.json'),
          subject.oxlintTarget,
        ],
        bin: requireExistingPath(join(nodeModulesBin, `oxlint${executableSuffix}`), 'oxlint CLI'),
        cwd: benchmarkRoot,
        label: 'oxlint + resultar-check',
      },
      {
        allowNonZero,
        args: [
          '--config',
          join(subject.projectDir, 'eslint.config.mjs'),
          '--no-ignore',
          subject.oxlintTarget,
        ],
        bin: requireExistingPath(join(nodeModulesBin, `eslint${executableSuffix}`), 'ESLint CLI'),
        cwd: subject.resultarCheckCwd,
        label: 'eslint + resultar-check',
      },
      {
        allowNonZero,
        args: [
          'lint',
          '--config',
          join(subject.projectDir, 'deno.json'),
          '--json',
          subject.oxlintTarget,
        ],
        bin: denoBin,
        cwd: subject.resultarCheckCwd,
        label: 'deno lint + resultar-check',
      },
      {
        allowNonZero,
        args: ['--project', join(subject.projectDir, 'tsconfig.json')],
        bin: requireExistingPath(
          join(nodeModulesBin, `resultar-check${executableSuffix}`),
          'resultar-check CLI',
        ),
        cwd: subject.resultarCheckCwd,
        label: 'resultar-check cli',
      },
    ]
    const samplesByLabel = new Map(commands.map((command) => [command.label, [] as number[]]))
    const diagnosticCountsByLabel = new Map<string, number>()

    for (let index = 0; index < warmups; index += 1) {
      for (const command of commands) {
        runCommand(command)
      }
    }

    for (let index = 0; index < runs; index += 1) {
      const orderedCommands = index % 2 === 0 ? commands : commands.toReversed()

      for (const command of orderedCommands) {
        const commandRun = runCommand(command)

        samplesByLabel.get(command.label)?.push(commandRun.elapsed)

        if (!diagnosticCountsByLabel.has(command.label)) {
          diagnosticCountsByLabel.set(command.label, countResultarDiagnostics(commandRun.output))
        }
      }
    }

    const summaries = commands.map((command) => ({
      command,
      diagnosticCount: diagnosticCountsByLabel.get(command.label) ?? 0,
      summary: summarize(samplesByLabel.get(command.label) ?? []),
    }))
    const baseline = summaries.find(({ command }) => command.label === 'resultar-check cli')
      ?.summary.median
    const diagnosticCounts = new Set(summaries.map(({ diagnosticCount }) => diagnosticCount))
    const labelColumnWidth = Math.max(
      'tool'.length,
      ...summaries.map(({ command }) => command.label.length),
    )

    if (diagnosticCounts.size > 1) {
      throw new Error(
        [
          'Resultar diagnostic count mismatch:',
          ...summaries.map(({ command, diagnosticCount }) => `${command.label}: ${diagnosticCount}`),
        ].join('\n'),
      )
    }

    process.stdout.write(
      [
        'Resultar check CLI benchmark',
        `target: ${subject.sourceLabel}`,
        allowNonZero ? 'non-zero CLI exits: allowed for target timing' : undefined,
        `warmups: ${warmups}`,
        `measured runs: ${runs}`,
        `oxlint: ${readPackageVersion('oxlint')}`,
        `eslint: ${readPackageVersion('eslint')}`,
        `@babel/eslint-parser: ${readPackageVersion('@babel/eslint-parser')}`,
        `deno: ${readDenoVersion()}`,
        `resultar-check: ${readPackageVersion('resultar-check')}`,
        '',
        `${'tool'.padEnd(
          labelColumnWidth,
        )} errors   median ms   mean ms    min ms    max ms   vs resultar-check`,
        ...summaries.map(({ command, diagnosticCount, summary }) => {
          const ratio = baseline === undefined || baseline === 0 ? 0 : summary.median / baseline

          return `${command.label.padEnd(labelColumnWidth)} ${String(
            diagnosticCount,
          ).padStart(6)} ${formatMs(summary.median)} ${formatMs(
            summary.mean,
          )} ${formatMs(summary.min)} ${formatMs(summary.max)} ${formatRatio(ratio)}`
        }),
        '',
        keepFixture ? `fixture kept at: ${subject.rootDir}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    )
    process.stdout.write('\n')
  } finally {
    if (!keepFixture) {
      rmSync(subject.rootDir, { force: true, recursive: true })
    }
  }
}

runBenchmark()
