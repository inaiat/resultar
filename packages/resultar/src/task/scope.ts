import type { Exit } from './result-task.js'
import { markCleanupCause } from './cleanup-cause.js'

type Finalizer = (
  exit: Exit<unknown, unknown>,
) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>

/** Children are stopped and awaited before resources belonging to their parent are released. */
export interface ScopeChild {
  readonly interrupt: (reason: unknown) => void
  readonly close: () => Promise<Exit<unknown, unknown>>
  owner?: TaskScope | undefined
}

/** Appends cleanup failures without replacing the original execution outcome. */
const appendExit = (
  exit: Exit<unknown, unknown>,
  cleanup: Exit<unknown, unknown>,
): Exit<unknown, unknown> => {
  if (cleanup._tag === 'Success') return exit
  if (exit._tag === 'Success') return cleanup
  return { _tag: 'Failure', cause: { _tag: 'Sequential', left: exit.cause, right: cleanup.cause } }
}

const SUCCESS_UNDEFINED: Exit<unknown, unknown> = { _tag: 'Success', value: undefined }

/** Private runtime scope; each run owns its own finalizer stack. */
export class TaskScope {
  private finalizers: Finalizer[] | undefined
  private children: Set<ScopeChild> | undefined
  private closing: Promise<Exit<unknown, unknown>> | undefined
  private closedExit: Exit<unknown, unknown> | undefined
  private isClosing = false
  private cleanup: Exit<unknown, unknown> = SUCCESS_UNDEFINED

  public registerChild(child: ScopeChild): void {
    if (this.isClosing) throw new Error('Cannot fork into a closing ResultTask scope')
    this.children ??= new Set()
    this.children.add(child)
    child.owner = this
  }

  public unregisterChild(child: ScopeChild): void {
    if (child.owner === this) {
      this.children?.delete(child)
      child.owner = undefined
    }
  }

  public addChild(child: ScopeChild): () => void {
    this.registerChild(child)
    return () => {
      child.owner?.unregisterChild(child)
    }
  }

  public get cleanupExit(): Exit<unknown, unknown> {
    return this.cleanup
  }

  /* Stryker disable all: allocation optimization predicate used by runExitSyncOrAsync when no resources or children were registered. */
  public isClean(): boolean {
    return this.finalizers === undefined && this.children === undefined
  }
  /* Stryker restore all */

  public add(finalizer: Finalizer): void {
    if (this.isClosing) throw new Error('Cannot acquire into a closing ResultTask scope')
    this.finalizers ??= []
    this.finalizers.push(finalizer)
  }

  public adopt(child: TaskScope): void {
    if (this.isClosing) throw new Error('Cannot acquire into a closing ResultTask scope')
    if (child.finalizers !== undefined && child.finalizers.length > 0) {
      this.finalizers ??= []
      this.finalizers.push(...child.finalizers.splice(0))
    }
    if (child.children !== undefined && child.children.size > 0) {
      this.children ??= new Set()
      for (const owned of child.children) {
        this.children.add(owned)
        owned.owner = this
      }
      child.children.clear()
    }
  }

  public closeSyncOrAsync(
    exit: Exit<unknown, unknown>,
    cleanupOnly = false,
  ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    if (this.closedExit !== undefined) return this.closedExit
    if (this.closing !== undefined) return this.closing
    this.isClosing = true

    const childrenSet = this.children
    const hasChildren = childrenSet !== undefined && childrenSet.size > 0
    const hasFinalizers = this.finalizers !== undefined && this.finalizers.length > 0
    if (!hasChildren && !hasFinalizers) {
      const out = cleanupOnly ? this.cleanup : exit
      this.closedExit = out
      return out
    }
    if (!hasChildren) {
      return this.drainFinalizersSyncOrAsync(exit, cleanupOnly, appendExit(exit, this.cleanup))
    }
    this.closing = this.drain(exit, cleanupOnly, childrenSet)
    return this.closing
  }

  public close(exit: Exit<unknown, unknown>, cleanupOnly = false): Promise<Exit<unknown, unknown>> {
    if (this.closing !== undefined) return this.closing
    const synced = this.closeSyncOrAsync(exit, cleanupOnly)
    this.closing = '_tag' in synced ? Promise.resolve(synced) : synced
    return this.closing
  }

  private async closeChildren(childrenSet: Set<ScopeChild>): Promise<void> {
    const children = [...childrenSet]
    for (const child of children) child.interrupt('ResultTask parent scope closed')
    const outcomes = await Promise.all(children.map((child) => child.close()))
    for (const child of children) child.owner = undefined
    childrenSet.clear()
    for (const outcome of outcomes) {
      if (outcome._tag === 'Failure') {
        this.cleanup =
          this.cleanup._tag === 'Success'
            ? outcome
            : {
                _tag: 'Failure',
                cause: { _tag: 'Parallel', left: this.cleanup.cause, right: outcome.cause },
              }
      }
    }
  }

  private recordFinalizerExit(
    currentResult: Exit<unknown, unknown>,
    released: Exit<unknown, unknown>,
  ): Exit<unknown, unknown> {
    this.cleanup = appendExit(this.cleanup, released)
    return appendExit(currentResult, released)
  }

  private recordFinalizerDefect(
    currentResult: Exit<unknown, unknown>,
    error: unknown,
  ): Exit<unknown, unknown> {
    return this.recordFinalizerExit(currentResult, {
      _tag: 'Failure',
      cause: { _tag: 'Die', defect: error },
    })
  }

  private finishDrain(
    cleanupOnly: boolean,
    result: Exit<unknown, unknown>,
  ): Exit<unknown, unknown> {
    if (this.cleanup._tag === 'Failure') markCleanupCause(this.cleanup.cause)
    const out = cleanupOnly ? this.cleanup : result
    this.closedExit = out
    return out
  }

  private drainFinalizersSyncOrAsync(
    exit: Exit<unknown, unknown>,
    cleanupOnly: boolean,
    initialResult: Exit<unknown, unknown>,
  ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    const finalizers = this.finalizers
    let result = initialResult
    let finalizer = finalizers?.pop()
    while (finalizer !== undefined) {
      try {
        const released = finalizer(exit)
        if ('_tag' in released) {
          result = this.recordFinalizerExit(result, released)
        } else {
          this.closing = this.drainFinalizersAsync(exit, cleanupOnly, {
            currentResult: result,
            pendingRelease: released,
          })
          return this.closing
        }
      } catch (error) {
        result = this.recordFinalizerDefect(result, error)
      }
      finalizer = finalizers?.pop()
    }
    return this.finishDrain(cleanupOnly, result)
  }

  private async drainFinalizersAsync(
    exit: Exit<unknown, unknown>,
    cleanupOnly: boolean,
    state: {
      readonly currentResult: Exit<unknown, unknown>
      readonly pendingRelease: Promise<Exit<unknown, unknown>>
    },
  ): Promise<Exit<unknown, unknown>> {
    let result = state.currentResult
    try {
      result = this.recordFinalizerExit(result, await state.pendingRelease)
    } catch (error) {
      result = this.recordFinalizerDefect(result, error)
    }
    const finalizers = this.finalizers
    let finalizer = finalizers?.pop()
    while (finalizer !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop
        result = this.recordFinalizerExit(result, await finalizer(exit))
      } catch (error) {
        result = this.recordFinalizerDefect(result, error)
      }
      finalizer = finalizers?.pop()
    }
    return this.finishDrain(cleanupOnly, result)
  }

  private async drain(
    exit: Exit<unknown, unknown>,
    cleanupOnly: boolean,
    childrenSet: Set<ScopeChild>,
  ): Promise<Exit<unknown, unknown>> {
    await this.closeChildren(childrenSet)
    return this.drainFinalizersSyncOrAsync(exit, cleanupOnly, appendExit(exit, this.cleanup))
  }
}
