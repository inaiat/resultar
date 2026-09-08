import type { Exit } from '../result-task.js'

type Finalizer = (exit: Exit<unknown, unknown>) => Promise<Exit<unknown, unknown>>

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
  private readonly finalizers: Finalizer[] = []
  private closing: Promise<Exit<unknown, unknown>> | undefined

  public add(finalizer: Finalizer): void {
    if (this.closing !== undefined)
      throw new Error('Cannot acquire into a closing ResultTask scope')
    this.finalizers.push(finalizer)
  }

  public adopt(child: TaskScope): void {
    if (this.closing !== undefined)
      throw new Error('Cannot acquire into a closing ResultTask scope')
    this.finalizers.push(...child.finalizers.splice(0))
  }

  public close(exit: Exit<unknown, unknown>, cleanupOnly = false): Promise<Exit<unknown, unknown>> {
    this.closing ??= this.drain(exit, cleanupOnly)
    return this.closing
  }

  private async drain(
    exit: Exit<unknown, unknown>,
    cleanupOnly: boolean,
  ): Promise<Exit<unknown, unknown>> {
    let result: Exit<unknown, unknown> = cleanupOnly ? { _tag: 'Success', value: undefined } : exit
    let finalizer = this.finalizers.pop()
    while (finalizer !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop
        result = appendExit(result, await finalizer(exit))
      } catch (error) {
        result = appendExit(result, { _tag: 'Failure', cause: { _tag: 'Die', defect: error } })
      }
      finalizer = this.finalizers.pop()
    }
    return result
  }
}
