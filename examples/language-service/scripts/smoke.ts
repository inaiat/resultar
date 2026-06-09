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

const pnpm = (args: readonly string[], options: { readonly cwd: string; readonly expectFailure?: boolean }) =>
  run('pnpm', args, options)

const runTsc = (expectFailure = false): CommandResult =>
  pnpm(['exec', 'tsc', '-p', 'tsconfig.json', '--pretty', 'false'], {
    cwd: exampleDir,
    expectFailure,
  })

const runResultarLint = (expectFailure = false): CommandResult =>
  pnpm(['run', 'lint:resultar'], {
    cwd: exampleDir,
    expectFailure,
  })

const assertIncludes = (output: string, expected: string, message: string): void => {
  if (!output.includes(expected)) {
    throw new Error(`${message}\n${output}`)
  }
}

pnpm(['--filter', 'resultar', 'build'], { cwd: workspaceDir })
pnpm(['--filter', 'resultar-ls', 'build'], { cwd: workspaceDir })

const tscVersion = pnpm(['exec', 'tsc', '--version'], { cwd: exampleDir })

if (!tscVersion.output.trim().startsWith('Version 6.')) {
  throw new Error(`Expected TypeScript 6.x in the language-service example\n${tscVersion.output}`)
}

try {
  pnpm(['exec', 'resultar-ls', 'unpatch'], {
    cwd: exampleDir,
  })

  runTsc()

  const lint = runResultarLint(true)
  assertIncludes(
    lint.output,
    'no-discard-result',
    'Expected lint-like no-discard command to report discarded Resultar values',
  )

  pnpm(['exec', 'resultar-ls', 'patch'], {
    cwd: exampleDir,
  })

  const secondPatch = pnpm(
    ['exec', 'resultar-ls', 'patch'],
    { cwd: exampleDir },
  )

  if (!secondPatch.output.includes('already patched')) {
    throw new Error(`Expected second patch to be a no-op\n${secondPatch.output}`)
  }

  const patchedTsc = runTsc(true)
  assertIncludes(
    patchedTsc.output,
    '[resultar/noDiscard]',
    'Patched TypeScript 6 tsc did not emit Resultar no-discard diagnostics',
  )
} finally {
  pnpm(['exec', 'resultar-ls', 'unpatch'], {
    cwd: exampleDir,
  })
}

runTsc()

process.stdout.write('Resultar language-service example smoke passed.\n')
