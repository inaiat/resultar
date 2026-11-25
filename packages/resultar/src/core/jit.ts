const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

const RESERVED_WORDS = new Set([
  '__proto__',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

let jitCapability: boolean | undefined = undefined

const isEnvJitDisabled = (): boolean => {
  try {
    const env = (
      globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }
    ).process?.env
    const flag = env?.['RESULTAR_JIT']
    return flag === '0' || flag === 'false'
  } catch {
    return false
  }
}

/** Lazily probes `new Function` availability without top-level side effects. */
export const canUseJit = (): boolean => {
  if (isEnvJitDisabled()) {
    return false
  }
  if (jitCapability !== undefined) {
    return jitCapability
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const probe = new Function('return 1') as () => number
    jitCapability = probe() === 1
  } catch {
    jitCapability = false
  }
  return jitCapability
}

/** Escapes a JS string literal safely for generated code, including line/paragraph separators. */
export const serializeStringLiteral = (value: string): string =>
  JSON.stringify(value)
    .replaceAll('\u2028', String.raw`\u2028`)
    .replaceAll('\u2029', String.raw`\u2029`)

/** Formats safe property access on a generated target expression. */
export const formatPropertyAccess = (target: string, key: string): string =>
  SAFE_IDENTIFIER.test(key) && !RESERVED_WORDS.has(key)
    ? `${target}.${key}`
    : `${target}[${serializeStringLiteral(key)}]`

/** Compiles a bound function via `new Function`, returning `undefined` on CSP or syntax failure. */
export const compileJitFunction = <Fn extends (...args: never[]) => unknown>(
  paramNames: readonly string[],
  body: string,
  paramValues: readonly unknown[],
): Fn | undefined => {
  if (!canUseJit()) {
    return undefined
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...paramNames, `'use strict';\n${body}`) as (
      ...args: readonly unknown[]
    ) => Fn
    return factory(...paramValues)
  } catch {
    return undefined
  }
}

export const MAX_JIT_CASES = 128
export const MAX_JIT_STEPS = 256
