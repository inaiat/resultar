import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type PackFile = Readonly<{ path: string }>
type PackManifest = Readonly<{ files: readonly PackFile[] }>

const rootDir = fileURLToPath(new URL('..', import.meta.url))

const requiredFiles = [
  'LICENSE',
  'README.md',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/no-discard.d.ts',
  'dist/no-discard.js',
  'package.json',
] as const

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const isPackFile = (value: unknown): value is PackFile =>
  isRecord(value) && typeof value['path'] === 'string'

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) && Array.isArray(value['files']) && value['files'].every(isPackFile)

const parsePackedFiles = (packOutput: string): readonly string[] => {
  const parsed = JSON.parse(packOutput) as unknown

  if (!Array.isArray(parsed) || !isPackManifest(parsed[0])) {
    throw new TypeError('npm pack returned an unexpected manifest shape')
  }

  return parsed[0].files.map((file) => file.path)
}

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing package smoke file: ${file}`)
  }
}

const entrypoint = (await import(pathToFileURL(join(rootDir, 'dist/index.js')).href)) as Record<
  string,
  unknown
>
const expectedExports = [
  'DisposableResult',
  'DisposableResultAsync',
  'Result',
  'ResultAsync',
  'createTaggedError',
  'err',
  'errAsync',
  'findCause',
  'fromPromise',
  'fromSafePromise',
  'fromThrowable',
  'fromThrowableAsync',
  'isError',
  'matchError',
  'matchErrorPartial',
  'ok',
  'okAsync',
  'safeTry',
  'tryCatch',
  'tryCatchAsync',
  'unit',
  'unitAsync',
] as const
const actualExports = Object.keys(entrypoint).toSorted()

if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(
    `Unexpected public exports:\nactual: ${actualExports.join(', ')}\nexpected: ${expectedExports.join(', ')}`,
  )
}

const help = execFileSync(process.execPath, [join(rootDir, 'dist/no-discard.js'), '--help'], {
  cwd: rootDir,
  encoding: 'utf8',
})

if (!help.includes('Usage: resultar-no-discard')) {
  throw new Error('No-discard binary help output is missing expected usage text')
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

const allowedPackedFile = /^(?:LICENSE|README\.md|package\.json|dist\/[^/]+\.(?:js|d\.ts|js\.map))$/
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file))

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed package contains unexpected files:\n${unexpectedFiles.join('\n')}`)
}

process.stdout.write(`Package smoke passed with ${packedFiles.length} packed files.\n`)
