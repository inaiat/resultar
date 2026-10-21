import type { Cause } from './cause.js'
import { isCleanupCause, markCleanupCause } from './cleanup-cause.js'

const inheritCleanupCause = (
  original: Cause<unknown>,
  transformed: Cause<unknown> | undefined,
): Cause<unknown> | undefined => {
  if (isCleanupCause(original)) markCleanupCause(transformed)
  return transformed
}

const recomposeCause = (
  original: Extract<Cause<unknown>, { readonly _tag: 'Sequential' | 'Parallel' }>,
  left: Cause<unknown> | undefined,
  right: Cause<unknown> | undefined,
): Cause<unknown> | undefined => {
  if (left === undefined) return inheritCleanupCause(original, right)
  if (right === undefined) return inheritCleanupCause(original, left)
  return inheritCleanupCause(original, { _tag: original._tag, left, right })
}

/** Rebuilds cause trees without using the JavaScript call stack. */
export function transformCause(
  cause: Cause<unknown>,
  transform: (leaf: Cause<unknown>) => Cause<unknown>,
  stopAt?: (node: Cause<unknown>) => boolean,
): Cause<unknown>
export function transformCause(
  cause: Cause<unknown>,
  transform: (leaf: Cause<unknown>) => Cause<unknown> | undefined,
  stopAt?: (node: Cause<unknown>) => boolean,
): Cause<unknown> | undefined
export function transformCause(
  cause: Cause<unknown>,
  transform: (leaf: Cause<unknown>) => Cause<unknown> | undefined,
  stopAt?: (node: Cause<unknown>) => boolean,
): Cause<unknown> | undefined {
  const pending: { readonly cause: Cause<unknown>; readonly visited: boolean }[] = [
    { cause, visited: false },
  ]
  const results: (Cause<unknown> | undefined)[] = []
  let frame = pending.pop()
  while (frame !== undefined) {
    const current = frame.cause
    if (
      stopAt?.(current) === true ||
      (current._tag !== 'Sequential' && current._tag !== 'Parallel')
    ) {
      results.push(inheritCleanupCause(current, transform(current)))
    } else if (frame.visited) {
      const right = results.pop()
      const left = results.pop()
      results.push(recomposeCause(current, left, right))
    } else {
      pending.push(
        { cause: current, visited: true },
        { cause: current.right, visited: false },
        { cause: current.left, visited: false },
      )
    }
    frame = pending.pop()
  }
  return results[0]
}

/** Internal sibling cancellation is not an additional failure, but cleanup failures are. */
export const withoutInterruptions = (cause: Cause<unknown>): Cause<unknown> | undefined =>
  transformCause(cause, (leaf) => (leaf._tag === 'Interrupt' ? undefined : leaf))
