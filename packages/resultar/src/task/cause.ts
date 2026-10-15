import { err, ok } from '../result/result.js'
import type { Result } from '../result/result.js'

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

const formatValue = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    const seen = new WeakSet<object>()
    return (
      JSON.stringify(value, (_key, entry: unknown): unknown => {
        if (typeof entry === 'bigint') return `${entry}n`
        if (typeof entry === 'symbol' || typeof entry === 'function') return String(entry)
        if (typeof entry === 'object' && entry !== null) {
          if (seen.has(entry)) return '[Circular]'
          seen.add(entry)
        }
        return entry
      }) ?? String(value)
    )
  } catch {
    return '[Unserializable value]'
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
  return lines.join('\n')
}

/**
 * Inspection and diagnostic formatting utilities for sequential and parallel {@link Cause} trees.
 *
 * @example
 * ```ts
 * import { Cause, ResultTask } from 'resultar'
 *
 * const recovered = await ResultTask.err('PrimaryFailed' as const)
 *   .sandbox()
 *   .mapError((cause) => ({
 *     firstError: Cause.findError(cause).unwrapOr('none' as const),
 *     report: Cause.pretty(cause),
 *   }))
 *   .run()
 * ```
 */
export const Cause: {
  /** Stack-safe structural type guard for {@link Cause} trees (rejects cyclic objects). */
  readonly isCause: (value: unknown) => value is Cause<unknown>
  /** Returns `true` if any leaf in `cause` is a typed `Fail` node. */
  readonly hasFails: <E>(cause: Cause<E>) => boolean
  /** Returns `true` if any leaf in `cause` is an unexpected `Die` defect node. */
  readonly hasDies: <E>(cause: Cause<E>) => boolean
  /** Returns `true` if any leaf in `cause` is an `Interrupt` node. */
  readonly hasInterrupts: <E>(cause: Cause<E>) => boolean
  /** Collects all typed `Fail` errors from `cause` in left-to-right leaf order. */
  readonly failures: <E>(cause: Cause<E>) => readonly E[]
  /** Collects all `Die` defects from `cause` in left-to-right leaf order. */
  readonly defects: <E>(cause: Cause<E>) => readonly unknown[]
  /**
   * Returns `Ok(firstError)` for the first `Fail` leaf in left-to-right order,
   * or `Err(causeWithoutFails)` typed as `Cause<never>` when no `Fail` leaf exists.
   */
  readonly findError: <E>(cause: Cause<E>) => Result<E, Cause<never>>
  /** Formats every leaf in left-to-right order (including `Error` stacks) for human diagnostics. */
  readonly pretty: <E>(cause: Cause<E>) => string
} = Object.freeze({
  isCause,
  hasFails,
  hasDies,
  hasInterrupts,
  failures,
  defects,
  findError,
  pretty,
})
