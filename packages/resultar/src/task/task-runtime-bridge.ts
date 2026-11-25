import type { Exit, ResultTask } from './result-task.js'
import type { ResultTaskRuntimeContext } from './task-service.js'

type RuntimeTaskFactory = <A, E = never, R = never>(
  execute: (context: ResultTaskRuntimeContext) => Exit<A, E> | Promise<Exit<A, E>>,
) => ResultTask<A, E, R>

type RuntimeTaskRunner = <A, E, R>(
  task: ResultTask<A, E, R>,
  context: ResultTaskRuntimeContext,
) => Exit<A, E> | Promise<Exit<A, E>>

interface RuntimeTaskBridge {
  readonly factory: RuntimeTaskFactory
  readonly runner: RuntimeTaskRunner
}

const bridges = new WeakMap<object, RuntimeTaskBridge>()

/** Registers the internal `ResultTask` constructor and runner used by companion task primitives. */
export const registerRuntimeTaskBridge = (owner: object, bridge: RuntimeTaskBridge): void => {
  bridges.set(owner, bridge)
}

const getBridge = (owner: object): RuntimeTaskBridge => {
  const bridge = bridges.get(owner)
  if (bridge === undefined) {
    throw new TypeError('ResultTask runtime has not initialized')
  }
  return bridge
}

/** Constructs a `ResultTask` from a low-level runtime context executor. */
export const createRuntimeTask = <A, E = never, R = never>(
  owner: object,
  execute: (context: ResultTaskRuntimeContext) => Exit<A, E> | Promise<Exit<A, E>>,
): ResultTask<A, E, R> => getBridge(owner).factory(execute)

/** Executes a `ResultTask` against a derived runtime context. */
export const runRuntimeTask = <A, E, R>(
  owner: object,
  task: ResultTask<A, E, R>,
  context: ResultTaskRuntimeContext,
): Exit<A, E> | Promise<Exit<A, E>> => getBridge(owner).runner(task, context)
