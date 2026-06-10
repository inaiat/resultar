import { spawnSync } from 'node:child_process'

interface CommandResult {
  readonly output: string
  readonly status: number
}

const run = (args: readonly string[], expectFailure = false): CommandResult => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout}${result.stderr}`
  const status = result.status ?? 1

  if (result.error !== undefined) {
    throw result.error
  }

  if (!expectFailure && status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed with exit ${status}\n${output}`)
  }

  if (expectFailure && status === 0) {
    throw new Error(`pnpm ${args.join(' ')} was expected to fail but passed\n${output}`)
  }

  return { output, status }
}

run(['run', 'prepare'])

const version = run(['exec', 'tsgo', '--version'])

if (!version.output.includes('7.0.0')) {
  throw new Error(`Expected tsgo to use the TypeScript 7 native preview\n${version.output}`)
}

const lint = run(['run', 'lint:resultar'], true)

if (!lint.output.includes('no-discard-result')) {
  throw new Error(`Expected pnpm lint:resultar to fail with Resultar no-discard output\n${lint.output}`)
}

if (!lint.output.includes('assigned to `unhandled`')) {
  throw new Error(`Expected pnpm lint:resultar to fail with Resultar must-use output\n${lint.output}`)
}

process.stdout.write('Resultar tsgo example smoke passed.\n')
