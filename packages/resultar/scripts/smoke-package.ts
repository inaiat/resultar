import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type PackFile = Readonly<{ path: string }>
type PackManifest = Readonly<{ files: readonly PackFile[] }>

const rootDir = fileURLToPath(new URL('..', import.meta.url))

const requiredFiles = [
  'LICENSE',
  'README.md',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/llms.txt',
  'dist/agent/SKILL.md',
  'dist/agent/versions.json',
  'dist/agent/references/api.md',
  'dist/agent/references/services.md',
  'dist/agent/examples/workflow.mjs',
  'package.json',
] as const

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const isPackFile = (value: unknown): value is PackFile =>
  isRecord(value) && typeof value['path'] === 'string'

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) && Array.isArray(value['files']) && value['files'].every(isPackFile)

const parseJsonArrayFromNpmOutput = (packOutput: string): unknown => {
  const trimmed = packOutput.trim()
  let index = trimmed.indexOf('[')

  while (index >= 0) {
    try {
      return JSON.parse(trimmed.slice(index)) as unknown
    } catch {
      index = trimmed.indexOf('[', index + 1)
    }
  }

  throw new TypeError('npm pack did not include JSON output')
}

const parsePackedFiles = (packOutput: string): readonly string[] => {
  const parsed = parseJsonArrayFromNpmOutput(packOutput)

  if (!Array.isArray(parsed) || !isPackManifest(parsed[0])) {
    throw new TypeError('npm pack returned an unexpected manifest shape')
  }

  return parsed[0].files.map((file) => file.path)
}

for (const file of requiredFiles) {
  if (!existsSync(path.join(rootDir, file))) {
    throw new Error(`Missing package smoke file: ${file}`)
  }
}

const entrypoint = (await import(
  pathToFileURL(path.join(rootDir, 'dist/index.js')).href
)) as Record<string, unknown>
const expectedExports = [
  'AbortError',
  'DisposableResult',
  'DisposableResultAsync',
  'MissingServiceError',
  'Result',
  'ResultAsync',
  'ResultTask',
  'ResultTaskCauseError',
  'ResultTaskTypeId',
  'ResultTaskYieldTypeId',
  'ServiceTagTypeId',
  'createTaggedError',
  'default',
  'err',
  'errAsync',
  'findCause',
  'fromCallback',
  'fromPromise',
  'fromSafePromise',
  'fromThrowable',
  'fromThrowableAsync',
  'isAbortError',
  'isError',
  'isRedacted',
  'isResultTask',
  'isServiceTag',
  'matchError',
  'matchErrorPartial',
  'ok',
  'okAsync',
  'redact',
  'revealRedacted',
  'runPromise',
  'runSync',
  'safeTry',
  'serviceTag',
  'taggedEnum',
  'try',
  'tryAsync',
  'tryCatch',
  'tryCatchAsync',
  'tryResult',
  'tryResultAsync',
  'unit',
  'unitAsync',
] as const
const actualExports = Object.keys(entrypoint).toSorted()

if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(
    `Unexpected public exports:\nactual: ${actualExports.join(', ')}\nexpected: ${expectedExports.join(', ')}`,
  )
}

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: rootDir,
  encoding: 'utf8',
})
const packedFiles = parsePackedFiles(packOutput).toSorted()

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed package is missing required file: ${file}`)
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|package\.json|dist\/[^/]+\.(?:js|d\.ts|js\.map|txt)|dist\/agent\/(?:SKILL\.md|versions\.json|agents\/openai\.yaml|references\/[a-z-]+\.md|examples\/workflow\.(?:mts|mjs)))$/u
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file))

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed package contains unexpected files:\n${unexpectedFiles.join('\n')}`)
}

process.stdout.write(`Package smoke passed with ${packedFiles.length} packed files.\n`)

const declarations = readFileSync(path.join(rootDir, 'dist/index.d.ts'), 'utf8')
if (declarations.includes('toTapContinuationStep')) {
  throw new Error('Internal continuation helper leaked into public declarations')
}

execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import {ResultTask} from './dist/index.js';
import {account, welcome} from './dist/agent/examples/workflow.mjs';
assert.equal(account('invalid').isErr(), true);
const result = await ResultTask.runResult(welcome(' ADA@EXAMPLE.COM '), {services: {greeting: 'Hello'}});
assert.equal(result.isOk(), true);
assert.equal(result.value, 'Hello, ada@example.com');`,
  ],
  { cwd: rootDir, stdio: 'inherit' },
)
