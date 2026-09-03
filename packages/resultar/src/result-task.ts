import { Pipeable } from './pipe.js'
import type { Result } from './result.js'
import { err, ok } from './result.js'

/** A failure cause produced by a `ResultTask` execution. */
export type Cause<E> =
  | { readonly _tag: 'Fail'; readonly error: E }
  | { readonly _tag: 'Die'; readonly defect: unknown }

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

/** Options for running a `ResultTask` with an optional signal and its required services. */
export type ResultTaskRunOptions<R = never> = { readonly signal?: AbortSignal } & ([R] extends [
  never,
]
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
type ResultTaskRuntimeServices = ReadonlyMap<symbol, unknown>

interface ResultTaskRuntimeContext {
  readonly namedServices: ReadonlyMap<string, unknown>
  readonly services: ResultTaskRuntimeServices
  readonly signal: AbortSignal
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

type ResultTaskRunArguments<R> = [R] extends [never]
  ? [options?: ResultTaskRunOptions<R>]
  : [options: ResultTaskRunOptions<R>]

const success = <A, E>(value: A): Exit<A, E> => ({ _tag: 'Success', value })

const failure = <A, E>(cause: Cause<E>): Exit<A, E> => ({ _tag: 'Failure', cause })

const failed = <A, E>(error: E): Exit<A, E> => failure({ _tag: 'Fail', error })

const died = <A, E>(defect: unknown): Exit<A, E> => failure({ _tag: 'Die', defect })

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

const lookupService = <Service>(
  tag: AnyServiceTag,
  context: ResultTaskRuntimeContext,
): Service | undefined => {
  if (context.services.has(tag.key)) {
    return context.services.get(tag.key) as Service
  }

  return context.namedServices.get(tag.identifier) as Service | undefined
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
        const service = lookupService(step.value.tag, runtime.context)

        if (service === undefined) {
          finalExit = died<Return, E>(createMissingServiceError(step.value.tag.identifier))
          step = iterator.return(undefined as Return)
        } else {
          step = iterator.next(service as Next)
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
  namedServices: context.namedServices,
  services,
  signal: context.signal,
})

const withNamedServices = (
  context: ResultTaskRuntimeContext,
  namedServices: ReadonlyMap<string, unknown>,
): ResultTaskRuntimeContext => ({
  namedServices,
  services: context.services,
  signal: context.signal,
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

/**
 * A lazy, composable workflow that can succeed with `A` or fail with `E`.
 *
 * Constructing a `ResultTask` never runs its work. Use `runResult`, `runExit`, or `runPromise` at an
 * explicit application boundary to execute it.
 */
export class ResultTask<A, E = never, R = never> extends Pipeable {
  private readonly execute: ResultTaskExecutor

  private constructor(execute: ResultTaskExecutor) {
    super()
    this.execute = execute
  }

  declare private readonly typeWitness: {
    readonly success: A
    readonly error: E
    readonly requirements: R
  }

  /** Creates a task that succeeds with `value` when it is executed. */
  public static succeed<A, E = never>(value: A): ResultTask<A, E> {
    return new ResultTask<A, E>(() => Promise.resolve(success<A, E>(value)))
  }

  /** Creates a task that fails with `error` when it is executed. */
  public static fail<const E>(error: E): ResultTask<never, E> {
    return new ResultTask<never, E>(() => Promise.resolve(failed<never, E>(error)))
  }

  /** Lifts an already computed Result into a lazy task. */
  public static fromResult<A, E>(result: Result<A, E>): ResultTask<A, E> {
    return new ResultTask<A, E>(() =>
      Promise.resolve(result.isOk() ? success<A, E>(result.value) : failed<A, E>(result.error)),
    )
  }

  /** Creates a task for synchronous work. Thrown values are defects, not typed failures. */
  public static sync<A>(evaluate: () => A): ResultTask<A> {
    return new ResultTask<A>(() => Promise.resolve(success<A, never>(evaluate())))
  }

  /** Creates a task that maps synchronous throws into the typed error channel. */
  public static try<A, E>(options: ResultTaskTryOptions<A, E>): ResultTask<A, E> {
    return new ResultTask<A, E>(() => {
      try {
        return Promise.resolve(success<A, E>(options.try()))
      } catch (error) {
        return Promise.resolve(failed<A, E>(options.catch(error)))
      }
    })
  }

  /** Creates a lazy task that maps synchronous throws and promise rejections into `E`. */
  public static tryPromise<A, E>(options: ResultTaskTryPromiseOptions<A, E>): ResultTask<A, E> {
    return new ResultTask<A, E>(async (context) => {
      try {
        return success<A, E>(await options.try(context.signal))
      } catch (error) {
        return failed<A, E>(options.catch(error))
      }
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
      async (context) => {
        try {
          const iterator = body()
          const executeTask: ResultTaskNestedExecutor = (task) => task.execute(context)
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
                  { context, executeTask },
                )
              }

              if (outcome._tag === 'Failure') {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  outcome as Exit<Return, GeneratorError<Yield>>,
                  { context, executeTask },
                )
              }

              step = iterator.next(outcome as Next)
            } else if (isServiceYield(step.value)) {
              const service = lookupService(step.value.tag, context)

              if (service === undefined) {
                // eslint-disable-next-line no-await-in-loop
                return await closeGenerator(
                  iterator,
                  died<Return, GeneratorError<Yield>>(
                    createMissingServiceError(step.value.tag.identifier),
                  ),
                  { context, executeTask },
                )
              }

              step = iterator.next(service as Next)
            } else {
              // eslint-disable-next-line no-await-in-loop
              return await closeGenerator(
                iterator,
                died<Return, GeneratorError<Yield>>(
                  new TypeError('ResultTask.gen yielded an unsupported value'),
                ),
                { context, executeTask },
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
    return new ResultTask<B, E, R>(async (context) => {
      const exit = (await this.execute(context)) as Exit<A, E>

      if (exit._tag === 'Failure') {
        return exit as Exit<B, E>
      }

      return success<B, E>(f(exit.value))
    })
  }

  /** Chains another task from the success value without executing either task immediately. */
  public flatMap<B, E2, R2>(f: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2> {
    return new ResultTask<B, E | E2, R | R2>(async (context) => {
      const exit = (await this.execute(context)) as Exit<A, E>

      if (exit._tag === 'Failure') {
        return exit as Exit<B, E | E2>
      }

      return f(exit.value).execute(context) as Promise<Exit<B, E | E2>>
    })
  }

  /** Alias for `flatMap`, matching the existing Resultar vocabulary. */
  public andThen<B, E2, R2>(f: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2> {
    return this.flatMap(f)
  }

  /** Recovers from a typed failure without recovering from a runtime defect. */
  public catchAll<B, E2, R2>(
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2> {
    return new ResultTask<A | B, E2, R | R2>(async (context) => {
      const exit = (await this.execute(context)) as Exit<A, E>

      if (exit._tag === 'Success') {
        return exit as Exit<A | B, E2>
      }

      if (exit.cause._tag === 'Die') {
        return exit as Exit<A | B, E2>
      }

      return f(exit.cause.error).execute(context) as Promise<Exit<A | B, E2>>
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

  /** Provides all requirements using an object keyed by service identifier. */
  public static provideServices<A, E, R>(
    task: ResultTask<A, E, R>,
    services: ResultTaskServices<R>,
  ): ResultTask<A, E> {
    return new ResultTask<A, E>(async (context) => {
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
  ): Promise<Exit<A, E>> {
    const signal = options?.signal ?? new AbortController().signal
    const suppliedServices =
      options !== undefined && 'services' in options ? options.services : undefined
    const namedServices = new Map(Object.entries(suppliedServices ?? {}))
    const context: ResultTaskRuntimeContext = { namedServices, services: new Map(), signal }

    try {
      return (await task.execute(context)) as Exit<A, E>
    } catch (error) {
      return died<A, E>(error)
    }
  }

  private static async runResultInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<Result<A, E>> {
    const exit = await ResultTask.runExitInternal(task, options)

    if (exit._tag === 'Success') {
      return ok(exit.value)
    }

    if (exit.cause._tag === 'Fail') {
      return err(exit.cause.error)
    }

    return throwDefect(exit.cause.defect)
  }

  /** Runs a task and preserves success, typed failure, and runtime defects in an `Exit`. */
  public static runExit<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: ResultTaskRunArguments<R>
  ): Promise<Exit<A, E>> {
    return ResultTask.runExitInternal(task, args[0])
  }

  /** Runs a task and returns a Result, rejecting only when a runtime defect occurs. */
  public static runResult<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: ResultTaskRunArguments<R>
  ): Promise<Result<A, E>> {
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
