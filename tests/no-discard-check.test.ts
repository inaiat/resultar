import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deepEqual, equal, ok as isTrue } from 'node:assert'

import { afterEach, describe, it } from 'vite-plus/test'

import { findDiscardedResults } from '../src/no-discard.js'

const tempDirs: string[] = []

const createFixtureProject = async (source: string): Promise<string> => {
  const rootDir = await mkdtemp(join(tmpdir(), 'resultar-no-discard-'))
  tempDirs.push(rootDir)

  await writeFile(
    join(rootDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        target: 'ESNext',
      },
      include: ['fixture.ts'],
    }),
  )
  await writeFile(join(rootDir, 'fixture.ts'), source)

  return rootDir
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => await rm(dir, { force: true, recursive: true })),
  )
})

describe('no-discard Result check', () => {
  it('flags ignored Result and ResultAsync expressions', async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      class ResultAsync<T, E> {
        constructor(readonly result: Result<T, E>) {}
      }
      declare function saveUser(input: string): Result<string, Error>
      declare function saveUserAsync(input: string): ResultAsync<string, Error>

      saveUser('a')
      saveUserAsync('b')
    `)

    const result = findDiscardedResults({ rootDir })

    isTrue(result.isOk())
    const findings = result._unsafeUnwrap()
    deepEqual(
      findings.map((finding) => finding.line),
      [9, 10],
    )
    equal(findings[0]?.type, 'Result<string, Error>')
    equal(findings[1]?.type, 'ResultAsync<string, Error>')
  })

  it('allows explicit void discards and handled results', async () => {
    const rootDir = await createFixtureProject(`
      type Result<T, E> = { readonly error?: E; readonly value?: T }
      declare function saveUser(input: string): Result<string, Error>

      const result = saveUser('a')
      void saveUser('b')
      result.value
    `)

    const result = findDiscardedResults({ rootDir })

    isTrue(result.isOk())
    deepEqual(result._unsafeUnwrap(), [])
  })
})
