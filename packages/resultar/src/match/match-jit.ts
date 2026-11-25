import {
  canUseJit,
  compileJitFunction,
  formatPropertyAccess,
  MAX_JIT_CASES,
  serializeStringLiteral,
} from '../core/jit.js'
import { err, ok } from '../result/result.js'

export type MatchHandler = (value: never, ...args: readonly unknown[]) => unknown
export type MatchMode = 'value' | 'type' | 'fn' | 'context'
export type MatchOutcomeKind = 'direct' | 'result' | 'option'
export interface MatchBuiltinEmitter {
  readonly emit: (expr: string) => string
  readonly reads: 0 | 1 | 'many'
}

export type MatchPatternIr =
  | { readonly kind: 'predicate'; readonly fn: (value: unknown) => boolean }
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'array'; readonly elements: readonly MatchPatternIr[] }
  | {
      readonly kind: 'object'
      readonly entries: readonly (readonly [PropertyKey, MatchPatternIr])[]
    }

export type MatchCaseIr =
  | { readonly kind: 'pattern'; readonly pattern: MatchPatternIr; readonly handler: MatchHandler }
  | {
      readonly kind: 'or'
      readonly patterns: readonly MatchPatternIr[]
      readonly handler: MatchHandler
    }
  | {
      readonly kind: 'and'
      readonly patterns: readonly MatchPatternIr[]
      readonly handler: MatchHandler
    }
  | { readonly kind: 'not'; readonly pattern: MatchPatternIr; readonly handler: MatchHandler }
  | {
      readonly kind: 'tagSet'
      readonly key: PropertyKey
      readonly tags: readonly unknown[]
      readonly handler: MatchHandler
    }
  | {
      readonly kind: 'tagPrefix'
      readonly key: PropertyKey
      readonly prefix: string
      readonly handler: MatchHandler
    }
  | {
      readonly kind: 'tagTable'
      readonly key: PropertyKey
      readonly entries: readonly (readonly [PropertyKey, MatchHandler])[]
    }

const isObjectRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const readProperty = (value: unknown, key: PropertyKey): unknown =>
  (typeof value === 'object' || typeof value === 'function') && value !== null
    ? (value as Record<PropertyKey, unknown>)[key]
    : undefined

/** Parses and validates a pattern once into a snapshot IR. */
export const parseMatchPatternIr = (pattern: unknown): MatchPatternIr => {
  if (typeof pattern === 'function') {
    return { kind: 'predicate', fn: pattern as (value: unknown) => boolean }
  }
  if (Array.isArray(pattern)) {
    return { kind: 'array', elements: (pattern as readonly unknown[]).map(parseMatchPatternIr) }
  }
  if (isObjectRecord(pattern)) {
    const prototype: unknown = Object.getPrototypeOf(pattern)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Match object patterns must be plain objects')
    }
    const entries = Reflect.ownKeys(pattern).map(
      (key) => [key, parseMatchPatternIr(pattern[key])] as const,
    )
    return { kind: 'object', entries }
  }
  return { kind: 'literal', value: pattern }
}

/** Parses and validates a handler table once into a snapshot IR. */
export const parseTableCaseIr = (key: PropertyKey, handlers: object): readonly MatchCaseIr[] => {
  const entries: (readonly [PropertyKey, MatchHandler])[] = []
  for (const tag of Reflect.ownKeys(handlers)) {
    const handler = (handlers as Record<PropertyKey, unknown>)[tag]
    if (handler !== undefined) {
      if (typeof handler !== 'function') throw new TypeError('Match handlers must be functions')
      entries.push([tag, handler as MatchHandler])
    }
  }
  return entries.length === 0 ? [] : [{ kind: 'tagTable', key, entries }]
}

/** Evaluates a parsed pattern IR without allocating closures on eager single-shot calls. */
// Keep each pattern check here so the eager path can short-circuit without allocating callbacks.
// fallow-ignore-next-line complexity
const evaluatePatternIr = (pattern: MatchPatternIr, value: unknown): boolean => {
  switch (pattern.kind) {
    case 'predicate': {
      return pattern.fn(value)
    }
    case 'literal': {
      return value === pattern.value
    }
    case 'array': {
      if (!Array.isArray(value) || value.length < pattern.elements.length) return false
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index]
        if (element !== undefined && !evaluatePatternIr(element, value[index])) {
          return false
        }
      }
      return true
    }
    case 'object': {
      if (!isObjectRecord(value)) return false
      for (const [key, sub] of pattern.entries) {
        if (!(key in value) || !evaluatePatternIr(sub, value[key])) {
          return false
        }
      }
      return true
    }
    default: {
      return false
    }
  }
}

/** Evaluates a single case IR against `input`, returning the matched handler or `undefined`. */
// Keep case dispatch in one switch shared by eager matching and the CSP-safe fallback.
// fallow-ignore-next-line complexity
export const resolveCaseIr = (item: MatchCaseIr, input: unknown): MatchHandler | undefined => {
  switch (item.kind) {
    case 'pattern': {
      return evaluatePatternIr(item.pattern, input) ? item.handler : undefined
    }
    case 'or': {
      for (const pattern of item.patterns) {
        if (evaluatePatternIr(pattern, input)) return item.handler
      }
      return undefined
    }
    case 'and': {
      for (const pattern of item.patterns) {
        if (!evaluatePatternIr(pattern, input)) return undefined
      }
      return item.handler
    }
    case 'not': {
      return evaluatePatternIr(item.pattern, input) ? undefined : item.handler
    }
    case 'tagSet': {
      const actual = readProperty(input, item.key)
      return item.tags.includes(actual) ? item.handler : undefined
    }
    case 'tagPrefix': {
      const actual = readProperty(input, item.key)
      return typeof actual === 'string' && actual.startsWith(item.prefix) ? item.handler : undefined
    }
    case 'tagTable': {
      const actual = readProperty(input, item.key)
      const lookup = typeof actual === 'number' ? String(actual) : (actual as PropertyKey)
      for (const [tag, handler] of item.entries) {
        if (tag === lookup) return handler
      }
      return undefined
    }
    default: {
      return undefined
    }
  }
}

type FallbackStep = (input: unknown) => MatchHandler | undefined

const compileFallbackStep = (item: MatchCaseIr): FallbackStep => {
  if (item.kind === 'tagTable' && item.entries.length > 4) {
    const table = new Map<PropertyKey, MatchHandler>(item.entries)
    const key = item.key
    return (input) => {
      const actual = readProperty(input, key)
      return table.get(typeof actual === 'number' ? String(actual) : (actual as PropertyKey))
    }
  }
  if (item.kind === 'tagSet' && item.tags.length > 4) {
    const selected = new Set<unknown>(item.tags)
    const key = item.key
    const handler = item.handler
    return (input) => (selected.has(readProperty(input, key)) ? handler : undefined)
  }
  return (input) => resolveCaseIr(item, input)
}

const wrapOutcome = (outcome: MatchOutcomeKind, value: unknown): unknown => {
  if (outcome === 'direct') return value
  if (outcome === 'result') return ok(value)
  return { _tag: 'Some', value }
}

interface FallbackConfig {
  readonly kind: Exclude<MatchMode, 'value'>
  readonly select: (...args: readonly unknown[]) => unknown
  readonly cases: readonly MatchCaseIr[]
  readonly outcome: MatchOutcomeKind
  readonly fallback: MatchHandler
}

const resolveFallbackOutput = (
  outcome: MatchOutcomeKind,
  fallback: MatchHandler,
  input: unknown,
): unknown => {
  if (outcome === 'result') return err(input)
  if (outcome === 'option') return { _tag: 'None' }
  return fallback(input as never)
}

const createFallbackMatcher = (
  config: FallbackConfig,
): ((...args: readonly unknown[]) => unknown) => {
  const { kind, select, cases, outcome, fallback } = config
  const steps = cases.map(compileFallbackStep)

  if (kind === 'type') {
    return (input: unknown) => {
      for (const step of steps) {
        const handler = step(input)
        if (handler !== undefined) return wrapOutcome(outcome, handler(input as never))
      }
      return resolveFallbackOutput(outcome, fallback, input)
    }
  }

  return (...args: readonly unknown[]) => {
    const input = kind === 'context' ? args[0] : select(...args)
    const handlerArgs = kind === 'context' ? args.slice(1) : args
    for (const step of steps) {
      const handler = step(input)
      if (handler !== undefined)
        return wrapOutcome(outcome, handler(input as never, ...handlerArgs))
    }
    if (outcome === 'result') return err(input)
    if (outcome === 'option') return { _tag: 'None' }
    return handlerArgs.length === 0
      ? fallback(input as never)
      : fallback(input as never, ...handlerArgs)
  }
}

class MatchCodeBuilder {
  public readonly paramNames: string[] = []
  public readonly paramValues: unknown[] = []
  public readonly temps: string[] = []
  private readonly builtins: ReadonlyMap<unknown, MatchBuiltinEmitter>

  public constructor(builtins: ReadonlyMap<unknown, MatchBuiltinEmitter>) {
    this.builtins = builtins
  }

  public bind(value: unknown): string {
    const name = `p${String(this.paramNames.length)}`
    this.paramNames.push(name)
    this.paramValues.push(value)
    return name
  }

  public temp(): string {
    const name = `t${String(this.temps.length)}`
    this.temps.push(name)
    return name
  }

  public emitKeyExpr(key: PropertyKey): string {
    if (typeof key === 'string') return serializeStringLiteral(key)
    if (typeof key === 'number') return String(key)
    return this.bind(key)
  }

  public emitLiteralCheck(expr: string, value: unknown, isPureVar = true): string {
    if (typeof value === 'string') return `${expr} === ${serializeStringLiteral(value)}`
    if (typeof value === 'boolean') return `${expr} === ${value ? 'true' : 'false'}`
    if (value === null) return `${expr} === null`
    if (value === undefined) return `${expr} === undefined`
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return isPureVar ? 'false' : `((${expr}), false)`
      return `${expr} === ${String(value)}`
    }
    return `${expr} === ${this.bind(value)}`
  }

  public emitPropertyRead(target: string, key: PropertyKey): string {
    if (typeof key === 'string') return formatPropertyAccess(target, key)
    if (typeof key === 'number') return `${target}[${String(key)}]`
    return `${target}[${this.bind(key)}]`
  }

  // Each recursive branch controls when a property or array element is read.
  // fallow-ignore-next-line complexity
  public emitPattern(pattern: MatchPatternIr, expr: string, isPureVar = false): string {
    switch (pattern.kind) {
      case 'predicate': {
        const builtin = this.builtins.get(pattern.fn)
        if (builtin !== undefined) {
          if (isPureVar || builtin.reads === 1) return builtin.emit(expr)
          if (builtin.reads === 0) return `((${expr}), ${builtin.emit(expr)})`
          const ref = this.temp()
          return `((${ref} = ${expr}), ${builtin.emit(ref)})`
        }
        return `${this.bind(pattern.fn)}(${expr})`
      }
      case 'literal': {
        return this.emitLiteralCheck(expr, pattern.value, isPureVar)
      }
      case 'array': {
        const ref = isPureVar ? expr : this.temp()
        const prefix = isPureVar
          ? `Array.isArray(${ref}) && ${ref}.length >= ${String(pattern.elements.length)}`
          : `((${ref} = ${expr}), Array.isArray(${ref}) && ${ref}.length >= ${String(pattern.elements.length)})`
        if (pattern.elements.length === 0) return prefix
        const checks = pattern.elements.map((el, index) =>
          this.emitPattern(el, `${ref}[${String(index)}]`, false),
        )
        return `(${[prefix, ...checks.filter(Boolean)].join(' && ')})`
      }
      case 'object': {
        const ref = isPureVar ? expr : this.temp()
        const head = isPureVar
          ? `(typeof ${ref} === "object" && ${ref} !== null)`
          : `((${ref} = ${expr}), typeof ${ref} === "object" && ${ref} !== null)`
        if (pattern.entries.length === 0) return head
        const checks = pattern.entries.map(([key, sub]) => {
          const keyExpr = this.emitKeyExpr(key)
          const propExpr =
            typeof key === 'string' ? formatPropertyAccess(ref, key) : `${ref}[${keyExpr}]`
          return `(${keyExpr} in ${ref} && ${this.emitPattern(sub, propExpr, false)})`
        })
        return `(${head} && ${checks.join(' && ')})`
      }
      default: {
        return 'false'
      }
    }
  }
}

interface EmitContext {
  readonly builder: MatchCodeBuilder
  readonly kind: Exclude<MatchMode, 'value'>
  readonly outcome: MatchOutcomeKind
  readonly okParam: string
}

const hasNumericStringKey = (entries: readonly (readonly [PropertyKey, MatchHandler])[]): boolean =>
  entries.some(([key]) => typeof key === 'string' && key !== '' && String(Number(key)) === key)

const emitInvokeReturn = (ctx: EmitContext, handler: MatchHandler): string => {
  const fnName = ctx.builder.bind(handler)
  const callExpr = ctx.kind === 'type' ? `${fnName}(v)` : `${fnName}(v, ...a)`
  if (ctx.outcome === 'direct') return `return ${callExpr};`
  if (ctx.outcome === 'result') return `return ${ctx.okParam}(${callExpr});`
  return `return { _tag: "Some", value: ${callExpr} };`
}

const emitTagTableCase = (
  ctx: EmitContext,
  item: Extract<MatchCaseIr, { readonly kind: 'tagTable' }>,
): string => {
  const { builder } = ctx
  const propExpr = builder.emitPropertyRead('v', item.key)
  const coerceNumeric = hasNumericStringKey(item.entries)
  const branches = item.entries.map(([tag, handler]) => {
    const caseExpr = builder.emitKeyExpr(tag)
    const ret = emitInvokeReturn(ctx, handler)
    return `      case ${caseExpr}: ${ret}`
  })
  if (!coerceNumeric) {
    return `  if (v !== null && (typeof v === "object" || typeof v === "function")) {\n    switch (${propExpr}) {\n${branches.join('\n')}\n    }\n  }`
  }
  const discTemp = builder.temp()
  return `  if (v !== null && (typeof v === "object" || typeof v === "function")) {\n    ${discTemp} = ${propExpr};\n    switch (typeof ${discTemp} === "number" ? String(${discTemp}) : ${discTemp}) {\n${branches.join('\n')}\n    }\n  }`
}

const emitTagSetCase = (
  ctx: EmitContext,
  item: Extract<MatchCaseIr, { readonly kind: 'tagSet' }>,
): string => {
  if (item.tags.length === 0) return ''
  const { builder } = ctx
  const discTemp = builder.temp()
  const propExpr = builder.emitPropertyRead('v', item.key)
  const ret = emitInvokeReturn(ctx, item.handler)
  const primitive = item.tags.includes(undefined)
    ? `if (v === null || (typeof v !== "object" && typeof v !== "function")) ${ret}\n`
    : ''
  if (item.tags.length <= 4) {
    const checks = item.tags
      .map((tag) =>
        typeof tag === 'number' && Number.isNaN(tag)
          ? `Number.isNaN(${discTemp})`
          : builder.emitLiteralCheck(discTemp, tag),
      )
      .join(' || ')
    return `${primitive}  if ((typeof v === "object" || typeof v === "function") && v !== null) {\n    ${discTemp} = ${propExpr};\n    if (${checks}) ${ret}\n  }`
  }
  const hasNaN = item.tags.some((tag) => typeof tag === 'number' && Number.isNaN(tag))
  const nonNaNTags = hasNaN
    ? item.tags.filter((tag) => !(typeof tag === 'number' && Number.isNaN(tag)))
    : item.tags
  const nanCheck = hasNaN ? `    if (Number.isNaN(${discTemp})) ${ret}\n` : ''
  if (nonNaNTags.length === 0) {
    return `${primitive}  if ((typeof v === "object" || typeof v === "function") && v !== null) {\n    ${discTemp} = ${propExpr};\n${nanCheck}  }`
  }
  const cases = nonNaNTags
    .map((tag) => {
      if (typeof tag === 'string') return `      case ${serializeStringLiteral(tag)}:`
      if (typeof tag === 'number') return `      case ${String(tag)}:`
      return `      case ${builder.bind(tag)}:`
    })
    .join('\n')
  return `${primitive}  if ((typeof v === "object" || typeof v === "function") && v !== null) {\n    ${discTemp} = ${propExpr};\n${nanCheck}    switch (${discTemp}) {\n${cases}\n        ${ret}\n    }\n  }`
}

// fallow-ignore-next-line complexity
const emitCaseStatement = (ctx: EmitContext, item: MatchCaseIr): string => {
  const { builder } = ctx
  switch (item.kind) {
    case 'pattern': {
      const cond = builder.emitPattern(item.pattern, 'v', true)
      const ret = emitInvokeReturn(ctx, item.handler)
      return cond === 'true' ? `  ${ret}` : `  if (${cond}) ${ret}`
    }
    case 'or': {
      if (item.patterns.length === 0) return ''
      const cond = item.patterns
        .map((pat) => `(${builder.emitPattern(pat, 'v', true)})`)
        .join(' || ')
      const ret = emitInvokeReturn(ctx, item.handler)
      return `  if (${cond}) ${ret}`
    }
    case 'and': {
      if (item.patterns.length === 0) return `  ${emitInvokeReturn(ctx, item.handler)}`
      const cond = item.patterns
        .map((pat) => `(${builder.emitPattern(pat, 'v', true)})`)
        .join(' && ')
      const ret = emitInvokeReturn(ctx, item.handler)
      return `  if (${cond}) ${ret}`
    }
    case 'not': {
      const cond = builder.emitPattern(item.pattern, 'v', true)
      const ret = emitInvokeReturn(ctx, item.handler)
      return `  if (!(${cond})) ${ret}`
    }
    case 'tagSet': {
      return emitTagSetCase(ctx, item)
    }
    case 'tagPrefix': {
      const discTemp = builder.temp()
      const propExpr = builder.emitPropertyRead('v', item.key)
      const ret = emitInvokeReturn(ctx, item.handler)
      return `  if ((typeof v === "object" || typeof v === "function") && v !== null) {\n    ${discTemp} = ${propExpr};\n    if (typeof ${discTemp} === "string" && ${discTemp}.startsWith(${serializeStringLiteral(item.prefix)})) ${ret}\n  }`
    }
    case 'tagTable': {
      return emitTagTableCase(ctx, item)
    }
    default: {
      return ''
    }
  }
}

const buildHeader = (kind: Exclude<MatchMode, 'value'>, selParam: string): string => {
  if (kind === 'type') return 'return function resultarMatchType(v) {\n'
  if (kind === 'context') return 'return function resultarMatchContext(v, ...a) {\n'
  return `return function resultarMatchFn(...a) {\n  const v = ${selParam}(...a);\n`
}

const buildFallbackLine = (ctx: EmitContext, errParam: string, fbParam: string): string => {
  if (ctx.outcome === 'result') return `  return ${errParam}(v);`
  if (ctx.outcome === 'option') return '  return { _tag: "None" };'
  return ctx.kind === 'type' ? `  return ${fbParam}(v);` : `  return ${fbParam}(v, ...a);`
}

export interface CompileMatcherOptions {
  readonly kind: Exclude<MatchMode, 'value'>
  readonly select: (...args: readonly unknown[]) => unknown
  readonly cases: readonly MatchCaseIr[]
  readonly outcome: MatchOutcomeKind
  readonly fallback: MatchHandler
  readonly builtins: ReadonlyMap<unknown, MatchBuiltinEmitter>
}

/** Compiles a reusable `Match` pipeline with automatic CSP-safe fallback. */
export const compileMatcher = (
  options: CompileMatcherOptions,
): ((...args: readonly unknown[]) => unknown) => {
  if (!canUseJit()) return createFallbackMatcher(options)
  const { kind, select, cases, outcome, fallback, builtins } = options
  if (
    cases.length > MAX_JIT_CASES ||
    cases.some((item) => item.kind === 'tagPrefix' && typeof item.prefix !== 'string')
  ) {
    return createFallbackMatcher(options)
  }

  const builder = new MatchCodeBuilder(builtins)
  const okParam = outcome === 'result' ? builder.bind(ok) : ''
  const errParam = outcome === 'result' ? builder.bind(err) : ''
  const selParam = kind === 'fn' ? builder.bind(select) : ''
  const fbParam = outcome === 'direct' ? builder.bind(fallback) : ''
  const ctx: EmitContext = { builder, kind, outcome, okParam }

  const lines: string[] = []
  for (const item of cases) {
    const stmt = emitCaseStatement(ctx, item)
    if (stmt !== '') lines.push(stmt)
  }

  const tempDecl = builder.temps.length > 0 ? `  let ${builder.temps.join(', ')};\n` : ''
  const header = buildHeader(kind, selParam)
  const fallbackLine = buildFallbackLine(ctx, errParam, fbParam)
  const body = `${header}${tempDecl}${lines.join('\n')}\n${fallbackLine}\n}`
  const compiled = compileJitFunction<(...args: readonly unknown[]) => unknown>(
    builder.paramNames,
    body,
    builder.paramValues,
  )
  return compiled ?? createFallbackMatcher(options)
}
