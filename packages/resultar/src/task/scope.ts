import type { Exit } from './result-task.js'
import { markCleanupCause } from './cleanup-cause.js'

type Finalizer = (exit: Exit<unknown, unknown>) => Promise<Exit<unknown, unknown>>

/** Children are stopped and awaited before resources belonging to their parent are released. */
export interface ScopeChild {
  readonly interrupt: (reason: unknown) => void
  readonly close: () => Promise<Exit<unknown, unknown>>
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

/** Private runtime scope; each run owns its own finalizer stack. */
export class TaskScope {
  private static readonly owners = new WeakMap<ScopeChild, TaskScope>()
  private readonly finalizers: Finalizer[] = []
  private readonly children = new Set<ScopeChild>()
  private closing: Promise<Exit<unknown, unknown>> | undefined
  private cleanup: Exit<unknown, unknown> = { _tag: 'Success', value: undefined }

  public addChild(child: ScopeChild): () => void {
    if (this.closing !== undefined) throw new Error('Cannot fork into a closing ResultTask scope')
    this.children.add(child)
    TaskScope.owners.set(child, this)
    return () => {
      TaskScope.owners.get(child)?.children.delete(child)
      TaskScope.owners.delete(child)
    }
  }

  public get cleanupExit(): Exit<unknown, unknown> {
    return this.cleanup
  }

  public add(finalizer: Finalizer): void {
    if (this.closing !== undefined)
      throw new Error('Cannot acquire into a closing ResultTask scope')
    this.finalizers.push(finalizer)
  }

  public adopt(child: TaskScope): void {
    if (this.closing !== undefined)
      throw new Error('Cannot acquire into a closing ResultTask scope')
    this.finalizers.push(...child.finalizers.splice(0))
    for (const owned of child.children) {
      this.children.add(owned)
      TaskScope.owners.set(owned, this)
    }
    child.children.clear()
  }

  public close(exit: Exit<unknown, unknown>, cleanupOnly = false): Promise<Exit<unknown, unknown>> {
    this.closing ??= this.drain(exit, cleanupOnly)
    return this.closing
  }

  private async closeChildren(): Promise<void> {
    const children = [...this.children]
    for (const child of children) child.interrupt('ResultTask parent scope closed')
    const outcomes = await Promise.all(children.map((child) => child.close()))
    for (const child of children) TaskScope.owners.delete(child)
    this.children.clear()
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

  private async drain(
    exit: Exit<unknown, unknown>,
    cleanupOnly: boolean,
  ): Promise<Exit<unknown, unknown>> {
    await this.closeChildren()
    let result = appendExit(exit, this.cleanup)
    let finalizer = this.finalizers.pop()
    while (finalizer !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const released = await finalizer(exit)
        this.cleanup = appendExit(this.cleanup, released)
        result = appendExit(result, released)
      } catch (error) {
        const defect: Exit<unknown, unknown> = {
          _tag: 'Failure',
          cause: { _tag: 'Die', defect: error },
        }
        this.cleanup = appendExit(this.cleanup, defect)
        result = appendExit(result, defect)
      }
      finalizer = this.finalizers.pop()
    }
    if (this.cleanup._tag === 'Failure') markCleanupCause(this.cleanup.cause)
    return cleanupOnly ? this.cleanup : result
  }
}
