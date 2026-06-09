import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const workspaceDir = fileURLToPath(new URL('../../..', import.meta.url))
const exampleDir = fileURLToPath(new URL('..', import.meta.url))

interface CommandResult {
  readonly output: string
  readonly status: number
}

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly expectFailure?: boolean },
): CommandResult => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout}${result.stderr}`
  const status = result.status ?? 1

  if (result.error !== undefined) {
    throw result.error
  }

  if (options.expectFailure !== true && status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${status}\n${output}`)
  }

  if (options.expectFailure === true && status === 0) {
    throw new Error(`${command} ${args.join(' ')} was expected to fail but passed\n${output}`)
  }

  return { output, status }
}

const pnpm = (
  args: readonly string[],
  options: { readonly cwd: string; readonly expectFailure?: boolean },
) => run('pnpm', args, options)

const assertIncludes = (output: string, expected: string, message: string): void => {
  if (!output.includes(expected)) {
    throw new Error(`${message}\n${output}`)
  }
}

pnpm(['--filter', 'resultar', 'build'], { cwd: workspaceDir })
pnpm(['--filter', 'resultar-ls', 'build'], { cwd: workspaceDir })

const check = pnpm(['check'], { cwd: exampleDir, expectFailure: true })

assertIncludes(
  check.output,
  'resultar(no-discard)',
  'Expected Vite+ Oxlint output to include the Resultar no-discard rule id',
)
assertIncludes(
  check.output,
  'Ignored Result',
  'Expected Vite+ Oxlint output to report the ignored Result value',
)
assertIncludes(
  check.output,
  'Ignored ResultAsync',
  'Expected Vite+ Oxlint output to report the ignored ResultAsync value',
)

process.stdout.write('Resultar Vite+ example smoke passed.\n')
