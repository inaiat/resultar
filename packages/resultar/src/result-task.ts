import { Pipeable } from './pipe.js'
import type { Result } from './result.js'
import { err, ok } from './result.js'
import type { ResultAsync } from './result-async.js'
import { createResultAsync } from './result-async-adapter.js'
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

/** Type identifier symbol for nominal `ServiceTag` branding. */
export const ServiceTagTypeId: unique symbol = Symbol.for('resultar/ServiceTag')

/** Type identifier symbol for nominal `ResultTask` yieldable objects. */
export const ResultTaskYieldTypeId: unique symbol = Symbol.for('resultar/ResultTaskYield')

/** Error thrown as a Die cause when a requested service is not provided in the environment. */
export class MissingServiceError extends Error {
  public readonly serviceIdentifier: string

  public constructor(serviceIdentifier: string) {
    super(`Missing ResultTask service: ${serviceIdentifier}`)
    this.name = 'MissingServiceError'
    this.serviceIdentifier = serviceIdentifier
  }
}

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

/** Handlers for matching both success and failure cases of a ResultTask. */
export type ResultTaskMatchOptions<A, E, B, C = B> =
  | { readonly onSuccess: (value: A) => B; readonly onFailure: (error: E) => C }
  | { readonly ok: (value: A) => B; readonly err: (error: E) => C }

/** A service that can be requested from a `ResultTask.gen` workflow. */
export interface ServiceTag<Identifier extends string, Service> {
  readonly [ServiceTagTypeId]: typeof ServiceTagTypeId
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
  readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
  readonly _tag: 'ResultTask'
  readonly task: ResultTask<A, E, R>
}

interface ResultTaskServiceYield<Tag extends AnyServiceTag> {
  readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
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
  : Yield extends { readonly error: infer E; readonly isErr: unknown }
    ? E
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

/** Returns true if a value is a nominal `ServiceTag`. */
export const isServiceTag = (value: unknown): value is ServiceTag<string, unknown> =>
  isRecord(value) &&
  ((value as Record<symbol, unknown>)[ServiceTagTypeId] === ServiceTagTypeId ||
    (value['_tag'] === 'ServiceTag' && typeof value['identifier'] === 'string'))

/** Returns true if a value is a `ResultTask` instance. */
export const isResultTask = (value: unknown): value is ResultTask<unknown, unknown, unknown> =>
  isRecord(value) &&
  (value instanceof ResultTask ||
    (value as Record<symbol, unknown>)[ResultTaskTypeId] !== undefined)

const isResultTaskYield = (value: unknown): value is ResultTaskYield<unknown, unknown, unknown> =>
  isRecord(value) && value['_tag'] === 'ResultTask' && isResultTask(value['task'])

const isServiceYield = (value: unknown): value is ResultTaskServiceYield<AnyServiceTag> =>
  isRecord(value) && value['_tag'] === 'Service' && isServiceTag(value['tag'])

const isErrResult = (
  value: unknown,
): value is { readonly error: unknown; readonly isErr: () => boolean } =>
  isRecord(value) &&
  'error' in value &&
  typeof (value as { isErr?: unknown }).isErr === 'function' &&
  (value as { isErr: () => boolean }).isErr()

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
              : new MissingServiceError(step.value.tag.identifier),
          )
          step = iterator.return(undefined as Return)
        }
      } else if (isErrResult(step.value)) {
        finalExit = failed<Return, E>(step.value.error as E)
        step = iterator.return(undefined as Return)
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
  public readonly [ServiceTagTypeId]: typeof ServiceTagTypeId = ServiceTagTypeId
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
    const service = yield {
      [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
      _tag: 'Service',
      tag: this,
    }
    return service
  }
}

/** Creates a service tag that can be requested with `yield*` inside `ResultTask.gen`. */
export const serviceTag = <Service, const Identifier extends string = string>(
  identifier: Identifier,
): ServiceTag<Identifier, Service> => new ServiceTagValue<Identifier, Service>(identifier)

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
      readonly _tag: 'MapError'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (error: unknown) => unknown
    }
  | {
      readonly _tag: 'Tap'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (value: unknown) => unknown
    }
  | {
      readonly _tag: 'TapError'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (error: unknown) => unknown
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
  | { readonly _tag: 'MapError'; readonly f: (error: unknown) => unknown }
  | { readonly _tag: 'Tap'; readonly f: (value: unknown) => unknown }
  | { readonly _tag: 'TapError'; readonly f: (error: unknown) => unknown }
  | {
      readonly _tag: 'CatchAll'
      readonly f: (error: unknown) => ResultTask<unknown, unknown, unknown>
    }

interface ContinuationStep {
  readonly current: ResultTask<unknown, unknown, unknown> | undefined
  readonly currentExit: Exit<unknown, unknown> | undefined
}

// fallow-ignore-next-line complexity
const applySuccessContinuation = (
  continuation: TaskContinuation,
  exit: Exit<unknown, unknown> & { readonly _tag: 'Success' },
): ContinuationStep => {
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
    case 'Tap': {
      try {
        const res = continuation.f(exit.value)
        return ResultTask.toTapContinuationStep(res, () => ResultTask.succeed(exit.value), exit)
      } catch (error) {
        return { current: undefined, currentExit: died(error) }
      }
    }
    case 'MapError':
    case 'TapError':
    case 'CatchAll': {
      return { current: undefined, currentExit: exit }
    }
    default: {
      return { current: undefined, currentExit: exit }
    }
  }
}

// fallow-ignore-next-line complexity
const applyFailureContinuation = (
  continuation: TaskContinuation,
  exit: Exit<unknown, unknown> & { readonly _tag: 'Failure' },
): ContinuationStep => {
  switch (continuation._tag) {
    case 'Map':
    case 'FlatMap':
    case 'Tap': {
      return { current: undefined, currentExit: exit }
    }
    case 'MapError': {
      if (exit.cause._tag === 'Fail') {
        try {
          return { current: undefined, currentExit: failed(continuation.f(exit.cause.error)) }
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      return { current: undefined, currentExit: exit }
    }
    case 'TapError': {
      if (exit.cause._tag === 'Fail') {
        try {
          const failError = exit.cause.error
          const res = continuation.f(failError)
          return ResultTask.toTapContinuationStep(res, () => ResultTask.fail(failError), exit)
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
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

const applyContinuation = (
  continuation: TaskContinuation,
  exit: Exit<unknown, unknown>,
): ContinuationStep =>
  exit._tag === 'Success'
    ? applySuccessContinuation(continuation, exit)
    : applyFailureContinuation(continuation, exit)

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
    case 'MapError':
    case 'Tap':
    case 'TapError':
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

  /** @internal */
  public static toTapContinuationStep(
    res: unknown,
    onSuccess: () => ResultTask<unknown, unknown, unknown>,
    passThroughExit: Exit<unknown, unknown>,
  ): ContinuationStep {
    if (res instanceof ResultTask) {
      return { current: res.flatMap(onSuccess), currentExit: undefined }
    }
    if (
      typeof res === 'object' &&
      res !== null &&
      typeof (res as Promise<unknown>).then === 'function'
    ) {
      const promiseTask = new ResultTask(async () => {
        try {
          await (res as Promise<unknown>)
          return success(undefined)
        } catch (error) {
          return died(error)
        }
      })
      return { current: promiseTask.flatMap(onSuccess), currentExit: undefined }
    }
    return { current: undefined, currentExit: passThroughExit }
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
                      : new MissingServiceError(step.value.tag.identifier),
                  ),
                  closeRuntime,
                )
              }
            } else if (isErrResult(step.value)) {
              // eslint-disable-next-line no-await-in-loop
              return await closeGenerator(
                iterator,
                failed<Return, GeneratorError<Yield>>(step.value.error as GeneratorError<Yield>),
                closeRuntime,
              )
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

  /** Maps the error value without executing the task. */
  public mapError<E2>(f: (error: E) => E2): ResultTask<A, E2, R> {
    return new ResultTask<A, E2, R>({
      _tag: 'MapError',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (error: unknown) => unknown,
    })
  }

  /**
   * Executes a side effect on the success value without modifying it.
   * If the callback returns a `ResultTask`, its requirements and errors are merged.
   */
  public tap<E2 = never, R2 = never>(
    f: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2> {
    return new ResultTask<A, E | E2, R | R2>({
      _tag: 'Tap',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (value: unknown) => unknown,
    })
  }

  /**
   * Executes a side effect on the error value without modifying it.
   * If the callback returns a `ResultTask`, its requirements and errors are merged.
   */
  public tapError<E2 = never, R2 = never>(
    f: (error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2> {
    return new ResultTask<A, E | E2, R | R2>({
      _tag: 'TapError',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (error: unknown) => unknown,
    })
  }

  /** Replaces the success value with a constant. */
  public as<B>(value: B): ResultTask<B, E, R> {
    return this.map(() => value)
  }

  /**
   * Transforms both success and failure cases into a single value type.
   */
  public match<B, C = B>(
    handlers: ResultTaskMatchOptions<A, E, B, C>,
  ): ResultTask<B | C, never, R> {
    const onSuccess = 'onSuccess' in handlers ? handlers.onSuccess : handlers.ok
    const onFailure = 'onFailure' in handlers ? handlers.onFailure : handlers.err
    return this.map(onSuccess).catchAll((error) => ResultTask.succeed(onFailure(error)))
  }

  /** Converts this ResultTask into an eagerly started ResultAsync using the standard runtime. */
  public toResultAsync(this: ResultTask<A, E, never>): ResultAsync<A, E> {
    return ResultTask.toResultAsync(this)
  }

  /** Provides one required service and removes it from the task's requirements. */
  public provideService<Tag extends Extract<R, AnyServiceTag>>(
    tag: Tag,
    service: ServiceForTag<Tag>,
  ): ResultTask<A, E, Exclude<R, Tag>> {
    return ResultTask.provideService(this, tag, service)
  }

  /** Provides all requirements using an object keyed by service identifier. */
  public provideServices(
    services: ResultTaskServices<R>,
  ): ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>> {
    return ResultTask.provideServices(this, services)
  }

  /** Provides a lazy resolver for service tags that are not already in the environment. */
  public provideServiceResolver<
    Resolvers extends ResultTaskServiceResolver<NoInfer<R>, unknown, unknown>,
  >(
    resolvers: Resolvers,
  ): ResultTask<
    A,
    E | ResolverError<Resolvers>,
    WithoutServices<R> | ResolverRequirements<Resolvers>
  > {
    return ResultTask.provideServiceResolver(this, resolvers)
  }

  /** Enables `yield* task` inside `ResultTask.gen` workflows. */
  public *[Symbol.iterator](): Generator<ResultTaskYield<A, E, R>, A, Exit<A, E>> {
    const exit = yield {
      [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
      _tag: 'ResultTask',
      task: this,
    }

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
  ): ResultTask<A, E, Exclude<R, Tag>>
  public static provideService<Tag extends AnyServiceTag>(
    tag: Tag,
    service: ServiceForTag<Tag>,
  ): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, Exclude<R, Tag>>
  public static provideService<A, E, R, Tag extends Extract<R, AnyServiceTag>>(
    taskOrTag: ResultTask<A, E, R> | Tag,
    tagOrService: Tag | ServiceForTag<Tag>,
    maybeService?: ServiceForTag<Tag>,
  ):
    | ResultTask<A, E, Exclude<R, Tag>>
    | (<A2, E2, R2>(task: ResultTask<A2, E2, R2>) => ResultTask<A2, E2, Exclude<R2, Tag>>) {
    if (isResultTask(taskOrTag)) {
      if (maybeService === undefined) {
        throw new TypeError('ResultTask.provideService requires a service implementation')
      }
      const task = taskOrTag
      const tag = tagOrService as Tag
      const service = maybeService
      return new ResultTask<A, E, Exclude<R, Tag>>(async (context) => {
        const services = new Map([...context.services, [tag.key, service] as const])
        const namedServices = new Map([
          ...context.namedServices,
          [tag.identifier, service] as const,
        ])

        return task.execute(
          withNamedServices(withServices(context, services), namedServices),
        ) as Promise<Exit<A, E>>
      })
    }
    const tag = taskOrTag as Tag
    const service = tagOrService as ServiceForTag<Tag>
    return ((task: ResultTask<unknown, unknown, unknown>) =>
      ResultTask.provideService(
        task as ResultTask<unknown, unknown, Extract<Tag, AnyServiceTag>>,
        tag as Extract<Tag, AnyServiceTag>,
        service,
      )) as unknown as <A2, E2, R2>(
      task: ResultTask<A2, E2, R2>,
    ) => ResultTask<A2, E2, Exclude<R2, Tag>>
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
  ): ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>
  public static provideServices<R>(
    services: ResultTaskServices<R>,
  ): <A, E>(task: ResultTask<A, E, R>) => ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>
  public static provideServices<A, E, R>(
    taskOrServices: ResultTask<A, E, R> | ResultTaskServices<R>,
    maybeServices?: ResultTaskServices<R>,
  ):
    | ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>
    | (<A2, E2>(
        task: ResultTask<A2, E2, R>,
      ) => ResultTask<A2, E2, Extract<R, ResultTaskScope<unknown>>>) {
    if (isResultTask(taskOrServices)) {
      if (maybeServices === undefined) {
        throw new TypeError('ResultTask.provideServices requires a services object')
      }
      const task = taskOrServices
      const services = maybeServices
      return new ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>(async (context) => {
        const namedServices = new Map(context.namedServices)

        for (const [identifier, service] of Object.entries(services)) {
          namedServices.set(identifier, service)
        }

        return task.execute(withNamedServices(context, namedServices)) as Promise<Exit<A, E>>
      })
    }
    const services = taskOrServices
    return (task) => ResultTask.provideServices(task, services)
  }

  /** Maps the success value using the canonical functional form or curried for `pipe`. */
  public static map<A, E, R, B>(task: ResultTask<A, E, R>, f: (value: A) => B): ResultTask<B, E, R>
  public static map<A, B>(
    f: (value: A) => B,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E, R>
  public static map<A, E, R, B>(
    taskOrF: ResultTask<A, E, R> | ((value: A) => B),
    f?: (value: A) => B,
  ): ResultTask<B, E, R> | (<E2, R2>(task: ResultTask<A, E2, R2>) => ResultTask<B, E2, R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.map(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.map requires a mapping function')
    }
    return taskOrF.map(f)
  }

  /** Maps the error value using the canonical functional form or curried for `pipe`. */
  public static mapError<A, E, R, E2>(
    task: ResultTask<A, E, R>,
    f: (error: E) => E2,
  ): ResultTask<A, E2, R>
  public static mapError<E, E2>(
    f: (error: E) => E2,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E2, R>
  public static mapError<A, E, R, E2>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => E2),
    f?: (error: E) => E2,
  ): ResultTask<A, E2, R> | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2, E2, R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.mapError(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.mapError requires an error mapping function')
    }
    return taskOrF.mapError(f)
  }

  /** Chains a task using the canonical functional form or curried for `pipe`. */
  public static flatMap<A, E, R, B, E2, R2>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<B, E2, R2>,
  ): ResultTask<B, E | E2, R | R2>
  public static flatMap<A, B, E2, R2>(
    f: (value: A) => ResultTask<B, E2, R2>,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E | E2, R | R2>
  public static flatMap<A, E, R, B, E2, R2>(
    taskOrF: ResultTask<A, E, R> | ((value: A) => ResultTask<B, E2, R2>),
    f?: (value: A) => ResultTask<B, E2, R2>,
  ):
    | ResultTask<B, E | E2, R | R2>
    | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.flatMap(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.flatMap requires a continuation function')
    }
    return taskOrF.flatMap(f)
  }

  /** Alias for `flatMap`, matching the existing Resultar vocabulary. */
  public static andThen<A, E, R, B, E2, R2>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<B, E2, R2>,
  ): ResultTask<B, E | E2, R | R2>
  public static andThen<A, B, E2, R2>(
    f: (value: A) => ResultTask<B, E2, R2>,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E | E2, R | R2>
  public static andThen<A, E, R, B, E2, R2>(
    taskOrF: ResultTask<A, E, R> | ((value: A) => ResultTask<B, E2, R2>),
    f?: (value: A) => ResultTask<B, E2, R2>,
  ):
    | ResultTask<B, E | E2, R | R2>
    | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.flatMap(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.andThen requires a continuation function')
    }
    return taskOrF.flatMap(f)
  }

  /** Recovers from a typed failure using the canonical functional form or curried for `pipe`. */
  public static catchAll<A, E, R, B, E2, R2>(
    task: ResultTask<A, E, R>,
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2>
  public static catchAll<E, B, E2, R2>(
    f: (error: E) => ResultTask<B, E2, R2>,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A | B, E2, R | R2>
  public static catchAll<A, E, R, B, E2, R2>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => ResultTask<B, E2, R2>),
    f?: (error: E) => ResultTask<B, E2, R2>,
  ):
    | ResultTask<A | B, E2, R | R2>
    | (<A2, R3>(task: ResultTask<A2, E, R3>) => ResultTask<A2 | B, E2, R3 | R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.catchAll(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.catchAll requires a recovery function')
    }
    return taskOrF.catchAll(f)
  }

  /** Executes a side effect on the success value using the canonical functional form or curried for `pipe`. */
  public static tap<A, E, R, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2>
  public static tap<A, E2 = never, R2 = never>(
    f: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2, R | R2>
  public static tap<A, E, R, E2 = never, R2 = never>(
    taskOrF:
      | ResultTask<A, E, R>
      | ((value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void),
    f?: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ):
    | ResultTask<A, E | E2, R | R2>
    | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<A, E3 | E2, R3 | R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.tap(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.tap requires a side-effect function')
    }
    return taskOrF.tap(f)
  }

  /** Executes a side effect on the error value using the canonical functional form or curried for `pipe`. */
  public static tapError<A, E, R, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2>
  public static tapError<E, E2 = never, R2 = never>(
    f: (error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2, R | R2>
  public static tapError<A, E, R, E2 = never, R2 = never>(
    taskOrF:
      | ResultTask<A, E, R>
      | ((error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void),
    f?: (error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ):
    | ResultTask<A, E | E2, R | R2>
    | (<A3, R3>(task: ResultTask<A3, E, R3>) => ResultTask<A3, E | E2, R3 | R2>) {
    if (typeof taskOrF === 'function') {
      return (task) => task.tapError(taskOrF)
    }
    if (f === undefined) {
      throw new TypeError('ResultTask.tapError requires an error side-effect function')
    }
    return taskOrF.tapError(f)
  }

  /** Replaces the success value with a constant using the canonical functional form or curried for `pipe`. */
  public static as<A, E, R, B>(task: ResultTask<A, E, R>, value: B): ResultTask<B, E, R>
  public static as<B>(value: B): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E, R>
  public static as<A, E, R, B>(
    taskOrValue: ResultTask<A, E, R> | B,
    value?: B,
  ): ResultTask<B, E, R> | (<A2, E2, R2>(task: ResultTask<A2, E2, R2>) => ResultTask<B, E2, R2>) {
    if (taskOrValue instanceof ResultTask) {
      if (value === undefined) {
        throw new TypeError('ResultTask.as requires a replacement value')
      }
      return taskOrValue.as(value)
    }
    return (task) => task.as(taskOrValue as B)
  }

  /** Matches both success and error cases using the canonical functional form or curried for `pipe`. */
  public static match<A, E, R, B, C = B>(
    task: ResultTask<A, E, R>,
    handlers: ResultTaskMatchOptions<A, E, B, C>,
  ): ResultTask<B | C, never, R>
  public static match<A, E, B, C = B>(
    handlers: ResultTaskMatchOptions<A, E, B, C>,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<B | C, never, R>
  public static match<A, E, R, B, C = B>(
    taskOrHandlers: ResultTask<A, E, R> | ResultTaskMatchOptions<A, E, B, C>,
    handlers?: ResultTaskMatchOptions<A, E, B, C>,
  ):
    | ResultTask<B | C, never, R>
    | (<R2>(task: ResultTask<A, E, R2>) => ResultTask<B | C, never, R2>) {
    if (taskOrHandlers instanceof ResultTask) {
      if (handlers === undefined) {
        throw new TypeError('ResultTask.match requires match handlers')
      }
      return taskOrHandlers.match(handlers)
    }
    return (task) => task.match(taskOrHandlers)
  }

  /**
   * Eagerly executes a ResultTask using the standard runtime and returns a ResultAsync.
   */
  public static toResultAsync<A, E>(task: ResultTask<A, E, never>): ResultAsync<A, E> {
    return createResultAsync<ResultAsync<A, E>>(ResultTask.runResult(task))
  }

  /**
   * Captures an existing ResultAsync or creates a lazy task from a ResultAsync factory.
   */
  public static fromResultAsync<A, E>(
    asyncResultOrFactory: ResultAsync<A, E> | ((signal: AbortSignal) => ResultAsync<A, E>),
  ): ResultTask<A, E> {
    return new ResultTask(async (context) => {
      if (context.signal.aborted) {
        return interrupted(context.signal)
      }

      try {
        const asyncResult =
          typeof asyncResultOrFactory === 'function'
            ? asyncResultOrFactory(context.signal)
            : asyncResultOrFactory
        const result = await asyncResult

        if (context.signal.aborted) {
          return interrupted(context.signal)
        }

        return result.isOk() ? success(result.value) : failed(result.error)
      } catch (error) {
        return died(error)
      }
    })
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
