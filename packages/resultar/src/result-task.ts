import { Pipeable } from './pipe.js'
import type { Result } from './result.js'
import { err, ok } from './result.js'
import { AbortError } from './abort-error.js'
import { TaskScope } from './task/scope.js'

/** A failure cause produced by a `ResultTask` execution. */
export type Cause<E> =
  | { readonly _tag: 'Fail'; readonly error: E }
  | { readonly _tag: 'Die'; readonly defect: unknown }
  | { readonly _tag: 'Interrupt'; readonly reason: unknown }
  | { readonly _tag: 'Sequential'; readonly left: Cause<E>; readonly right: Cause<E> }

/** Rejection used when a simplified boundary cannot represent multiple failures. */
export class ResultTaskCauseError extends Error {
  public override readonly cause: Cause<unknown>

  public constructor(cause: Cause<unknown>) {
    super('ResultTask execution failed with multiple causes', { cause })
    this.name = 'ResultTaskCauseError'
    this.cause = cause
  }
}

/** Type identifier symbol for nominal `ResultTask` branding and variance checks. */
export const ResultTaskTypeId: unique symbol = Symbol.for('resultar/ResultTask')

declare const scopeTypeId: unique symbol

/** Tracks deferred release failures until the owning scope is closed. */
export interface ResultTaskScope<out E> {
  readonly [scopeTypeId]: E
}

type ScopeError<R> = R extends ResultTaskScope<infer E> ? E : never
type WithoutScope<R> = Exclude<R, ResultTaskScope<unknown>>

/** Resource acquisition and release share one execution and service environment. */
export interface ResultTaskAcquireReleaseOptions<A, E, R, ReleaseError, ReleaseR> {
  readonly acquire: ResultTask<A, E, R>
  readonly release: (
    resource: A,
    exit: Exit<unknown, unknown>,
  ) => ResultTask<void, ReleaseError, ReleaseR>
}

/** The complete outcome of a `ResultTask` execution. */
export type Exit<A, E> =
  | { readonly _tag: 'Success'; readonly value: A }
  | { readonly _tag: 'Failure'; readonly cause: Cause<E> }

/** A service that can be requested from a `ResultTask.gen` workflow. */
export interface ServiceTag<Identifier extends string, Service> {
  readonly _tag: 'ServiceTag'
  readonly identifier: Identifier
  readonly key: symbol
  readonly [Symbol.iterator]: () => Generator<
    ResultTaskServiceYield<ServiceTag<Identifier, Service>>,
    Service,
    Service
  >
}

/** Resolves a service requested by a `ResultTask.gen` workflow. */
export type ResultTaskServiceResolver<R, E = never, ResolverR = never> = {
  readonly [Tag in Extract<R, AnyServiceTag> as Tag['identifier']]: () => ResultTask<
    ServiceForTag<Tag>,
    E,
    ResolverR
  >
}

type ResolverTasks<Resolvers> = Resolvers[keyof Resolvers] extends () => infer Task ? Task : never
type ResolverError<Resolvers> = [ResolverTasks<Resolvers>] extends [never]
  ? never
  : ResolverTasks<Resolvers> extends ResultTask<unknown, infer E, unknown>
    ? E
    : never
type ResolverRequirements<Resolvers> = [ResolverTasks<Resolvers>] extends [never]
  ? never
  : ResolverTasks<Resolvers> extends ResultTask<unknown, unknown, infer R>
    ? R
    : never

/** Owns resources across executions. Close it after its consumers have finished. */
export interface ResultTaskScopeOwner {
  readonly use: <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  readonly close: (exit?: Exit<unknown, unknown>) => ResultTask<void, unknown>
}

type RuntimeServiceResolver = (
  tag: AnyServiceTag,
) => ResultTask<unknown, unknown, unknown> | undefined

/** Options for running a `ResultTask` with an optional signal and its required services. */
export type ResultTaskRunOptions<R = never> = { readonly signal?: AbortSignal } & ([
  WithoutScope<R>,
] extends [never]
  ? { readonly services?: never }
  : { readonly services: ResultTaskServices<R> })

/** The object-shaped service environment required by a task. */
export type ResultTaskServices<R> = {
  readonly [Tag in Extract<R, AnyServiceTag> as Tag['identifier']]: ServiceForTag<Tag>
}

/** Options for creating a synchronous task with an explicit error boundary. */
export interface ResultTaskTryOptions<A, E> {
  readonly try: () => A
  readonly catch: (cause: unknown) => E
}

/** Options for creating a lazy promise-producing task with an explicit error boundary. */
export interface ResultTaskTryPromiseOptions<A, E> {
  readonly try: (signal: AbortSignal) => PromiseLike<A>
  readonly catch: (cause: unknown) => E
}

type AnyServiceTag = Pick<ServiceTag<string, unknown>, '_tag' | 'identifier' | 'key'>
type ServiceForTag<Tag> = Tag extends ServiceTag<string, infer Service> ? Service : never
type WithoutServices<R> = Exclude<R, AnyServiceTag>
type ResultTaskRuntimeServices = ReadonlyMap<symbol, unknown>

interface ResultTaskRuntimeContext {
  readonly namedServices: ReadonlyMap<string, unknown>
  readonly services: ResultTaskRuntimeServices
  readonly serviceResolver: RuntimeServiceResolver | undefined
  readonly signal: AbortSignal
  readonly scope: TaskScope
}

type ResultTaskExecutor = (context: ResultTaskRuntimeContext) => Promise<Exit<unknown, unknown>>
type ResultTaskNestedExecutor = (
  task: ResultTask<unknown, unknown, unknown>,
) => Promise<Exit<unknown, unknown>>

interface ResultTaskCloseRuntime {
  readonly context: ResultTaskRuntimeContext
  readonly executeTask: ResultTaskNestedExecutor
}

type ResultTaskExecutionOutcome = Exit<unknown, unknown> | { readonly error: unknown }

interface ResultTaskYield<A, E, R> {
  readonly _tag: 'ResultTask'
  readonly task: ResultTask<A, E, R>
}

interface ResultTaskServiceYield<Tag extends AnyServiceTag> {
  readonly _tag: 'Service'
  readonly tag: Tag
}

type GeneratorError<Yield> = Yield extends {
  readonly _tag: 'ResultTask'
  readonly task: infer Task
}
  ? Task extends ResultTask<infer _A, infer E, infer _R>
    ? E
    : never
  : never

type GeneratorRequirements<Yield> = Yield extends {
  readonly _tag: 'ResultTask'
  readonly task: infer Task
}
  ? Task extends ResultTask<infer _A, infer _E, infer R>
    ? R
    : never
  : Yield extends { readonly _tag: 'Service'; readonly tag: infer Tag }
    ? Tag
    : never

type ResultTaskRunArguments<R> = [WithoutScope<R>] extends [never]
  ? [options?: ResultTaskRunOptions<R>]
  : [options: ResultTaskRunOptions<R>]

const success = <A, E>(value: A): Exit<A, E> => ({ _tag: 'Success', value })

const failure = <A, E>(cause: Cause<E>): Exit<A, E> => ({ _tag: 'Failure', cause })

const failed = <A, E>(error: E): Exit<A, E> => failure({ _tag: 'Fail', error })

const died = <A, E>(defect: unknown): Exit<A, E> => failure({ _tag: 'Die', defect })

const interrupted = (signal: AbortSignal): Exit<never, never> =>
  failure({ _tag: 'Interrupt', reason: signal.reason })

const interruptSuccess = (
  exit: Exit<unknown, unknown>,
  signal: AbortSignal,
): Exit<unknown, unknown> =>
  exit._tag === 'Success' && signal.aborted ? interrupted(signal) : exit

const throwDefect = (defect: unknown): never => {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw defect
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const createMissingServiceError = (identifier: string): Error => {
  const error = new Error(`Missing ResultTask service: ${identifier}`)
  error.name = 'MissingServiceError'
  return error
}

const isResultTaskYield = (value: unknown): value is ResultTaskYield<unknown, unknown, unknown> =>
  isRecord(value) && value['_tag'] === 'ResultTask' && value['task'] instanceof ResultTask

const isServiceYield = (value: unknown): value is ResultTaskServiceYield<AnyServiceTag> =>
  isRecord(value) && value['_tag'] === 'Service' && value['tag'] instanceof ServiceTagValue

type ServiceLookup =
  | { readonly _tag: 'Found'; readonly value: unknown }
  | { readonly _tag: 'Missing' }

const lookupService = (tag: AnyServiceTag, context: ResultTaskRuntimeContext): ServiceLookup => {
  if (context.services.has(tag.key)) {
    return { _tag: 'Found', value: context.services.get(tag.key) }
  }

  if (context.namedServices.has(tag.identifier)) {
    return { _tag: 'Found', value: context.namedServices.get(tag.identifier) }
  }

  return { _tag: 'Missing' }
}

type ServiceResolution =
  | { readonly _tag: 'Found'; readonly value: unknown }
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Failure'; readonly exit: Exit<unknown, unknown> }
  | { readonly _tag: 'Error'; readonly error: unknown }

const resolveService = async (
  tag: AnyServiceTag,
  context: ResultTaskRuntimeContext,
  executeTask: ResultTaskNestedExecutor,
): Promise<ServiceResolution> => {
  const supplied = lookupService(tag, context)
  if (supplied._tag === 'Found') return supplied
  if (context.serviceResolver === undefined) return supplied

  let task: ResultTask<unknown, unknown, unknown> | undefined = undefined
  try {
    task = context.serviceResolver(tag)
  } catch (error) {
    return { _tag: 'Error', error }
  }
  if (task === undefined) return supplied
  const outcome = await executeTaskSafely(task, executeTask)
  if ('error' in outcome) return { _tag: 'Error', error: outcome.error }
  if (outcome._tag === 'Failure') return { _tag: 'Failure', exit: outcome }
  return { _tag: 'Found', value: outcome.value }
}

const executeTaskSafely = async (
  task: ResultTask<unknown, unknown, unknown>,
  executeTask: ResultTaskNestedExecutor,
): Promise<ResultTaskExecutionOutcome> => {
  try {
    return await executeTask(task)
  } catch (error) {
    return { error }
  }
}

// fallow-ignore-next-line complexity
const closeGenerator = async <Yield, Return, Next, E>(
  iterator: Generator<Yield, Return, Next>,
  exit: Exit<Return, E>,
  runtime: ResultTaskCloseRuntime,
): Promise<Exit<Return, E>> => {
  try {
    let step = iterator.return(undefined as Return)
    let finalExit = exit

    while (step.done === false) {
      if (isResultTaskYield(step.value)) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await executeTaskSafely(step.value.task, runtime.executeTask)

        if ('error' in outcome) {
          finalExit = died<Return, E>(outcome.error)
          step = iterator.return(undefined as Return)
        } else if (outcome._tag === 'Failure') {
          finalExit = outcome as Exit<Return, E>
          step = iterator.return(undefined as Return)
        } else {
          step = iterator.next(outcome as Next)
        }
      } else if (isServiceYield(step.value)) {
        // eslint-disable-next-line no-await-in-loop
        const resolution = await resolveService(
          step.value.tag,
          runtime.context,
          runtime.executeTask,
        )

        if (resolution._tag === 'Found') {
          step = iterator.next(resolution.value as Next)
        } else if (resolution._tag === 'Failure') {
          finalExit = resolution.exit as Exit<Return, E>
          step = iterator.return(undefined as Return)
        } else {
          finalExit = died<Return, E>(
            resolution._tag === 'Error'
              ? resolution.error
              : createMissingServiceError(step.value.tag.identifier),
          )
          step = iterator.return(undefined as Return)
        }
      } else {
        finalExit = died<Return, E>(new TypeError('ResultTask.gen yielded an unsupported value'))
        step = iterator.return(undefined as Return)
      }
    }

    return finalExit
  } catch (error) {
    return died<Return, E>(error)
  }
}

const withServices = (
  context: ResultTaskRuntimeContext,
  services: ReadonlyMap<symbol, unknown>,
): ResultTaskRuntimeContext => ({
  scope: context.scope,
  namedServices: context.namedServices,
  services,
  serviceResolver: context.serviceResolver,
  signal: context.signal,
})

const withScope = (
  context: ResultTaskRuntimeContext,
  scope: TaskScope,
  signal = context.signal,
): ResultTaskRuntimeContext => ({
  namedServices: context.namedServices,
  services: context.services,
  serviceResolver: context.serviceResolver,
  signal,
  scope,
})

const withNamedServices = (
  context: ResultTaskRuntimeContext,
  namedServices: ReadonlyMap<string, unknown>,
): ResultTaskRuntimeContext => ({
  scope: context.scope,
  namedServices,
  services: context.services,
  serviceResolver: context.serviceResolver,
  signal: context.signal,
})

const withServiceResolver = (
  context: ResultTaskRuntimeContext,
  serviceResolver: RuntimeServiceResolver,
): ResultTaskRuntimeContext => ({
  namedServices: context.namedServices,
  services: context.services,
  serviceResolver,
  signal: context.signal,
  scope: context.scope,
})

class ServiceTagValue<Identifier extends string, Service> implements ServiceTag<
  Identifier,
  Service
> {
  public readonly _tag = 'ServiceTag' as const
  public readonly identifier: Identifier
  public readonly key: symbol

  public constructor(identifier: Identifier) {
    this.identifier = identifier
    this.key = Symbol(identifier)
  }

  public *[Symbol.iterator](): Generator<
    ResultTaskServiceYield<ServiceTag<Identifier, Service>>,
    Service,
    Service
  > {
    const service = yield { _tag: 'Service', tag: this }
    return service
  }
}

type TaskInstruction =
  | { readonly _tag: 'Succeed'; readonly value: unknown }
  | { readonly _tag: 'Fail'; readonly error: unknown }
  | { readonly _tag: 'Sync'; readonly evaluate: () => Exit<unknown, unknown> }
  | { readonly _tag: 'Async'; readonly execute: ResultTaskExecutor }
  | {
      readonly _tag: 'FlatMap'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (value: unknown) => ResultTask<unknown, unknown, unknown>
    }
  | {
      readonly _tag: 'Map'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (value: unknown) => unknown
    }
  | {
      readonly _tag: 'CatchAll'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (error: unknown) => ResultTask<unknown, unknown, unknown>
    }

type TaskContinuation =
  | {
      readonly _tag: 'FlatMap'
      readonly f: (value: unknown) => ResultTask<unknown, unknown, unknown>
    }
  | { readonly _tag: 'Map'; readonly f: (value: unknown) => unknown }
  | {
      readonly _tag: 'CatchAll'
      readonly f: (error: unknown) => ResultTask<unknown, unknown, unknown>
    }

interface ContinuationStep {
  readonly current: ResultTask<unknown, unknown, unknown> | undefined
  readonly currentExit: Exit<unknown, unknown> | undefined
}

// fallow-ignore-next-line complexity
const applyContinuation = (
  continuation: TaskContinuation,
  exit: Exit<unknown, unknown>,
): ContinuationStep => {
  if (exit._tag === 'Success') {
    switch (continuation._tag) {
      case 'Map': {
        try {
          return { current: undefined, currentExit: success(continuation.f(exit.value)) }
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      case 'FlatMap': {
        try {
          return { current: continuation.f(exit.value), currentExit: undefined }
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      case 'CatchAll': {
        return { current: undefined, currentExit: exit }
      }
      default: {
        return { current: undefined, currentExit: exit }
      }
    }
  }

  switch (continuation._tag) {
    case 'Map':
    case 'FlatMap': {
      return { current: undefined, currentExit: exit }
    }
    case 'CatchAll': {
      if (exit.cause._tag === 'Sequential') {
        return { current: undefined, currentExit: died(new ResultTaskCauseError(exit.cause)) }
      }
      if (exit.cause._tag === 'Fail') {
        try {
          return { current: continuation.f(exit.cause.error), currentExit: undefined }
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      return { current: undefined, currentExit: exit }
    }
    default: {
      return { current: undefined, currentExit: exit }
    }
  }
}

interface InstructionStep {
  readonly nextCurrent: ResultTask<unknown, unknown, unknown> | undefined
  readonly exit: Exit<unknown, unknown> | undefined
}

// fallow-ignore-next-line complexity
const executeInstruction = async (
  instruction: TaskInstruction,
  continuations: TaskContinuation[],
  context: ResultTaskRuntimeContext,
): Promise<InstructionStep> => {
  switch (instruction._tag) {
    case 'FlatMap':
    case 'Map':
    case 'CatchAll': {
      continuations.push(instruction)
      return { nextCurrent: instruction.task, exit: undefined }
    }
    case 'Succeed': {
      return { nextCurrent: undefined, exit: success(instruction.value) }
    }
    case 'Fail': {
      return { nextCurrent: undefined, exit: failed(instruction.error) }
    }
    case 'Sync': {
      try {
        return { nextCurrent: undefined, exit: instruction.evaluate() }
      } catch (error) {
        return { nextCurrent: undefined, exit: died(error) }
      }
    }
    case 'Async': {
      try {
        return { nextCurrent: undefined, exit: await instruction.execute(context) }
      } catch (error) {
        return { nextCurrent: undefined, exit: died(error) }
      }
    }
    default: {
      return { nextCurrent: undefined, exit: undefined }
    }
  }
}

/**
 * A lazy, composable workflow that can succeed with `A` or fail with `E`.
 *
 * Constructing a `ResultTask` never runs its work. Use `runResult`, `runExit`, or `runPromise` at an
 * explicit application boundary to execute it.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ResultTask<out A, out E = never, out R = never> {
  readonly [ResultTaskTypeId]: {
    readonly success: (_: never) => A
    readonly error: (_: never) => E
    readonly requirements: (_: never) => R
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ResultTask<out A, out E = never, out R = never> extends Pipeable {
  declare private readonly typeWitness: {
    readonly success: A
    readonly error: E
    readonly requirements: R
  }

  private readonly instruction: TaskInstruction
  private readonly execute: ResultTaskExecutor

  private constructor(instructionOrExecute: TaskInstruction | ResultTaskExecutor) {
    super()
    this.instruction =
      typeof instructionOrExecute === 'function'
        ? { _tag: 'Async', execute: instructionOrExecute }
        : instructionOrExecute
    this.execute = (context) => ResultTask.runTaskLoop(this, context)
  }

  // fallow-ignore-next-line complexity
  private static async runTaskLoop(
    rootTask: ResultTask<unknown, unknown, unknown>,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<unknown, unknown>> {
    const continuations: TaskContinuation[] = []
    let current: ResultTask<unknown, unknown, unknown> | undefined = rootTask
    let currentExit: Exit<unknown, unknown> | undefined = undefined

    while (current !== undefined || continuations.length > 0) {
      if (current !== undefined) {
        if (context.signal.aborted) {
          return interrupted(context.signal)
        }

        // eslint-disable-next-line no-await-in-loop
        const step = await executeInstruction(current.instruction, continuations, context)
        current = step.nextCurrent
        currentExit = step.exit
      } else if (currentExit !== undefined) {
        const nextContinuation = continuations.pop()
        if (nextContinuation === undefined) {
          return currentExit
        }

        const resolvedExit =
          context.signal.aborted && currentExit._tag === 'Success'
            ? interrupted(context.signal)
            : currentExit

        const step = applyContinuation(nextContinuation, resolvedExit)
        current = step.current
        currentExit = step.currentExit
      }
    }

    return currentExit ?? success(undefined)
  }

  /** Creates a task that succeeds with `value` when it is executed. */
  public static succeed<A, E = never>(value: A): ResultTask<A, E> {
    return new ResultTask<A, E>({ _tag: 'Succeed', value })
  }

  /** Creates a task that fails with `error` when it is executed. */
  public static fail<const E>(error: E): ResultTask<never, E> {
    return new ResultTask<never, E>({ _tag: 'Fail', error })
  }

  /** Lifts an already computed Result into a lazy task. */
  public static fromResult<A, E>(result: Result<A, E>): ResultTask<A, E> {
    return new ResultTask<A, E>({
      _tag: 'Sync',
      evaluate: () => (result.isOk() ? success<A, E>(result.value) : failed<A, E>(result.error)),
    })
  }

  /** Creates a task for synchronous work. Thrown values are defects, not typed failures. */
  public static sync<A>(evaluate: () => A): ResultTask<A> {
    return new ResultTask<A>({ _tag: 'Sync', evaluate: () => success<A, never>(evaluate()) })
  }

  /** Creates a task that maps synchronous throws into the typed error channel. */
  public static try<A, E>(options: ResultTaskTryOptions<A, E>): ResultTask<A, E> {
    return new ResultTask<A, E>({
      _tag: 'Sync',
      evaluate: () => {
        try {
          return success<A, E>(options.try())
        } catch (error) {
          return failed<A, E>(options.catch(error))
        }
      },
    })
  }

  /** Creates a lazy task that preserves synchronous throws and promise rejections as unknown. */
  public static tryPromise<A>(run: (signal: AbortSignal) => PromiseLike<A>): ResultTask<A, unknown>
  /** Creates a lazy task that maps synchronous throws and promise rejections into `E`. */
  public static tryPromise<A, E>(options: ResultTaskTryPromiseOptions<A, E>): ResultTask<A, E>
  public static tryPromise<A, E>(
    options: ResultTaskTryPromiseOptions<A, E> | ((signal: AbortSignal) => PromiseLike<A>),
  ): ResultTask<A, unknown> {
    return new ResultTask<A, unknown>(async (context) => {
      try {
        return success<A, unknown>(
          await (typeof options === 'function'
            ? options(context.signal)
            : options.try(context.signal)),
        )
      } catch (error) {
        if (context.signal.aborted) return interrupted(context.signal)
        return failed<A, unknown>(typeof options === 'function' ? error : options.catch(error))
      }
    })
  }

  /**
   * Acquires lazily and registers release in the current scope. Release failures remain in the
   * scope requirement until `scoped` or a run boundary closes it; catchAll cannot erase them early.
   */
  public static acquireRelease<A, E, R, ReleaseError = never, ReleaseR = never>(
    options: ResultTaskAcquireReleaseOptions<A, E, R, ReleaseError, ReleaseR>,
  ): ResultTask<
    A,
    E,
    R | WithoutScope<ReleaseR> | ResultTaskScope<ReleaseError | ScopeError<ReleaseR>>
  > {
    return new ResultTask(async (context) => {
      const acquired = await options.acquire.execute(context)
      if (acquired._tag === 'Failure') return acquired

      // Register before checking interruption again: acquisition may have completed during abort.
      context.scope.add(async (exit) => {
        const scope = new TaskScope()
        const cleanupContext = withScope(context, scope, new AbortController().signal)
        let released: Exit<unknown, unknown> = success(undefined)
        try {
          released = await options.release(acquired.value as A, exit).execute(cleanupContext)
        } catch (error) {
          released = died(error)
        }
        return scope.close(released)
      })
      return acquired
    })
  }

  /** Closes a child scope before continuing, adding its deferred release errors to E. */
  public static scoped<A, E, R>(
    task: ResultTask<A, E, R>,
  ): ResultTask<A, E | ScopeError<R>, WithoutScope<R>> {
    return new ResultTask(async (context) => {
      const scope = new TaskScope()
      const exit = await task.execute(withScope(context, scope))
      return interruptSuccess(
        await scope.close(interruptSuccess(exit, context.signal)),
        context.signal,
      )
    })
  }

  /** Creates a service tag that can be requested with `yield*` inside `ResultTask.gen`. */
  public static service<Service, const Identifier extends string>(
    identifier: Identifier,
  ): ServiceTag<Identifier, Service> {
    return new ServiceTagValue<Identifier, Service>(identifier)
  }

  /** Builds a task from a generator and short-circuits on the first failed task. */
  public static gen<Yield, Return, Next>(
    body: () => Generator<Yield, Return, Next>,
  ): ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>> {
    return new ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>>(
      // fallow-ignore-next-line complexity
      async (context) => {
        try {
          const iterator = body()
          const executeTask: ResultTaskNestedExecutor = async (task) =>
            interruptSuccess(await task.execute(context), context.signal)
          const closeRuntime: ResultTaskCloseRuntime = {
            context,
            executeTask: (task) =>
              task.execute(withScope(context, context.scope, new AbortController().signal)),
          }
          let step = iterator.next()

          while (step.done === false) {
            if (isResultTaskYield(step.value)) {
              // eslint-disable-next-line no-await-in-loop
              const outcome = await executeTaskSafely(step.value.task, executeTask)

              if ('error' in outcome) {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  died<Return, GeneratorError<Yield>>(outcome.error),
                  closeRuntime,
                )
              }

              if (outcome._tag === 'Failure') {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  outcome as Exit<Return, GeneratorError<Yield>>,
                  closeRuntime,
                )
              }

              step = iterator.next(outcome as Next)
            } else if (isServiceYield(step.value)) {
              // eslint-disable-next-line no-await-in-loop
              const resolution = await resolveService(step.value.tag, context, executeTask)

              if (resolution._tag === 'Found') {
                step = iterator.next(resolution.value as Next)
              } else if (resolution._tag === 'Failure') {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  resolution.exit as Exit<Return, GeneratorError<Yield>>,
                  closeRuntime,
                )
              } else {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  died<Return, GeneratorError<Yield>>(
                    resolution._tag === 'Error'
                      ? resolution.error
                      : createMissingServiceError(step.value.tag.identifier),
                  ),
                  closeRuntime,
                )
              }
            } else {
              // eslint-disable-next-line no-await-in-loop
              return await closeGenerator(
                iterator,
                died<Return, GeneratorError<Yield>>(
                  new TypeError('ResultTask.gen yielded an unsupported value'),
                ),
                closeRuntime,
              )
            }
          }

          return success<Return, GeneratorError<Yield>>(step.value as Return)
        } catch (error) {
          return died<Return, GeneratorError<Yield>>(error)
        }
      },
    )
  }

  /** Maps the success value without executing the task. */
  public map<B>(f: (value: A) => B): ResultTask<B, E, R> {
    return new ResultTask<B, E, R>({
      _tag: 'Map',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (value: unknown) => unknown,
    })
  }

  /** Chains another task from the success value without executing either task immediately. */
  public flatMap<B, E2, R2>(f: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2> {
    return new ResultTask<B, E | E2, R | R2>({
      _tag: 'FlatMap',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (value: unknown) => ResultTask<unknown, unknown, unknown>,
    })
  }

  /** Alias for `flatMap`, matching the existing Resultar vocabulary. */
  public andThen<B, E2, R2>(f: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2> {
    return this.flatMap(f)
  }

  /**
   * Recovers a single typed failure. Composite causes become a Die(ResultTaskCauseError) so the
   * removed E cannot escape through runExit; the original tree remains available on error.cause.
   */
  public catchAll<B, E2, R2>(
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2> {
    return new ResultTask<A | B, E2, R | R2>({
      _tag: 'CatchAll',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (error: unknown) => ResultTask<unknown, unknown, unknown>,
    })
  }

  /** Enables `yield* task` inside `ResultTask.gen` workflows. */
  public *[Symbol.iterator](): Generator<ResultTaskYield<A, E, R>, A, Exit<A, E>> {
    const exit = yield { _tag: 'ResultTask', task: this }

    if (exit._tag === 'Success') {
      return exit.value
    }

    return throwDefect(new Error('ResultTask generator received a failed task result'))
  }

  /** Provides one required service and removes it from the task's requirements. */
  public static provideService<A, E, R, Tag extends Extract<R, AnyServiceTag>>(
    task: ResultTask<A, E, R>,
    tag: Tag,
    service: ServiceForTag<Tag>,
  ): ResultTask<A, E, Exclude<R, Tag>> {
    return new ResultTask<A, E, Exclude<R, Tag>>(async (context) => {
      const services = new Map([...context.services, [tag.key, service] as const])

      return task.execute(withServices(context, services)) as Promise<Exit<A, E>>
    })
  }

  /** Provides a lazy resolver for service tags that are not already in the environment. */
  public static provideServiceResolver<
    A,
    E,
    R,
    Resolvers extends ResultTaskServiceResolver<NoInfer<R>, unknown, unknown>,
  >(
    task: ResultTask<A, E, R>,
    resolvers: Resolvers,
  ): ResultTask<
    A,
    E | ResolverError<Resolvers>,
    WithoutServices<R> | ResolverRequirements<Resolvers>
  > {
    return new ResultTask(async (context) => {
      const providers = resolvers as Readonly<
        Record<string, () => ResultTask<unknown, unknown, unknown>>
      >
      return task.execute(
        withServiceResolver(context, (tag) =>
          Object.hasOwn(providers, tag.identifier)
            ? providers[tag.identifier]?.()
            : context.serviceResolver?.(tag),
        ),
      )
    })
  }

  /** Shares one in-flight execution and successful value. Failed executions can be retried. */
  public static memoize<A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R> {
    let pending: Promise<Exit<unknown, unknown>> | undefined = undefined
    return new ResultTask(async (context) => {
      pending ??= task.execute(context)
      const current = pending
      const exit = await current
      if (exit._tag === 'Failure' && pending === current) pending = undefined
      return exit
    })
  }

  /** Creates an explicit resource owner for adapters that manage long-lived scopes. */
  public static makeScope(): ResultTaskScopeOwner {
    const scope = new TaskScope()
    const controller = new AbortController()
    const pending = new Set<Promise<Exit<unknown, unknown>>>()
    let closing: Promise<Exit<unknown, unknown>> | undefined = undefined
    const owner: ResultTaskScopeOwner = {
      use: (task) =>
        new ResultTask(async (context) => {
          if (closing !== undefined)
            return died(new Error('Cannot execute in a closed ResultTask scope'))
          const attempt = new TaskScope()
          const execution = task
            .execute(withScope(context, attempt, controller.signal))
            .then(async (exit) => {
              if (exit._tag === 'Failure') return attempt.close(exit)
              scope.adopt(attempt)
              return exit
            })
          pending.add(execution)
          void execution.then(() => pending.delete(execution))
          return new Promise<Exit<unknown, unknown>>((resolve) => {
            const onAbort = (): void => {
              resolve(interrupted(context.signal))
            }
            context.signal.addEventListener('abort', onAbort, { once: true })
            if (context.signal.aborted) onAbort()
            void execution.then((exit) => {
              context.signal.removeEventListener('abort', onAbort)
              resolve(interruptSuccess(exit, context.signal))
            })
          })
        }),
      close: (exit = success(undefined)) =>
        new ResultTask(async () => {
          closing ??= (async () => {
            controller.abort('ResultTask scope closed')
            await Promise.all(pending)
            return scope.close(exit, true)
          })()
          const closed = await closing
          // The caller already carries the body outcome; return cleanup failures only.
          return closed._tag === 'Success' ? success(undefined) : closed
        }),
    }
    return owner
  }

  /** Provides all requirements using an object keyed by service identifier. */
  public static provideServices<A, E, R>(
    task: ResultTask<A, E, R>,
    services: ResultTaskServices<R>,
  ): ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>> {
    return new ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>(async (context) => {
      const namedServices = new Map(context.namedServices)

      for (const [identifier, service] of Object.entries(services)) {
        namedServices.set(identifier, service)
      }

      return task.execute(withNamedServices(context, namedServices)) as Promise<Exit<A, E>>
    })
  }

  /** Maps the success value using the canonical functional form. */
  public static map<A, E, R, B>(
    task: ResultTask<A, E, R>,
    f: (value: A) => B,
  ): ResultTask<B, E, R> {
    return task.map(f)
  }

  /** Chains a task using the canonical functional form. */
  public static flatMap<A, E, R, B, E2, R2>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<B, E2, R2>,
  ): ResultTask<B, E | E2, R | R2> {
    return task.flatMap(f)
  }

  /** Recovers from a typed failure using the canonical functional form. */
  public static catchAll<A, E, R, B, E2, R2>(
    task: ResultTask<A, E, R>,
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2> {
    return task.catchAll(f)
  }

  private static async runExitInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<Exit<A, E | ScopeError<R>>> {
    const signal = options?.signal ?? new AbortController().signal
    const suppliedServices =
      options !== undefined && 'services' in options ? options.services : undefined
    const namedServices = new Map(Object.entries(suppliedServices ?? {}))
    const scope = new TaskScope()
    const context: ResultTaskRuntimeContext = {
      namedServices,
      services: new Map(),
      serviceResolver: undefined,
      signal,
      scope,
    }
    const exit = await task.execute(context)
    return interruptSuccess(await scope.close(interruptSuccess(exit, signal)), signal) as Exit<
      A,
      E | ScopeError<R>
    >
  }

  private static async runResultInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<Result<A, E | ScopeError<R>>> {
    const exit = await ResultTask.runExitInternal(task, options)

    if (exit._tag === 'Success') {
      return ok(exit.value)
    }

    if (exit.cause._tag === 'Fail') {
      return err(exit.cause.error)
    }

    if (exit.cause._tag === 'Die') return throwDefect(exit.cause.defect)
    if (exit.cause._tag === 'Interrupt') {
      throw new AbortError('ResultTask execution interrupted', { cause: exit.cause.reason })
    }
    throw new ResultTaskCauseError(exit.cause)
  }

  /** Runs a task and preserves success, typed failure, and runtime defects in an `Exit`. */
  public static runExit<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: ResultTaskRunArguments<R>
  ): Promise<Exit<A, E | ScopeError<R>>> {
    return ResultTask.runExitInternal(task, args[0])
  }

  /** Returns single typed failures as Err; rejects defects, interruption, and composite causes. */
  public static runResult<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: ResultTaskRunArguments<R>
  ): Promise<Result<A, E | ScopeError<R>>> {
    return ResultTask.runResultInternal(task, args[0])
  }

  /** Runs a task and returns the success value, rejecting on typed failures or defects. */
  public static async runPromise<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: ResultTaskRunArguments<R>
  ): Promise<A> {
    const result = await ResultTask.runResultInternal(task, args[0])
    return result.unwrapOrThrow()
  }
}
