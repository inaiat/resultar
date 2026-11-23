import { err, ok } from '../result/result.js'
import type { Result } from '../result/result.js'
import { getCauseSpans } from './tracer.js'
import type { SpanTraceFrame } from './tracer.js'

/**
 * Lossless failure tree produced by a `ResultTask` execution (`Exit` failure channel,
 * `ResultTask.sandbox`, `ResultTask.catchCause`, and `ResultTask.onExit`).
 *
 * Leaves distinguish expected domain errors (`Fail`), unexpected defects (`Die`), and cancellation
 * (`Interrupt`), while `Sequential` and `Parallel` nodes preserve combined failures from finalizers
 * and concurrent children.
 */
export type Cause<E> =
  | { readonly _tag: 'Fail'; readonly error: E }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly reason: unknown }
  | { readonly _tag: 'Sequential'; readonly left: Cause<E>; readonly right: Cause<E> }
  | { readonly _tag: 'Parallel'; readonly left: Cause<E>; readonly right: Cause<E> }

type LeafCause<E> = Exclude<Cause<E>, { readonly _tag: 'Sequential' | 'Parallel' }>

/** Walks leaves left to right without consuming the JavaScript call stack. */
function* leaves<E>(cause: Cause<E>): Generator<LeafCause<E>, void, unknown> {
  const pending: Cause<E>[] = []
  let current: Cause<E> | undefined = cause
  while (current !== undefined) {
    if (current._tag === 'Sequential' || current._tag === 'Parallel') {
      pending.push(current.right)
      current = current.left
    } else {
      yield current
      current = pending.pop()
    }
  }
}

const hasReason = <E>(cause: Cause<E>, tag: LeafCause<E>['_tag']): boolean => {
  for (const leaf of leaves(cause)) {
    if (leaf._tag === tag) return true
  }
  return false
}

interface CauseNodeCandidate {
  readonly _tag?: unknown
  readonly error?: unknown
  readonly defect?: unknown
  readonly reason?: unknown
  readonly left?: unknown
  readonly right?: unknown
}

const isRecord = (value: unknown): value is CauseNodeCandidate =>
  typeof value === 'object' && value !== null

const isLeafCauseNode = (node: CauseNodeCandidate): boolean => {
  if (node._tag === 'Fail') return 'error' in node
  if (node._tag === 'Die') return 'defect' in node
  if (node._tag === 'Interrupt') return 'reason' in node
  return false
}

const isCompositeCauseNode = (node: CauseNodeCandidate): boolean =>
  (node._tag === 'Sequential' || node._tag === 'Parallel') && 'left' in node && 'right' in node

interface CauseTraversalState {
  readonly visiting: WeakSet<object>
  readonly verified: WeakSet<object>
  readonly pending: { readonly value: unknown; readonly exiting: boolean }[]
}

const visitCompositeCauseNode = (node: CauseNodeCandidate, state: CauseTraversalState): boolean => {
  if (!isCompositeCauseNode(node) || state.visiting.has(node)) return false
  if (state.verified.has(node)) return true
  state.visiting.add(node)
  state.pending.push(
    { value: node, exiting: true },
    { value: node.right, exiting: false },
    { value: node.left, exiting: false },
  )
  return true
}

const isCause = (value: unknown): value is Cause<unknown> => {
  const state: CauseTraversalState = {
    visiting: new WeakSet<object>(),
    verified: new WeakSet<object>(),
    pending: [{ value, exiting: false }],
  }
  let frame = state.pending.pop()
  while (frame !== undefined) {
    if (frame.exiting) {
      const node = frame.value as object
      state.visiting.delete(node)
      state.verified.add(node)
    } else if (
      !isRecord(frame.value) ||
      (!isLeafCauseNode(frame.value) && !visitCompositeCauseNode(frame.value, state))
    ) {
      return false
    }
    frame = state.pending.pop()
  }
  return true
}

const hasFails = <E>(cause: Cause<E>): boolean => hasReason(cause, 'Fail')
const hasDies = <E>(cause: Cause<E>): boolean => hasReason(cause, 'Die')
const hasInterrupts = <E>(cause: Cause<E>): boolean => hasReason(cause, 'Interrupt')

const isInterruptedOnly = <E>(cause: Cause<E>): boolean => {
  let sawInterrupt = false
  for (const leaf of leaves(cause)) {
    if (leaf._tag === 'Interrupt') {
      sawInterrupt = true
    } else {
      return false
    }
  }
  return sawInterrupt
}

const fail = <E>(error: E): Cause<E> => ({ _tag: 'Fail', error })
const die = (defect: unknown): Cause<never> => ({ _tag: 'Die', defect })
const interrupt = (reason?: unknown): Cause<never> => ({ _tag: 'Interrupt', reason })
const sequential = <E1, E2>(left: Cause<E1>, right: Cause<E2>): Cause<E1 | E2> => ({
  _tag: 'Sequential',
  left,
  right,
})
const parallel = <E1, E2>(left: Cause<E1>, right: Cause<E2>): Cause<E1 | E2> => ({
  _tag: 'Parallel',
  left,
  right,
})

const spans = <E>(cause: Cause<E>): readonly SpanTraceFrame[] => {
  if (cause._tag !== 'Parallel' && cause._tag !== 'Sequential') return getCauseSpans(cause)
  // Visit children before their parent to prefer the first traced branch, innermost first.
  const path: Cause<E>[] = []
  const pending: (Cause<E> | null)[] = [cause]
  while (pending.length > 0) {
    const item = pending.pop()
    const current = item === null ? path.pop() : item
    if (item !== null && (current?._tag === 'Parallel' || current?._tag === 'Sequential')) {
      path.push(current)
      pending.push(null, current.right, current.left)
    } else if (current !== undefined) {
      const frames = getCauseSpans(current)
      if (frames.length > 0) {
        return Object.freeze([...new Set([...frames, ...path.toReversed().flatMap(getCauseSpans)])])
      }
    }
  }
  return getCauseSpans(cause)
}

const failures = <E>(cause: Cause<E>): readonly E[] => {
  const result: E[] = []
  for (const leaf of leaves(cause)) {
    if (leaf._tag === 'Fail') result.push(leaf.error)
  }
  return result
}

const defects = <E>(cause: Cause<E>): readonly unknown[] => {
  const result: unknown[] = []
  for (const leaf of leaves(cause)) {
    if (leaf._tag === 'Die') result.push(leaf.defect)
  }
  return result
}

const findError = <E>(cause: Cause<E>): Result<E, Cause<never>> => {
  for (const leaf of leaves(cause)) {
    if (leaf._tag === 'Fail') return ok(leaf.error)
  }
  // Every leaf has been checked: this unchanged tree contains no typed failures.
  return err(cause as Cause<never>)
}

const safeJsonStringify = (value: unknown): string | undefined => {
  const ancestors: object[] = []
  const active = new Set<object>()
  return JSON.stringify(value, function (this: unknown, _key: string, entry: unknown): unknown {
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      const popped = ancestors.pop()
      if (popped !== undefined) active.delete(popped)
    }
    if (typeof entry === 'bigint') return `${entry}n`
    if (typeof entry === 'symbol' || typeof entry === 'function') return String(entry)
    if (typeof entry === 'object' && entry !== null) {
      if (active.has(entry)) return '[Circular]'
      ancestors.push(entry)
      active.add(entry)
    }
    return entry
  })
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
    return safeJsonStringify(value) ?? String(value)
  } catch {
    return '[Unserializable value]'
  }
}

const formatSpanAttribute = (value: unknown): string => {
  try {
    return safeJsonStringify(value) ?? String(value)
  } catch {
    return '[Unserializable value]'
  }
}

const formatSpanFrame = (frame: SpanTraceFrame): string => {
  if (frame.attributes === undefined) return `  at ${frame.name}`
  try {
    const entries = Object.entries(frame.attributes).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return `  at ${frame.name}`
    const formatted = entries
      .map(([key, value]) => `${key}=${formatSpanAttribute(value)}`)
      .join(', ')
    return `  at ${frame.name} (${formatted})`
  } catch {
    return `  at ${frame.name} ([Unserializable attributes])`
  }
}

const pretty = <E>(cause: Cause<E>): string => {
  const lines: string[] = []
  for (const leaf of leaves(cause)) {
    let value: unknown = undefined
    if (leaf._tag === 'Fail') value = leaf.error
    else if (leaf._tag === 'Die') value = leaf.defect
    else value = leaf.reason
    lines.push(`${leaf._tag}: ${formatValue(value).replaceAll('\n', '\n  ')}`)
  }
  const trace = spans(cause)
  if (trace.length > 0) {
    lines.push('Span trace:')
    for (const frame of trace) {
      lines.push(formatSpanFrame(frame))
    }
  }
  return lines.join('\n')
}

/**
 * Constructors, inspection predicates, and diagnostic formatting utilities for sequential and
 * parallel {@link Cause} trees.
 *
 * @example
 * ```ts
 * import { Cause, ResultTask } from 'resultar'
 *
 * const recovered = await ResultTask.err('PrimaryFailed' as const)
 *   .sandbox()
 *   .mapErr((cause) => ({
 *     firstError: Cause.findError(cause).unwrapOr('none' as const),
 *     report: Cause.pretty(cause),
 *   }))
 *   .runResult()
 * ```
 */
export const Cause: {
  /** Constructs a typed `Fail` leaf cause. */
  readonly fail: <E>(error: E) => Cause<E>
  /** Constructs an unexpected `Die` defect leaf cause. */
  readonly die: (defect: unknown) => Cause<never>
  /** Constructs an `Interrupt` leaf cause with an optional reason. */
  readonly interrupt: (reason?: unknown) => Cause<never>
  /** Combines two causes that happened sequentially (for example body failure + cleanup failure). */
  readonly sequential: <E1, E2>(left: Cause<E1>, right: Cause<E2>) => Cause<E1 | E2>
  /** Combines two causes that happened concurrently (for example parallel siblings). */
  readonly parallel: <E1, E2>(left: Cause<E1>, right: Cause<E2>) => Cause<E1 | E2>
  /** Stack-safe structural type guard for {@link Cause} trees (rejects cyclic objects). */
  readonly isCause: (value: unknown) => value is Cause<unknown>
  /** Returns `true` if any leaf in `cause` is a typed `Fail` node. */
  readonly hasFails: <E>(cause: Cause<E>) => boolean
  /** Returns `true` if any leaf in `cause` is an unexpected `Die` defect node. */
  readonly hasDies: <E>(cause: Cause<E>) => boolean
  /** Returns `true` if any leaf in `cause` is an `Interrupt` node. */
  readonly hasInterrupts: <E>(cause: Cause<E>) => boolean
  /** Returns `true` iff every leaf in `cause` is an `Interrupt` node (no `Fail` or `Die`). */
  readonly isInterruptedOnly: <E>(cause: Cause<E>) => boolean
  /** Collects all typed `Fail` errors from `cause` in left-to-right leaf order. */
  readonly failures: <E>(cause: Cause<E>) => readonly E[]
  /** Collects all `Die` defects from `cause` in left-to-right leaf order. */
  readonly defects: <E>(cause: Cause<E>) => readonly unknown[]
  /**
   * Returns `Ok(firstError)` for the first `Fail` leaf in left-to-right order,
   * or `Err(causeWithoutFails)` typed as `Cause<never>` when no `Fail` leaf exists.
   */
  readonly findError: <E>(cause: Cause<E>) => Result<E, Cause<never>>
  /** Returns the logical span stack attached to `cause` (innermost-first), or an empty array. */
  readonly spans: <E>(cause: Cause<E>) => readonly SpanTraceFrame[]
  /** Formats every leaf and any attached span trace in left-to-right order for human diagnostics. */
  readonly pretty: <E>(cause: Cause<E>) => string
} = Object.freeze({
  fail,
  die,
  interrupt,
  sequential,
  parallel,
  isCause,
  hasFails,
  hasDies,
  hasInterrupts,
  isInterruptedOnly,
  failures,
  defects,
  findError,
  spans,
  pretty,
})
