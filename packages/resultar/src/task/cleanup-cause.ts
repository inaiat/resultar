import type { Cause } from './cause.js'

// Cleanup provenance stays private and does not add properties to the public Cause structure.
const cleanupCauses = new WeakSet<object>()

export const markCleanupCause = (cause: Cause<unknown> | undefined): void => {
  cleanupCauses.add(cause as object)
}

export const isCleanupCause = (cause: Cause<unknown>): boolean => cleanupCauses.has(cause)
