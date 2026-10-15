import type { Exit } from './result-task.js'
import type { Cause } from './cause.js'

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

export const interruptSuccess = (
  exit: Exit<unknown, unknown>,
  signal: AbortSignal,
): Exit<unknown, unknown> =>
  exit._tag === 'Success' && signal.aborted ? interrupted(signal) : exit
