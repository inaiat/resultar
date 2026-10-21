import type { Exit } from './result-task.js'
import type { Cause } from './cause.js'

export const SUCCESS_UNDEFINED: Exit<undefined, never> = { _tag: 'Success', value: undefined }

export const success = <A, E>(value: A): Exit<A, E> => ({ _tag: 'Success', value })

export const failure = <A, E>(cause: Cause<E>): Exit<A, E> => ({ _tag: 'Failure', cause })

export const failed = <A, E>(error: E): Exit<A, E> => failure({ _tag: 'Fail', error })

export const died = <A, E>(defect: unknown): Exit<A, E> => failure({ _tag: 'Die', defect })

export const interrupted = (signal: AbortSignal): Exit<never, never> =>
  failure({ _tag: 'Interrupt', reason: signal.reason })

export const combineExits = (
  left: Exit<unknown, unknown>,
  right: Exit<unknown, unknown>,
  tag: 'Sequential' | 'Parallel',
): Exit<unknown, unknown> => {
  if (right._tag === 'Success') return left
  if (left._tag === 'Success') return right
  return failure({ _tag: tag, left: left.cause, right: right.cause })
}

export const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal

type AbortListener = () => void

/** Lightweight internal AbortSignal that avoids C++ EventTarget allocations unless a native signal is needed. */
export class FiberSignal {
  private isAborted = false
  private abortReason: unknown = undefined
  private listeners: Set<AbortListener> | undefined = undefined
  private children: Set<FiberSignal> | undefined = undefined
  private nativeController: AbortController | undefined = undefined
  private readonly parent: AbortSignal
  private readonly onParentAbort: AbortListener | undefined

  public constructor(parent: AbortSignal = NEVER_ABORTED_SIGNAL) {
    this.parent = parent
    if (parent === NEVER_ABORTED_SIGNAL) {
      this.onParentAbort = undefined
    } else if (parent instanceof FiberSignal) {
      this.onParentAbort = undefined
      if (parent.aborted) {
        this.isAborted = true
        this.abortReason = parent.reason
      } else {
        parent.addChild(this)
      }
    } else if (parent.aborted) {
      this.onParentAbort = undefined
      this.isAborted = true
      this.abortReason = parent.reason
    } else {
      const onParentAbort = (): void => {
        this.abort(parent.reason)
      }
      this.onParentAbort = onParentAbort
      parent.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  private addChild(child: FiberSignal): void {
    this.children ??= new Set()
    this.children.add(child)
  }

  public get aborted(): boolean {
    return this.isAborted
  }

  public get reason(): unknown {
    return this.abortReason
  }

  public addEventListener(_type: string, listener: AbortListener): void {
    if (this.isAborted) return
    this.listeners ??= new Set()
    this.listeners.add(listener)
  }

  public removeEventListener(_type: string, listener: AbortListener): void {
    this.listeners?.delete(listener)
  }

  public abort(reason?: unknown): void {
    if (this.isAborted) return
    this.isAborted = true
    this.abortReason = reason ?? new DOMException('This operation was aborted', 'AbortError')
    if (this.nativeController !== undefined) {
      this.nativeController.abort(this.abortReason)
    }
    if (this.children !== undefined) {
      for (const child of this.children) {
        this.children.delete(child)
        child.abort(this.abortReason)
      }
    }
    if (this.listeners !== undefined) {
      for (const listener of this.listeners) {
        this.listeners.delete(listener)
        listener()
      }
    }
  }

  public dispose(): void {
    const parent = this.parent
    if (parent === NEVER_ABORTED_SIGNAL) return
    if (parent instanceof FiberSignal) {
      parent.children?.delete(this)
    } else if (this.onParentAbort !== undefined) {
      parent.removeEventListener('abort', this.onParentAbort)
    }
  }

  public asAbortSignal(): AbortSignal {
    return this as unknown as AbortSignal
  }

  public toNativeSignal(): AbortSignal {
    if (this.nativeController === undefined) {
      this.nativeController = new AbortController()
      if (this.isAborted) {
        this.nativeController.abort(this.abortReason)
      }
    }
    return this.nativeController.signal
  }
}

export const toNativeAbortSignal = (signal: AbortSignal): AbortSignal =>
  signal instanceof FiberSignal ? signal.toNativeSignal() : signal

export const interruptSuccess = (
  exit: Exit<unknown, unknown>,
  signal: AbortSignal,
): Exit<unknown, unknown> =>
  signal !== NEVER_ABORTED_SIGNAL && exit._tag === 'Success' && signal.aborted
    ? interrupted(signal)
    : exit
