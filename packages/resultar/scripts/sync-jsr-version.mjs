import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {string} contents
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
const parseJsonRecord = (contents, filePath) => {
  const parsed = /** @type {unknown} */ (JSON.parse(contents))

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`Expected ${filePath} to contain a JSON object`)
  }

  return /** @type {Record<string, unknown>} */ (parsed)
}

const packageDir = path.dirname(import.meta.dirname)
const packageJsonPath = path.join(packageDir, 'package.json')
const jsrJsonPath = path.join(packageDir, 'jsr.json')

const packageJson = parseJsonRecord(await readFile(packageJsonPath, 'utf8'), packageJsonPath)
const jsrJson = parseJsonRecord(await readFile(jsrJsonPath, 'utf8'), jsrJsonPath)
const packageVersion = packageJson.version

if (typeof packageVersion !== 'string') {
  throw new TypeError(`Expected ${packageJsonPath} to contain a string version`)
}

jsrJson.version = packageVersion

await writeFile(jsrJsonPath, `${JSON.stringify(jsrJson, null, 2)}\n`)
