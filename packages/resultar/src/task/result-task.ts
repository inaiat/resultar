import { dual } from '../core/dual.js'
import {
  callTaggedHandler,
  hasTag,
  isTaggedHandlerMatch,
  matchTaggedOr,
} from '../tagged/tagged-match.js'
import type {
  CatchReasonHandlerResult,
  CatchReasonHandlers,
  CatchTagHandlerResult,
  CoveredHandlerKeys,
  CatchTagHandlers,
  ErrorForTag,
  ExcludeReasonTag,
  ExcludeTag,
  MatchTagHandlerResult,
  MatchTagHandlers,
  PartialMatchTagHandlers,
  ReasonForTag,
  ReasonTagsOf,
  ReasonsOf,
  RemainingMatchTagErrors,
  TagsOf,
  TagsWithReasonOf,
} from '../tagged/tagged-types.js'
import { type FnPipe, Pipeable, runFnPipe } from '../core/pipe.js'
import { createEmptyResultsCollectionError, err, ok, type Result } from '../result/result.js'
import type { ResultAsync } from '../result/result-async.js'
import { createResultAsync } from '../result/result-async-adapter.js'
import { AbortError } from '../core/abort-error.js'
import { TaskScope } from './scope.js'
import { Cause } from './cause.js'
import { Clock } from './task-clock.js'
import type { TaskClock } from './task-clock.js'
import {
  isRetryPolicy,
  observeRetry,
  retryContext,
  retryPolicyDelay,
  validateRetryPolicy,
} from '../core/retry.js'
import type { RetryContext, RetryPolicy } from '../core/retry.js'
import {
  createScheduling,
  forkScheduling,
  recoverScheduling,
  schedulerCheckpoint,
} from './task-scheduler.js'
import type { TaskScheduler, TaskScheduling } from './task-scheduler.js'
import { isCleanupCause, markCleanupCause } from './cleanup-cause.js'
import type { FiberHandle } from './fiber.js'
import { createFiberHandle, registerFiberTaskFactory, startFiber } from './fiber-runtime.js'
import type { FiberTaskContext, RuntimeFiber } from './fiber-runtime.js'
import { registerSemaphoreTaskFactory, Semaphore } from './semaphore.js'
import {
  combineExits,
  died,
  failed,
  failure,
  interrupted,
  interruptSuccess,
  success,
} from './exit.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { detachedPromise } from './promise-interruption.js'

export { Fiber } from './fiber.js'
export type { FiberHandle } from './fiber.js'
export { Semaphore } from './semaphore.js'

/** Concurrency defaults to one; unbounded execution must be requested explicitly. */
export interface ResultTaskConcurrencyOptions {
  readonly concurrency?: number | 'unbounded'
}

/** Controls whether `zip` evaluates both tasks sequentially (default) or concurrently. */
export interface ResultTaskZipOptions {
  readonly concurrent?: boolean
}

/** Retries count additional attempts; only simple typed failures are retried. */
export interface ResultTaskRetryOptions<E> {
  readonly times: number
  readonly delayMs?: number | ((retry: number, error: E) => number)
  readonly backoff?: number
  readonly jittered?: boolean
  readonly while?: (error: E, retry: number) => boolean
}

type ResultTaskRetryInput<E> = ResultTaskRetryOptions<E> | RetryPolicy<E>

/** Rejection used when a simplified boundary cannot represent multiple failures. */
export class ResultTaskCauseError extends Error {
  public override readonly cause!: Cause<unknown>

  public constructor(cause: Cause<unknown>) {
    super('ResultTask execution failed with multiple causes')
    this.name = 'ResultTaskCauseError'
    Object.defineProperty(this, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    })
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
  | { readonly ok: (value: A) => B; readonly err: (error: E) => C }
  | { readonly ok: (value: A) => B; readonly error: (error: E) => C }
  | { readonly onSuccess: (value: A) => B; readonly onFailure: (error: E) => C }

const taskSuccessHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((value: A) => B) => ('onSuccess' in handlers ? handlers.onSuccess : handlers.ok)

const taskFailureHandler = <A, E, B, C>(
  handlers: ResultTaskMatchOptions<A, E, B, C>,
): ((error: E) => C) => {
  if ('onFailure' in handlers) return handlers.onFailure
  if ('error' in handlers) return handlers.error
  return handlers.err
}

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

type EliminateProvidedServices<R, Services> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Services
    ? Services[R['identifier']] extends ServiceForTag<R>
      ? never
      : R
    : R
  : R

type EliminateResolvedServices<R, Resolvers> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Resolvers
    ? Resolvers[R['identifier']] extends () => ResultTask<infer S, unknown, unknown>
      ? S extends ServiceForTag<R>
        ? never
        : R
      : R
    : R
  : R

type IncompatibleProvidedServices<R, Services> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Services
    ? Services[R['identifier']] extends ServiceForTag<R>
      ? never
      : R['identifier']
    : never
  : never

type IncompatibleResolvedServices<R, Resolvers> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Resolvers
    ? Resolvers[R['identifier']] extends () => ResultTask<infer S, unknown, unknown>
      ? S extends ServiceForTag<R>
        ? never
        : R['identifier']
      : R['identifier']
    : never
  : never

/** Owns resources across executions. Close it after its consumers have finished. */
export interface ResultTaskScopeOwner {
  readonly use: <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  /** Registers an already-acquired resource's release synchronously, in registration order. */
  readonly addFinalizer: (
    release: (exit: Exit<unknown, unknown>) => ResultTask<void, unknown>,
  ) => void
  readonly close: (exit?: Exit<unknown, unknown>) => ResultTask<void, unknown>
}

type RuntimeServiceResolver = (
  tag: AnyServiceTag,
) => ResultTask<unknown, unknown, unknown> | undefined

/** Options for running a `ResultTask` with an optional signal and its required services. */
export type ResultTaskRunOptions<R = never> = {
  readonly signal?: AbortSignal
  readonly clock?: TaskClock
  /** Dispatcher used when the interpreter yields to other work. */
  readonly scheduler?: TaskScheduler
  /** Operations between yields. Defaults to 2048; Infinity disables automatic yields. */
  readonly yieldEvery?: number
} & ([WithoutScope<R>] extends [never]
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
  /** Wait is the default. Detach interrupts only the wait; foreign work can continue. */
  readonly interruption?: 'wait' | 'detach'
}

/** Branches for `ResultTask.if`. */
export interface ResultTaskIfBranches<
  TrueTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  FalseTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
> {
  readonly onTrue: TrueTask | (() => TrueTask)
  readonly onFalse: FalseTask | (() => FalseTask)
}

/** Options for `ResultTask.loop` with refinement narrowing. */
export interface ResultTaskLoopOptions<
  State,
  BodyState extends State,
  R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
> {
  readonly while: (state: State) => state is BodyState
  readonly step: (state: BodyState) => State
  readonly body: (state: BodyState) => R
  readonly discard?: false
}

/** Options for `ResultTask.loop` with a boolean condition. */
export interface ResultTaskLoopBooleanOptions<
  State,
  R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
> {
  readonly while: (state: State) => boolean
  readonly step: (state: State) => State
  readonly body: (state: State) => R
  readonly discard?: false
}

/** Options for `ResultTask.loop` with refinement narrowing that discards step values. */
export interface ResultTaskLoopDiscardOptions<
  State,
  BodyState extends State,
  R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
> {
  readonly while: (state: State) => state is BodyState
  readonly step: (state: BodyState) => State
  readonly body: (state: BodyState) => R
  readonly discard: true
}

/** Options for `ResultTask.loop` with a boolean condition that discards step values. */
export interface ResultTaskLoopBooleanDiscardOptions<
  State,
  R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
> {
  readonly while: (state: State) => boolean
  readonly step: (state: State) => State
  readonly body: (state: State) => R
  readonly discard: true
}

/** Options for `ResultTask.iterate` with refinement narrowing. */
export interface ResultTaskIterateOptions<
  State,
  BodyState extends State,
  R extends ResultTask<State, unknown, unknown> | Result<State, unknown>,
> {
  readonly while: (state: State) => state is BodyState
  readonly body: (state: BodyState) => R
}

/** Options for `ResultTask.iterate` with a boolean condition. */
export interface ResultTaskIterateBooleanOptions<
  State,
  R extends ResultTask<State, unknown, unknown> | Result<State, unknown>,
> {
  readonly while: (state: State) => boolean
  readonly body: (state: State) => R
}

type WidenTaskLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends bigint
      ? bigint
      : T extends boolean
        ? boolean
        : T extends symbol
          ? symbol
          : T

type AnyServiceTag = Pick<ServiceTag<string, unknown>, '_tag' | 'identifier' | 'key'>
type ServiceForTag<Tag> = Tag extends ServiceTag<string, infer Service> ? Service : never
type WithoutServices<R> = Exclude<R, AnyServiceTag>
type ResultTaskRuntimeServices = ReadonlyMap<symbol, unknown>

interface ResultTaskCleanupScheduling {
  schedulerFailure: Exit<unknown, unknown>
}

interface ResultTaskRuntimeContext {
  readonly namedServices: ReadonlyMap<string, unknown>
  readonly services: ResultTaskRuntimeServices
  readonly serviceResolver: RuntimeServiceResolver | undefined
  readonly signal: AbortSignal
  readonly scope: TaskScope
  readonly clock: TaskClock
  readonly scheduling: TaskScheduling
  readonly cleanup: ResultTaskCleanupScheduling | undefined
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

interface ResultTaskYield<out A, out E, out R> {
  readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
  readonly _tag: 'ResultTask'
  readonly task: ResultTask<A, E, R>
}

interface ResultTaskServiceYield<out Tag extends AnyServiceTag> {
  readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
  readonly _tag: 'Service'
  readonly tag: Tag
}

/** Valid values that can be yielded inside `ResultTask.gen` and `ResultTask.fn` generators. */
export type ResultTaskYieldable =
  | ResultTaskYield<unknown, unknown, unknown>
  | ResultTaskServiceYield<AnyServiceTag>
  | Result<never, unknown>

/** Yield contract for a `ResultTask` generator with error channel `E` and environment `R`. */
export type ResultTaskYieldOf<E = never, R = never> =
  | ResultTaskYield<unknown, E, R>
  | Result<never, E>
  | (Extract<R, AnyServiceTag> extends never
      ? never
      : ResultTaskServiceYield<Extract<R, AnyServiceTag>>)

/** Generator return type annotation helper for `ResultTask.gen`, `ResultTask.fn`, and composable sub-generators. */
export type ResultTaskGenerator<A, E = never, R = never> = Generator<
  ResultTaskYieldOf<E, R>,
  A,
  never
>

type GeneratorError<Yield> = Yield extends {
  readonly _tag: 'ResultTask'
  readonly task: infer Task
}
  ? TaskError<Task>
  : Yield extends { readonly error: infer E; readonly isErr: unknown }
    ? E
    : never

type GeneratorRequirements<Yield> = Yield extends {
  readonly _tag: 'ResultTask'
  readonly task: infer Task
}
  ? TaskRequirements<Task>
  : Yield extends { readonly _tag: 'Service'; readonly tag: infer Tag }
    ? Tag
    : never

type FunctionTask<Body extends (...args: never[]) => unknown> =
  ReturnType<Body> extends Generator<infer Yield, infer Return, infer _Next>
    ? ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>>
    : never

type TaskSuccess<T> = T extends {
  readonly [ResultTaskTypeId]: { readonly success: (_: never) => infer A }
}
  ? A
  : T extends Result<infer A, unknown>
    ? A
    : never
type TaskError<T> = T extends {
  readonly [ResultTaskTypeId]: { readonly error: (_: never) => infer E }
}
  ? E
  : T extends Result<unknown, infer E>
    ? E
    : never
type TaskRequirements<T> = T extends {
  readonly [ResultTaskTypeId]: { readonly requirements: (_: never) => infer R }
}
  ? R
  : never
type TaskCandidate<C> = C extends () => infer T ? T : C
type ConditionError<C> = TaskError<TaskCandidate<C>>
type ConditionRequirements<C> = TaskRequirements<TaskCandidate<C>>
type ResultTaskCondition<ECond = never, RCond = never> =
  | boolean
  | (() => boolean)
  | Result<boolean, ECond>
  | (() => Result<boolean, ECond>)
  | ResultTask<boolean, ECond, RCond>
  | (() => ResultTask<boolean, ECond, RCond>)
type TaskHandlers<E, H> = CatchTagHandlers<
  E,
  H,
  ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
>
type TaskReasonHandlers<E, ErrorTag extends string, H> = CatchReasonHandlers<
  E,
  ErrorTag,
  H,
  ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
>

const getReason = (value: unknown): unknown => (value as { readonly reason?: unknown }).reason

type ResultTaskRunArguments<R> = [WithoutScope<R>] extends [never]
  ? [options?: ResultTaskRunOptions<R>]
  : [options: ResultTaskRunOptions<R>]

/** Scheduler defects are appended once at the cleanup boundary, never to intermediate yields. */
const completeCleanup = <A, E>(exit: Exit<A, E>, context: ResultTaskRuntimeContext): Exit<A, E> =>
  // The cleanup ledger contains only scheduler defects, without introducing a typed error.
  combineExits(exit, context.cleanup?.schedulerFailure ?? success(undefined), 'Sequential') as Exit<
    A,
    E
  >

const checkedDuration = (milliseconds: number): number => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new RangeError('Task duration must be a finite non-negative number')
  return milliseconds
}

const checkedConcurrency = (options?: ResultTaskConcurrencyOptions): number => {
  const concurrency = options?.concurrency ?? 1
  if (concurrency === 'unbounded') return Infinity
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Task concurrency must be a positive safe integer or unbounded')
  return concurrency
}

const checkedRandom = (clock: TaskClock): number => {
  const random = clock.random()
  if (!Number.isFinite(random) || random < 0 || random > 1)
    throw new RangeError('Task clock random must return a number between zero and one')
  return random
}

const retryFailure = (
  exit: Exit<unknown, unknown>,
  retry: number,
  options: ResultTaskRetryOptions<unknown>,
): { readonly error: unknown } | undefined => {
  if (exit._tag === 'Success' || exit.cause._tag !== 'Fail' || retry >= options.times)
    return undefined
  if (options.while?.(exit.cause.error, retry + 1) === false) return undefined
  return { error: exit.cause.error }
}

const retryDelay = (
  retry: number,
  error: unknown,
  policy: { readonly options: ResultTaskRetryOptions<unknown>; readonly clock: TaskClock },
): number => {
  const { options, clock } = policy
  const base =
    typeof options.delayMs === 'function'
      ? options.delayMs(retry + 1, error)
      : (options.delayMs ?? 0)
  const delay = checkedDuration(base * (options.backoff ?? 1) ** retry)
  return options.jittered === true ? delay * checkedRandom(clock) : delay
}

const legacyRetryDelay = (
  exit: Exit<unknown, unknown>,
  retry: number,
  runtime: { readonly options: ResultTaskRetryOptions<unknown>; readonly clock: TaskClock },
): number | undefined => {
  const { options, clock } = runtime
  const next = retryFailure(exit, retry, options)
  return next === undefined ? undefined : retryDelay(retry, next.error, { options, clock })
}

const canonicalRetryDecision = async (
  policy: RetryPolicy<unknown>,
  error: unknown,
  runtime: { readonly context: RetryContext; readonly signal: AbortSignal },
): Promise<Exit<boolean, never>> => {
  const predicate = policy.while
  if (predicate === undefined) return success(true)
  return detachedPromise(
    runtime.signal,
    () => Promise.resolve(predicate(error, runtime.context)),
    throwDefect,
  )
}

const canonicalRetryDelay = async (
  exit: Exit<unknown, unknown>,
  attempt: number,
  runtime: {
    readonly policy: RetryPolicy<unknown>
    readonly clock: TaskClock
    readonly signal: AbortSignal
  },
): Promise<Exit<number | undefined, never>> => {
  const { policy, clock, signal } = runtime
  if (exit._tag === 'Success' || exit.cause._tag !== 'Fail' || attempt >= policy.times) {
    return success(undefined)
  }
  const context = retryContext(attempt, policy.times)
  const error = exit.cause.error
  const decision = await canonicalRetryDecision(policy, error, { context, signal })
  if (decision._tag === 'Failure') return decision
  if (!decision.value) return success(undefined)
  const observation = await detachedPromise(
    signal,
    () => observeRetry(policy, error, context),
    throwDefect,
  )
  if (observation._tag === 'Failure') return observation
  return success(retryPolicyDelay(policy, context, () => clock.random()))
}

const validateTaskRetry = (options: ResultTaskRetryInput<unknown>): void => {
  if (isRetryPolicy(options)) {
    validateRetryPolicy(options)
    return
  }
  if (!Number.isSafeInteger(options.times) || options.times < 0) {
    throw new RangeError('Task retries must be a non-negative safe integer')
  }
  if (options.backoff !== undefined && (!Number.isFinite(options.backoff) || options.backoff < 1)) {
    throw new RangeError('Task backoff must be at least one')
  }
  if (typeof options.delayMs === 'number') checkedDuration(options.delayMs)
}

const collectionFailure = (
  exit: Exit<unknown, unknown>,
  validate: boolean,
): Exit<unknown, unknown> => {
  if (exit._tag === 'Success') return success(undefined)
  if (validate && exit.cause._tag === 'Fail') return success(undefined)
  const cause = withoutInterruptions(exit.cause)
  if (cause === undefined) return success(undefined)
  return validate ? died(new ResultTaskCauseError(cause)) : failure(cause)
}

const collectOutcomes = (
  values: unknown[],
  outcomes: readonly Exit<unknown, unknown>[],
  validate: boolean,
): Exit<unknown, unknown> => {
  let combined: Exit<unknown, unknown> = success(values)
  for (const exit of outcomes)
    combined = combineExits(combined, collectionFailure(exit, validate), 'Parallel')
  return combined
}

const finishRace = async (
  winner: Exit<unknown, unknown>,
  winnerIndex: number,
  children: readonly RuntimeFiber[],
): Promise<Exit<unknown, unknown>> => {
  for (const [index, child] of children.entries()) {
    if (index !== winnerIndex) child.interrupt('ResultTask race lost')
  }
  await Promise.all(children.map((child) => child.outcome))
  let result = winner
  for (const [index, child] of children.entries()) {
    if (index !== winnerIndex) result = combineExits(result, child.cleanup(), 'Sequential')
  }
  return result
}

const throwDefect = (defect: unknown): never => {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw defect
}

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' || typeof value === 'function') && value !== null

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasCleanupCause = (cause: Cause<unknown>): boolean =>
  transformCause(cause, (leaf) => (isCleanupCause(leaf) ? leaf : undefined), isCleanupCause) !==
  undefined

const isExternalInterruptOnly = (cause: Cause<unknown>, signal: AbortSignal): boolean =>
  signal.aborted && withoutInterruptions(cause) === undefined

const validateZipOptions = (options: unknown): ResultTaskZipOptions | undefined => {
  if (options === undefined) return undefined
  if (!isPlainRecord(options)) {
    throw new TypeError('ResultTask.zip options must be an object')
  }
  const concurrent = (options as { readonly concurrent?: unknown }).concurrent
  if (concurrent !== undefined && typeof concurrent !== 'boolean') {
    throw new TypeError('ResultTask.zip concurrent must be a boolean when provided')
  }
  return options as ResultTaskZipOptions
}

/** Returns true if a value is a nominal `ServiceTag`. */
export const isServiceTag = (value: unknown): value is ServiceTag<string, unknown> =>
  isObjectLike(value) &&
  (value as Record<symbol, unknown>)[ServiceTagTypeId] === ServiceTagTypeId &&
  (value as { readonly _tag?: unknown })._tag === 'ServiceTag' &&
  typeof (value as { readonly identifier?: unknown }).identifier === 'string' &&
  typeof (value as { readonly key?: unknown }).key === 'symbol' &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'

/** Returns true if a value is a `ResultTask` instance. */
export const isResultTask = (value: unknown): value is ResultTask<unknown, unknown, unknown> =>
  isObjectLike(value) &&
  (value instanceof ResultTask ||
    (value as Record<symbol, unknown>)[ResultTaskTypeId] !== undefined)

const isResultTaskYield = (value: unknown): value is ResultTaskYield<unknown, unknown, unknown> =>
  isObjectLike(value) &&
  (value as Record<symbol, unknown>)[ResultTaskYieldTypeId] === ResultTaskYieldTypeId &&
  (value as { readonly _tag?: unknown })._tag === 'ResultTask' &&
  isResultTask((value as { readonly task?: unknown }).task)

const isServiceYield = (value: unknown): value is ResultTaskServiceYield<AnyServiceTag> =>
  isObjectLike(value) &&
  (value as Record<symbol, unknown>)[ResultTaskYieldTypeId] === ResultTaskYieldTypeId &&
  (value as { readonly _tag?: unknown })._tag === 'Service' &&
  isServiceTag((value as { readonly tag?: unknown }).tag)

const isErrResult = (
  value: unknown,
): value is { readonly error: unknown; readonly isErr: () => boolean } =>
  isObjectLike(value) &&
  'error' in value &&
  typeof (value as { isErr?: unknown }).isErr === 'function' &&
  (value as { isErr: () => boolean }).isErr()

const isSyncResult = (value: unknown): value is Result<unknown, unknown> =>
  isObjectLike(value) && typeof (value as { readonly isOk?: unknown }).isOk === 'function'

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

  // Stryker disable next-line all: any non-Found lookup converges to MissingServiceError downstream; the tag string is not publicly observable.
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

    return completeCleanup(finalExit, runtime.context)
  } catch (error) {
    return completeCleanup(died<Return, E>(error), runtime.context)
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
  clock: context.clock,
  scheduling: context.scheduling,
  cleanup: context.cleanup,
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
  clock: context.clock,
  scheduling: context.scheduling,
  cleanup: context.cleanup,
})

const withChildScope = (
  context: ResultTaskRuntimeContext,
  scope: TaskScope,
  signal: AbortSignal,
): ResultTaskRuntimeContext => ({
  namedServices: context.namedServices,
  services: context.services,
  serviceResolver: context.serviceResolver,
  signal,
  scope,
  clock: context.clock,
  scheduling: forkScheduling(context.scheduling),
  cleanup: context.cleanup === undefined ? undefined : { schedulerFailure: success(undefined) },
})

const withCleanupScope = (
  context: ResultTaskRuntimeContext,
  scope: TaskScope,
): ResultTaskRuntimeContext => ({
  namedServices: context.namedServices,
  services: context.services,
  serviceResolver: context.serviceResolver,
  signal: new AbortController().signal,
  scope,
  clock: context.clock,
  scheduling: context.scheduling,
  cleanup: { schedulerFailure: success(undefined) },
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
  clock: context.clock,
  scheduling: context.scheduling,
  cleanup: context.cleanup,
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
  clock: context.clock,
  scheduling: context.scheduling,
  cleanup: context.cleanup,
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
      readonly f: (
        value: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
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
      readonly _tag: 'TapBoth'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly onOk: (value: unknown) => unknown
      readonly onErr: (error: unknown) => unknown
    }
  | {
      readonly _tag: 'CatchAll'
      readonly task: ResultTask<unknown, unknown, unknown>
      readonly f: (
        error: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    }

type TaskContinuation =
  | {
      readonly _tag: 'FlatMap'
      readonly f: (
        value: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    }
  | { readonly _tag: 'Map'; readonly f: (value: unknown) => unknown }
  | { readonly _tag: 'MapError'; readonly f: (error: unknown) => unknown }
  | { readonly _tag: 'Tap'; readonly f: (value: unknown) => unknown }
  | { readonly _tag: 'TapError'; readonly f: (error: unknown) => unknown }
  | {
      readonly _tag: 'TapBoth'
      readonly onOk: (value: unknown) => unknown
      readonly onErr: (error: unknown) => unknown
    }
  | {
      readonly _tag: 'CatchAll'
      readonly f: (
        error: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    }

interface ContinuationStep {
  readonly current: ResultTask<unknown, unknown, unknown> | undefined
  readonly currentExit: Exit<unknown, unknown> | undefined
}

interface InstructionStep {
  readonly nextCurrent: ResultTask<unknown, unknown, unknown> | undefined
  readonly exit: Exit<unknown, unknown> | undefined
}

/* eslint-disable typescript/switch-exhaustiveness-check */
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
    case 'TapBoth':
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
    default: {
      try {
        return { nextCurrent: undefined, exit: await instruction.execute(context) }
      } catch (error) {
        return { nextCurrent: undefined, exit: died(error) }
      }
    }
  }
}

/**
 * A lazy, composable workflow that can succeed with `A`, fail with a typed error `E`,
 * and declare execution requirements `R` (such as `ServiceTag`s or `ResultTaskScope`).
 *
 * Constructing a `ResultTask` never starts its work. Use `ResultTask.runResult`,
 * `ResultTask.runExit`, `ResultTask.runPromise`, or `ResultTask.runFork` at an
 * explicit application boundary to execute it.
 *
 * @example
 * ```ts
 * import { ResultTask } from 'resultar'
 *
 * const task = ResultTask.ok(21).map((n) => n * 2)
 * const result = await ResultTask.runResult(task)
 * // Ok(42)
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ResultTask<out A, out E = never, out R = never> {
  readonly [ResultTaskTypeId]: {
    readonly success: (_: never) => A
    readonly error: (_: never) => E
    readonly requirements: (_: never) => R
  }
}

/**
 * Lazy, structured-concurrency workflow implementation for Resultar.
 *
 * @example
 * ```ts
 * import { ResultTask } from 'resultar'
 *
 * const workflow = ResultTask.gen(function* () {
 *   const a = yield* ResultTask.ok(20)
 *   const b = yield* ResultTask.ok(22)
 *   return a + b
 * })
 * const result = await ResultTask.runResult(workflow)
 * // Ok(42)
 * ```
 */
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
  static #applySuccessContinuation(
    continuation: TaskContinuation,
    exit: Exit<unknown, unknown> & { readonly _tag: 'Success' },
  ): ContinuationStep {
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
          return ResultTask.#toContinuationStep(continuation.f(exit.value))
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      case 'Tap':
      case 'TapBoth': {
        try {
          const callback = continuation._tag === 'Tap' ? continuation.f : continuation.onOk
          const res = callback(exit.value)
          return ResultTask.#toTapContinuationStep(res, exit)
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      default: {
        return { current: undefined, currentExit: exit }
      }
    }
  }

  // fallow-ignore-next-line complexity
  static #applyFailureContinuation(
    continuation: TaskContinuation,
    exit: Exit<unknown, unknown> & { readonly _tag: 'Failure' },
  ): ContinuationStep {
    switch (continuation._tag) {
      case 'MapError': {
        try {
          const cause = transformCause(exit.cause, (leaf) =>
            leaf._tag === 'Fail' ? { _tag: 'Fail', error: continuation.f(leaf.error) } : leaf,
          )
          return { current: undefined, currentExit: failure(cause) }
        } catch (error) {
          return { current: undefined, currentExit: died(error) }
        }
      }
      case 'TapError':
      case 'TapBoth': {
        if (exit.cause._tag === 'Fail') {
          try {
            const failError = exit.cause.error
            const callback = continuation._tag === 'TapError' ? continuation.f : continuation.onErr
            const res = callback(failError)
            return ResultTask.#toTapContinuationStep(res, exit)
          } catch (error) {
            const cause: Cause<never> = { _tag: 'Die', defect: error }
            if (hasCleanupCause(exit.cause)) {
              markCleanupCause(cause)
            }
            return { current: undefined, currentExit: failure(cause) }
          }
        }
        return { current: undefined, currentExit: exit }
      }
      case 'CatchAll': {
        if (exit.cause._tag === 'Sequential' || exit.cause._tag === 'Parallel') {
          return { current: undefined, currentExit: died(new ResultTaskCauseError(exit.cause)) }
        }
        if (exit.cause._tag === 'Fail') {
          try {
            return ResultTask.#toContinuationStep(continuation.f(exit.cause.error))
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
  /* eslint-enable typescript/switch-exhaustiveness-check */

  static #toContinuationStep(
    next: ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  ): ContinuationStep {
    if (isResultTask(next)) {
      return { current: next, currentExit: undefined }
    }
    return {
      current: undefined,
      currentExit: next.isOk() ? success(next.value) : failed(next.error),
    }
  }

  static #toTapContinuationStep(
    res: unknown,
    passThroughExit: Exit<unknown, unknown>,
  ): ContinuationStep {
    const cleanupMarked =
      passThroughExit._tag === 'Failure' && hasCleanupCause(passThroughExit.cause)
    const retain = (
      task: ResultTask<unknown, unknown, unknown>,
    ): ResultTask<unknown, unknown, unknown> =>
      new ResultTask(async (context) => {
        const observed = await task.execute(context)
        if (observed._tag === 'Failure') {
          if (cleanupMarked) {
            markCleanupCause(observed.cause)
          }
          return observed
        }
        return passThroughExit
      })
    if (res instanceof ResultTask) {
      return { current: retain(res), currentExit: undefined }
    }
    if (
      // Stryker disable next-line all: forcing the promise branch still succeeds with the same value; only rejected promises diverge and they already take this branch.
      typeof res === 'object' &&
      res !== null &&
      // Stryker disable next-line all: a non-function then still awaits to the same success; the guard only routes rejected promises into Die.
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
      return { current: retain(promiseTask), currentExit: undefined }
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

    // Stryker disable next-line ConditionalExpression: runTaskLoop terminates when both current and continuations are exhausted.
    while (current !== undefined || continuations.length > 0) {
      try {
        const yielding = schedulerCheckpoint(context.scheduling, context.signal)
        // eslint-disable-next-line no-await-in-loop
        if (yielding !== undefined) await yielding
      } catch (error) {
        if (!context.signal.aborted) {
          recoverScheduling(context.scheduling)
          const defect = died(error)
          if (context.cleanup === undefined) {
            return combineExits(currentExit ?? success(undefined), defect, 'Sequential')
          }
          context.cleanup.schedulerFailure = defect
        }
        // Existing interruption checks retain pending failures and cleanup causes.
      }
      if (current === undefined) {
        const nextContinuation = continuations.pop() as unknown as TaskContinuation
        const activeExit = currentExit as unknown as Exit<unknown, unknown>

        const resolvedExit: Exit<unknown, unknown> =
          context.signal.aborted && activeExit._tag === 'Success'
            ? interrupted(context.signal)
            : activeExit

        const step: ContinuationStep =
          resolvedExit._tag === 'Success'
            ? ResultTask.#applySuccessContinuation(nextContinuation, resolvedExit)
            : ResultTask.#applyFailureContinuation(nextContinuation, resolvedExit)
        current = step.current
        currentExit = step.currentExit
      } else {
        if (context.signal.aborted) {
          return interrupted(context.signal)
        }

        // eslint-disable-next-line no-await-in-loop
        const step = await executeInstruction(current.instruction, continuations, context)
        current = step.nextCurrent
        currentExit = step.exit
      }
    }

    return currentExit as unknown as Exit<unknown, unknown>
  }

  /** Creates a task that succeeds with `value` when it is executed. */
  public static ok<A>(value: A): ResultTask<A, never>
  public static ok<A, E>(value: A): ResultTask<A, E>
  public static ok<A, E = never>(value: A): ResultTask<A, E> {
    return new ResultTask<A, E>({ _tag: 'Succeed', value })
  }

  /** Creates a task that fails with `error` when it is executed. */
  public static err<const E>(error: E): ResultTask<never, E>
  public static err<A, const E>(error: E): ResultTask<A, E>
  public static err<A = never, const E = unknown>(error: E): ResultTask<A, E> {
    return new ResultTask<A, E>({ _tag: 'Fail', error })
  }

  /** @deprecated Use `ResultTask.ok`. Execution and error behavior are unchanged. */
  public static succeed<A>(value: A): ResultTask<A, never>
  public static succeed<A, E>(value: A): ResultTask<A, E>
  public static succeed<A, E = never>(value: A): ResultTask<A, E> {
    return ResultTask.ok<A, E>(value)
  }

  /** @deprecated Use `ResultTask.err`. Execution and error behavior are unchanged. */
  public static fail<const E>(error: E): ResultTask<never, E> {
    return ResultTask.err<E>(error)
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

  /**
   * Creates a lazy task that preserves synchronous throws and promise rejections as `unknown`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const fetchStatus = ResultTask.tryPromise((signal) =>
   *   fetch('https://example.com/health', { signal }).then((r) => r.status),
   * )
   * ```
   */
  public static tryPromise<A>(run: (signal: AbortSignal) => PromiseLike<A>): ResultTask<A, unknown>
  /**
   * Creates a lazy task that maps synchronous throws and promise rejections into `E`.
   * Pass `interruption: 'detach'` when wrapping foreign promises that ignore `AbortSignal`
   * so timeouts and races can stop waiting immediately.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const loadUser = ResultTask.tryPromise({
   *   try: (signal) => fetch('https://example.com/user', { signal }).then((r) => r.json()),
   *   catch: (cause) => new Error('Request failed', { cause }),
   *   interruption: 'detach',
   * })
   * ```
   */
  public static tryPromise<A, E>(options: ResultTaskTryPromiseOptions<A, E>): ResultTask<A, E>
  public static tryPromise<A, E>(
    options: ResultTaskTryPromiseOptions<A, E> | ((signal: AbortSignal) => PromiseLike<A>),
  ): ResultTask<A, unknown> {
    const normalized: ResultTaskTryPromiseOptions<A, unknown> =
      typeof options === 'function' ? { try: options, catch: (error) => error } : options
    const interruption = normalized.interruption
    if (interruption !== undefined && interruption !== 'wait' && interruption !== 'detach')
      throw new TypeError('Task promise interruption must be wait or detach')
    return new ResultTask<A, unknown>(async (context) => {
      if (interruption === 'detach')
        return detachedPromise(
          context.signal,
          () => normalized.try(context.signal),
          (error) => normalized.catch(error),
        )
      try {
        return success<A, unknown>(await normalized.try(context.signal))
      } catch (error) {
        if (context.signal.aborted) return interrupted(context.signal)
        return failed<A, unknown>(normalized.catch(error))
      }
    })
  }

  /**
   * Acquires lazily and registers release in the current scope. Release failures remain in the
   * scope requirement until `scoped` or a run boundary closes it; `orElse` / `catchAll` cannot erase them early.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const connection = ResultTask.acquireRelease({
   *   acquire: ResultTask.sync(() => ({ id: 'conn-1', closed: false })),
   *   release: (conn) => ResultTask.sync(() => { conn.closed = true }),
   * })
   * ```
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
        const cleanupContext = withCleanupScope(context, scope)
        let released: Exit<unknown, unknown> = success(undefined)
        try {
          released = await options.release(acquired.value as A, exit).execute(cleanupContext)
        } catch (error) {
          released = died(error)
        }
        return completeCleanup(await scope.close(released), cleanupContext)
      })
      return acquired
    })
  }

  /**
   * Acquires a native `Disposable` or `AsyncDisposable` lazily and releases it when the owning scope closes.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const handle = ResultTask.acquireDisposable(
   *   ResultTask.sync(() => ({
   *     value: 'leased',
   *     [Symbol.dispose]() {},
   *   })),
   * )
   * ```
   */
  public static acquireDisposable<A extends Disposable | AsyncDisposable, E, R>(
    acquire: ResultTask<A, E, R>,
  ): ResultTask<A, E, R | ResultTaskScope<never>> {
    return ResultTask.acquireRelease({
      acquire,
      release: (resource) =>
        new ResultTask<void>(async () => {
          if (Symbol.asyncDispose in resource) await resource[Symbol.asyncDispose]()
          else resource[Symbol.dispose]()
          return success(undefined)
        }),
    })
  }

  /**
   * Closes a child scope before continuing, running all registered LIFO finalizers and folding
   * any deferred release errors into `E`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const workflow = ResultTask.scoped(
   *   ResultTask.gen(function* () {
   *     const resource = yield* ResultTask.acquireRelease({
   *       acquire: ResultTask.ok('open'),
   *       release: () => ResultTask.ok(undefined),
   *     })
   *     return resource.toUpperCase()
   *   }),
   * )
   * ```
   */
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

  /**
   * Creates a service tag that can be requested with `yield*` inside `ResultTask.gen` or `ResultTask.fn`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * interface ClockService { readonly now: () => number }
   * const ClockTag = ResultTask.service<ClockService, 'Clock'>('Clock')
   * ```
   */
  public static service<Service, const Identifier extends string>(
    identifier: Identifier,
  ): ServiceTag<Identifier, Service>
  /** Infers the literal identifier after specifying the service contract. */
  public static service<Service>(): <const Identifier extends string>(
    identifier: Identifier,
  ) => ServiceTag<Identifier, Service>
  public static service(identifier?: string): unknown {
    if (identifier === undefined) return (name: string) => new ServiceTagValue(name)
    return new ServiceTagValue(identifier)
  }

  /* eslint-disable max-params */
  /**
   * Wraps a generator function into a reusable function that returns a lazy `ResultTask` on each call,
   * optionally piping the resulting task through post-body operators that also receive the original arguments.
   *
   * @example
   * ```ts
   * import { ResultTask, ok } from 'resultar'
   *
   * const loadGreeting = ResultTask.fn(
   *   function* (name: string) {
   *     const trimmed = yield* ok(name.trim())
   *     return `Hello, ${trimmed}!`
   *   },
   *   (task, name) => task.map((msg) => `${msg} (${name.length} chars)`),
   * )
   * ```
   */
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
  >(body: Body): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => FunctionTask<Body>
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => B
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => C
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => D
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
    E,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
    de: FnPipe<D, Parameters<Body>, E>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => E
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
    E,
    F,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
    de: FnPipe<D, Parameters<Body>, E>,
    ef: FnPipe<E, Parameters<Body>, F>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => F
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
    E,
    F,
    G,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
    de: FnPipe<D, Parameters<Body>, E>,
    ef: FnPipe<E, Parameters<Body>, F>,
    fg: FnPipe<F, Parameters<Body>, G>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => G
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
    de: FnPipe<D, Parameters<Body>, E>,
    ef: FnPipe<E, Parameters<Body>, F>,
    fg: FnPipe<F, Parameters<Body>, G>,
    gh: FnPipe<G, Parameters<Body>, H>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => H
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
    I,
  >(
    body: Body,
    ab: FnPipe<FunctionTask<Body>, Parameters<Body>, B>,
    bc: FnPipe<B, Parameters<Body>, C>,
    cd: FnPipe<C, Parameters<Body>, D>,
    de: FnPipe<D, Parameters<Body>, E>,
    ef: FnPipe<E, Parameters<Body>, F>,
    fg: FnPipe<F, Parameters<Body>, G>,
    gh: FnPipe<G, Parameters<Body>, H>,
    hi: FnPipe<H, Parameters<Body>, I>,
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => I
  /* eslint-enable max-params */
  public static fn<
    Body extends (...args: never[]) => Generator<ResultTaskYieldable, unknown, never>,
  >(
    body: Body,
    ...fns: readonly FnPipe<never, readonly never[], unknown>[]
  ): (this: ThisParameterType<Body>, ...args: Parameters<Body>) => unknown {
    return function (this: ThisParameterType<Body>, ...args: Parameters<Body>): unknown {
      const initial = ResultTask.gen(() =>
        body.call(this, ...(args as never[])),
      ) as FunctionTask<Body>
      return runFnPipe(initial, args, fns)
    }
  }

  /**
   * Builds a lazy `ResultTask` from a generator that yields `ResultTask`, synchronous `Result`,
   * or `ServiceTag` values, short-circuiting on the first failure.
   *
   * @example
   * ```ts
   * import { ResultTask, ok } from 'resultar'
   *
   * const task = ResultTask.gen(function* () {
   *   const a = yield* ok(10)
   *   const b = yield* ResultTask.ok(32)
   *   return a + b
   * })
   * ```
   */
  public static gen<Yield extends ResultTaskYieldable = never, Return = unknown, Next = unknown>(
    body: () => Generator<Yield, Return, Next>,
  ): ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>> {
    return new ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>>(
      // fallow-ignore-next-line complexity
      async (context) => {
        try {
          const iterator = body()
          const executeTask: ResultTaskNestedExecutor = async (task) =>
            interruptSuccess(await task.execute(context), context.signal)
          const cleanupContext = withCleanupScope(context, context.scope)
          const closeRuntime: ResultTaskCloseRuntime = {
            context: cleanupContext,
            executeTask: (task) => task.execute(cleanupContext),
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

  /** Chains another task or synchronous Result from the success value without executing either task immediately. */
  public andThen<B = never, E2 = never, R2 = never>(
    f: (value: A) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<B, E | E2, R | R2> {
    return new ResultTask<B, E | E2, R | R2>({
      _tag: 'FlatMap',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (value: unknown) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    })
  }

  /** @deprecated Use andThen. Execution and error behavior are unchanged. */
  public flatMap<B = never, E2 = never, R2 = never>(
    f: (value: A) => ResultTask<B, E2, R2>,
  ): ResultTask<B, E | E2, R | R2> {
    return this.andThen(f)
  }

  /**
   * Recovers a single typed failure with another task or synchronous Result. Composite causes
   * become a Die(ResultTaskCauseError) so the removed E cannot escape through runExit; the original
   * tree remains available on error.cause.
   */
  public orElse<B = never, E2 = never, R2 = never>(
    f: (error: E) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, E2, R | R2> {
    return new ResultTask<A | B, E2, R | R2>({
      _tag: 'CatchAll',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (error: unknown) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    })
  }

  /** @deprecated Use orElse. Execution and error behavior are unchanged. */
  public catchAll<B = never, E2 = never, R2 = never>(
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2> {
    return this.orElse(f)
  }

  /** Recovers a single typed failure with a plain success value. */
  public orElseSucceed<B>(f: (error: E) => B): ResultTask<A | B, never, R> {
    return this.orElse((error) => ResultTask.ok(f(error)))
  }

  /** Recovers a single typed failure with `defaultValue`. */
  public unwrapOr<B>(defaultValue: B): ResultTask<A | B, never, R> {
    return this.orElse(() => ResultTask.ok(defaultValue))
  }

  /** Recovers a selected simple tagged failure, preserving other errors and scope requirements. */
  public catchTag<const Tag extends TagsOf<E>, B = never, E2 = never, R2 = never>(
    tag: Tag,
    handler: (error: ErrorForTag<E, Tag>) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, ExcludeTag<E, Tag> | E2, R | R2> {
    return this.orElse<B, ExcludeTag<E, Tag> | E2, R2>((error) =>
      hasTag(error, tag)
        ? handler(error as ErrorForTag<E, Tag>)
        : ResultTask.err(error as ExcludeTag<E, Tag>),
    )
  }

  /** Recovers any supplied tags; omitted tags remain in the error channel. */
  public catchTags<const H extends object>(
    handlers: H & TaskHandlers<E, H>,
  ): ResultTask<
    A | TaskSuccess<CatchTagHandlerResult<H>>,
    ExcludeTag<E, CoveredHandlerKeys<H> & string> | TaskError<CatchTagHandlerResult<H>>,
    R | TaskRequirements<CatchTagHandlerResult<H>>
  > {
    return this.orElse<
      TaskSuccess<CatchTagHandlerResult<H>>,
      ExcludeTag<E, CoveredHandlerKeys<H> & string> | TaskError<CatchTagHandlerResult<H>>,
      TaskRequirements<CatchTagHandlerResult<H>>
    >((error) => {
      const handled = callTaggedHandler<CatchTagHandlerResult<H>>(error, handlers)
      return isTaggedHandlerMatch(handled)
        ? (handled.value as
            | ResultTask<
                TaskSuccess<CatchTagHandlerResult<H>>,
                TaskError<CatchTagHandlerResult<H>>,
                TaskRequirements<CatchTagHandlerResult<H>>
              >
            | Result<TaskSuccess<CatchTagHandlerResult<H>>, TaskError<CatchTagHandlerResult<H>>>)
        : ResultTask.err(error as ExcludeTag<E, CoveredHandlerKeys<H> & string>)
    })
  }

  /** Recovers a selected nested tagged reason on a tagged failure, preserving other errors and reasons. */
  public catchReason<
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    B = never,
    E2 = never,
    R2 = never,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    handler: (
      reason: ReasonForTag<E, ErrorTag, ReasonTag>,
      error: ErrorForTag<E, ErrorTag>,
    ) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, ExcludeReasonTag<E, ErrorTag, ReasonTag> | E2, R | R2> {
    return this.orElse<B, ExcludeReasonTag<E, ErrorTag, ReasonTag> | E2, R2>((error) => {
      if (hasTag(error, errorTag)) {
        const reason = getReason(error)
        if (hasTag(reason, reasonTag)) {
          return handler(
            reason as ReasonForTag<E, ErrorTag, ReasonTag>,
            error as ErrorForTag<E, ErrorTag>,
          )
        }
      }
      return ResultTask.err(error as ExcludeReasonTag<E, ErrorTag, ReasonTag>)
    })
  }

  /** Recovers any supplied nested tagged reasons on a tagged failure; omitted reasons remain in the error channel. */
  public catchReasons<const ErrorTag extends TagsWithReasonOf<E>, const H extends object>(
    errorTag: ErrorTag,
    handlers: H & TaskReasonHandlers<E, ErrorTag, H>,
  ): ResultTask<
    A | TaskSuccess<CatchReasonHandlerResult<H>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>
    | TaskError<CatchReasonHandlerResult<H>>,
    R | TaskRequirements<CatchReasonHandlerResult<H>>
  > {
    return this.orElse<
      TaskSuccess<CatchReasonHandlerResult<H>>,
      | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>
      | TaskError<CatchReasonHandlerResult<H>>,
      TaskRequirements<CatchReasonHandlerResult<H>>
    >((error) => {
      if (hasTag(error, errorTag)) {
        const reason = getReason(error)
        if (typeof reason === 'object' && reason !== null && '_tag' in reason) {
          const handler = (handlers as Record<string, unknown>)[
            (reason as { readonly _tag: string })._tag
          ]
          if (handler !== undefined) {
            return (
              handler as (
                reasonValue: unknown,
                errorValue: unknown,
              ) =>
                | ResultTask<
                    TaskSuccess<CatchReasonHandlerResult<H>>,
                    TaskError<CatchReasonHandlerResult<H>>,
                    TaskRequirements<CatchReasonHandlerResult<H>>
                  >
                | Result<
                    TaskSuccess<CatchReasonHandlerResult<H>>,
                    TaskError<CatchReasonHandlerResult<H>>
                  >
            )(reason, error)
          }
        }
      }
      return ResultTask.err(error as ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>)
    })
  }

  /** Moves the nested reason of a tagged error into the error channel. */
  public unwrapReason<const ErrorTag extends TagsWithReasonOf<E>>(
    errorTag: ErrorTag,
  ): ResultTask<A, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>, R> {
    return this.orElse<never, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>, never>((error) => {
      if (hasTag(error, errorTag)) {
        return ResultTask.err(getReason(error) as ReasonsOf<E, ErrorTag>)
      }
      return ResultTask.err(error as ExcludeTag<E, ErrorTag>)
    })
  }

  static #finalizeCatchCause<Value, ErrorValue>(
    outcome: Exit<Value, ErrorValue>,
    context: ResultTaskRuntimeContext,
    options: { readonly cleanupMarked: boolean; readonly wasAborted: boolean },
  ): Exit<Value, ErrorValue> {
    if (options.cleanupMarked && outcome._tag === 'Failure') {
      markCleanupCause(outcome.cause)
    }
    if (!options.wasAborted) {
      return interruptSuccess(outcome, context.signal) as Exit<Value, ErrorValue>
    }
    return combineExits(interrupted(context.signal), outcome, 'Sequential') as Exit<
      Value,
      ErrorValue
    >
  }

  static async #runCatchCauseRecovery<B, E, E2, R2>(
    cause: Cause<E>,
    f: (cause: Cause<E>) => ResultTask<B, E2, R2> | Result<B, E2>,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<B, E2>> {
    const next = f(cause)
    if (!isResultTask(next)) {
      return next.isOk() ? success(next.value) : failed(next.error)
    }
    if (!context.signal.aborted) {
      return (await next.execute(context)) as Exit<B, E2>
    }
    const scope = new TaskScope()
    const cleanupContext = withCleanupScope(context, scope)
    const outcome = await next.execute(cleanupContext)
    return completeCleanup(await scope.close(outcome), cleanupContext) as Exit<B, E2>
  }

  /**
   * Recovers from any failure `Cause<E>` (including `Fail`, `Die`, `Sequential`, and `Parallel`)
   * with another `ResultTask` or synchronous `Result`. External fiber interruption still propagates.
   *
   * @example
   * ```ts
   * import { Cause, ResultTask } from 'resultar'
   *
   * const recovered = ResultTask.fail('boom' as const).catchCause((cause) =>
   *   ResultTask.ok(`recovered: ${Cause.pretty(cause)}`),
   * )
   * ```
   */
  public catchCause<B = never, E2 = never, R2 = never>(
    f: (cause: Cause<E>) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, E2, R | R2> {
    return new ResultTask<A | B, E2, R | R2>(async (context) => {
      const exit = interruptSuccess(await this.execute(context), context.signal)
      if (exit._tag === 'Success' || isExternalInterruptOnly(exit.cause, context.signal)) {
        return exit
      }
      const options = {
        cleanupMarked: hasCleanupCause(exit.cause),
        wasAborted: context.signal.aborted,
      }
      try {
        const outcome = await ResultTask.#runCatchCauseRecovery(exit.cause as Cause<E>, f, context)
        return ResultTask.#finalizeCatchCause<A | B, E2>(outcome, context, options)
      } catch (error) {
        return ResultTask.#finalizeCatchCause<A | B, E2>(died(error), context, options)
      }
    })
  }

  /**
   * Exposes the full failure `Cause<E>` in the typed error channel (`ResultTask<A, Cause<E>, R>`)
   * so composite causes (`Sequential`, `Parallel`, `Die`) can be matched with `catchTag`, `orElse`,
   * or `runResult` without leaving the task pipeline.
   *
   * @example
   * ```ts
   * import { Cause, ResultTask } from 'resultar'
   *
   * const inspected = ResultTask.fail('boom' as const)
   *   .sandbox()
   *   .orElse((cause) => ResultTask.ok(Cause.failures(cause)))
   * ```
   */
  public sandbox(): ResultTask<A, Cause<E>, R> {
    return new ResultTask<A, Cause<E>, R>(async (context) => {
      const exit = interruptSuccess(await this.execute(context), context.signal)
      if (exit._tag === 'Success' || isExternalInterruptOnly(exit.cause, context.signal)) {
        return exit
      }
      const boxedCause: Cause<Cause<E>> = { _tag: 'Fail', error: exit.cause as Cause<E> }
      if (hasCleanupCause(exit.cause)) {
        markCleanupCause(boxedCause)
      }
      return failure(boxedCause)
    })
  }

  /**
   * Restores a sandboxed `Cause<E2>` from the typed error channel back into the task's `Cause` tree.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const task = ResultTask.fail('boom' as const).sandbox().unsandbox()
   * ```
   */
  public unsandbox<E2>(this: ResultTask<A, Cause<E2>, R>): ResultTask<A, E2, R> {
    return new ResultTask<A, E2, R>(async (context) => {
      const exit = interruptSuccess(await this.execute(context), context.signal)
      if (exit._tag === 'Success') {
        return exit
      }
      const unboxed = transformCause(exit.cause, (leaf) => {
        const error = (leaf as { readonly error?: unknown }).error
        return Cause.isCause(error) ? error : leaf
      })
      return failure(unboxed)
    })
  }

  /** Maps the error value without executing the task. */
  public mapErr<E2>(f: (error: E) => E2): ResultTask<A, E2, R> {
    return new ResultTask<A, E2, R>({
      _tag: 'MapError',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      f: f as (error: unknown) => unknown,
    })
  }

  /** @deprecated Use mapErr. Execution and error behavior are unchanged. */
  public mapError<E2>(f: (error: E) => E2): ResultTask<A, E2, R> {
    return this.mapErr(f)
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

  /**
   * Executes a side effect on any failure `Cause<E>` without modifying the original failure
   * when the side effect succeeds. If the callback returns a `ResultTask`, its requirements and
   * errors are merged.
   */
  public tapCause<E2 = never, R2 = never>(
    f: (cause: Cause<E>) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2> {
    return new ResultTask<A, E | E2, R | R2>(async (context) => {
      const exit = interruptSuccess(await this.execute(context), context.signal)
      if (exit._tag === 'Success' || isExternalInterruptOnly(exit.cause, context.signal)) {
        return exit
      }
      try {
        const res = f(exit.cause as Cause<E>)
        if (isResultTask(res)) {
          const observed = interruptSuccess(await res.execute(context), context.signal)
          return combineExits(exit, observed, 'Sequential')
        }
        await res
        return exit
      } catch (error) {
        return combineExits(exit, died(error), 'Sequential')
      }
    })
  }

  /**
   * Executes a side effect on the success value or simple typed error value without modifying the outcome.
   * If a callback returns a `ResultTask`, its requirements and errors are merged.
   */
  public tapBoth<E2 = never, R2 = never, E3 = never, R3 = never>(
    handlers: ResultTaskMatchOptions<
      A,
      E,
      ResultTask<unknown, E2, R2> | Promise<unknown> | void,
      ResultTask<unknown, E3, R3> | Promise<unknown> | void
    >,
  ): ResultTask<A, E | E2 | E3, R | R2 | R3>
  public tapBoth<E2 = never, R2 = never, E3 = never, R3 = never>(
    onOk: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
    onErr: (error: E) => ResultTask<unknown, E3, R3> | Promise<unknown> | void,
  ): ResultTask<A, E | E2 | E3, R | R2 | R3>
  public tapBoth<E2 = never, R2 = never, E3 = never, R3 = never>(
    input:
      | ResultTaskMatchOptions<
          A,
          E,
          ResultTask<unknown, E2, R2> | Promise<unknown> | void,
          ResultTask<unknown, E3, R3> | Promise<unknown> | void
        >
      | ((value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void),
    onErr?: (error: E) => ResultTask<unknown, E3, R3> | Promise<unknown> | void,
  ): ResultTask<A, E | E2 | E3, R | R2 | R3> {
    if (typeof input === 'function') {
      if (onErr === undefined) {
        throw new TypeError('ResultTask.tapBoth requires an error side-effect function')
      }
      return new ResultTask<A, E | E2 | E3, R | R2 | R3>({
        _tag: 'TapBoth',
        task: this as unknown as ResultTask<unknown, unknown, unknown>,
        onOk: input as (value: unknown) => unknown,
        onErr: onErr as (error: unknown) => unknown,
      })
    }
    const onSuccess = taskSuccessHandler(input)
    const onFailure = taskFailureHandler(input)
    return new ResultTask<A, E | E2 | E3, R | R2 | R3>({
      _tag: 'TapBoth',
      task: this as unknown as ResultTask<unknown, unknown, unknown>,
      onOk: onSuccess as (value: unknown) => unknown,
      onErr: onFailure as (error: unknown) => unknown,
    })
  }

  /** Best-effort observation. Returned tasks are values and are never executed. */
  public inspect(f: (value: A) => unknown): ResultTask<A, E, R> {
    return new ResultTask(async (context) => {
      const exit = await this.execute(context)
      if (exit._tag === 'Success') {
        try {
          await f(exit.value as A)
        } catch {
          // Observation cannot change the workflow outcome.
        }
      }
      return exit
    })
  }

  /** Observes a simple typed failure without changing it or executing returned tasks. */
  public inspectError(f: (error: E) => unknown): ResultTask<A, E, R> {
    return new ResultTask(async (context) => {
      const exit = await this.execute(context)
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        try {
          await f(exit.cause.error as E)
        } catch {
          // Observation cannot change the workflow outcome.
        }
      }
      return exit
    })
  }

  /** Observes any failure `Cause<E>` without changing the outcome or executing returned tasks. */
  public inspectCause(f: (cause: Cause<E>) => unknown): ResultTask<A, E, R> {
    return new ResultTask(async (context) => {
      const exit = interruptSuccess(await this.execute(context), context.signal)
      if (exit._tag === 'Failure') {
        try {
          await f(exit.cause as Cause<E>)
        } catch {
          // Observation cannot change the workflow outcome.
        }
      }
      return exit
    })
  }

  /** Observes both success and simple typed failure without changing the outcome or executing returned tasks. */
  public inspectBoth(handlers: ResultTaskMatchOptions<A, E, unknown, unknown>): ResultTask<A, E, R>
  public inspectBoth(onOk: (value: A) => unknown, onErr: (error: E) => unknown): ResultTask<A, E, R>
  public inspectBoth(
    input: ResultTaskMatchOptions<A, E, unknown, unknown> | ((value: A) => unknown),
    onErr?: (error: E) => unknown,
  ): ResultTask<A, E, R> {
    if (typeof input === 'function') {
      if (onErr === undefined) {
        throw new TypeError('ResultTask.inspectBoth requires an error handler')
      }
      return this.inspect(input).inspectError(onErr)
    }
    const onSuccess = taskSuccessHandler(input)
    const onFailure = taskFailureHandler(input)
    return this.inspect(onSuccess).inspectError(onFailure)
  }

  /**
   * Races this task against a deadline of `milliseconds`, failing with `onTimeout()` after
   * interrupting this task and awaiting its scope finalizers.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const timed = ResultTask.sleep(500).timeout(100, () => ({ _tag: 'TimeoutError' as const }))
   * ```
   */
  public timeout<TimeoutError>(
    milliseconds: number,
    onTimeout: () => TimeoutError,
  ): ResultTask<A, E | ScopeError<R> | TimeoutError, WithoutScope<R>> {
    return ResultTask.timeout(this, milliseconds, onTimeout)
  }

  /**
   * Retries this task according to a portable `RetryPolicy` or retry options object, closing the
   * attempt's scope before starting the next retry.
   *
   * @example
   * ```ts
   * import { ResultTask, Retry } from 'resultar'
   *
   * const retried = ResultTask.fail('transient' as const).retry(Retry.policy({ times: 2, delay: 10 }))
   * ```
   */
  public retry(
    options: ResultTaskRetryInput<E | ScopeError<R>>,
  ): ResultTask<A, E | ScopeError<R>, WithoutScope<R>> {
    return ResultTask.retry(this, options)
  }

  /**
   * Delays execution of this task by `milliseconds` using the current run's clock.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const delayed = ResultTask.ok('ready').delay(50)
   * ```
   */
  public delay(milliseconds: number): ResultTask<A, E, R> {
    return ResultTask.delay(this, milliseconds)
  }

  /**
   * Measures the execution duration of this task in milliseconds using the current run's clock.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const measured = ResultTask.sleep(25).as('done').timed()
   * ```
   */
  public timed(): ResultTask<[durationMs: number, value: A], E, R> {
    return ResultTask.timed<readonly [ResultTask<A, E, R>]>(this)
  }

  /**
   * Runs `finalizer` unconditionally after this task finishes with `Success`, `Fail`, `Die`, or
   * `Interrupt`. Finalizer failures and defects are combined sequentially with the task outcome.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const tracked = ResultTask.ok(42).ensuring(() => ResultTask.sync(() => console.log('closed')))
   * ```
   */
  public ensuring<ReleaseError = never, ReleaseR = never>(
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>> {
    return ResultTask.ensuring(this, finalizer)
  }

  /**
   * Runs `finalizer` unconditionally with the completed `Exit<A, E>` after this task finishes with
   * `Success`, `Fail`, `Die`, or `Interrupt`. Finalizer failures and defects are combined
   * sequentially with the task outcome.
   */
  public onExit<ReleaseError = never, ReleaseR = never>(
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>> {
    return ResultTask.ensuring(this, finalizer)
  }

  /** Replaces the success value with a constant. */
  public as<B>(value: B): ResultTask<B, E, R> {
    return this.map(() => value)
  }

  /** Replaces the success value with `undefined` (`void`). */
  public asVoid(): ResultTask<void, E, R> {
    return this.as(undefined)
  }

  /**
   * Combines this task with another task or synchronous `Result` into a tuple `[A, B]`.
   * Runs sequentially by default, or concurrently when `{ concurrent: true }` is passed.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const pair = ResultTask.ok('a').zip(ResultTask.ok(1), { concurrent: true })
   * ```
   */
  public zip<B, E2 = never, R2 = never>(
    other: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: { readonly concurrent?: false },
  ): ResultTask<[A, B], E | E2, R | R2>
  public zip<B, E2 = never, R2 = never>(
    other: ResultTask<B, E2, R2> | Result<B, E2>,
    options: { readonly concurrent: true },
  ): ResultTask<[A, B], E | E2 | ScopeError<R | R2>, WithoutScope<R | R2>>
  public zip<B, E2 = never, R2 = never>(
    other: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: ResultTaskZipOptions,
  ): ResultTask<[A, B], E | E2 | ScopeError<R | R2>, R | R2>
  public zip<B, E2 = never, R2 = never>(
    other: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: ResultTaskZipOptions,
  ): ResultTask<[A, B], E | E2 | ScopeError<R | R2>, R | R2> {
    const validated = validateZipOptions(options)
    if (validated?.concurrent === true) {
      const rightTask: ResultTask<B, E2, R2> = isResultTask(other)
        ? other
        : ResultTask.fromResult(other)
      return ResultTask.all([this, rightTask] as const, { concurrency: 2 }) as ResultTask<
        [A, B],
        E | E2 | ScopeError<R | R2>,
        R | R2
      >
    }
    return this.andThen((leftValue) =>
      (other as ResultTask<B, E2, R2>).map((rightValue): [A, B] => [leftValue, rightValue]),
    )
  }

  /** Runs this task only when `condition` resolves to `true`; otherwise succeeds with `undefined`. */
  public when<Cond extends ResultTaskCondition<unknown, unknown>>(
    condition: Cond,
  ): ResultTask<A | undefined, E | ConditionError<Cond>, R | ConditionRequirements<Cond>> {
    return ResultTask.when(condition, this)
  }

  /** Runs this task only when `condition` resolves to `false`; otherwise succeeds with `undefined`. */
  public unless<Cond extends ResultTaskCondition<unknown, unknown>>(
    condition: Cond,
  ): ResultTask<A | undefined, E | ConditionError<Cond>, R | ConditionRequirements<Cond>> {
    return ResultTask.unless(condition, this)
  }

  /**
   * Keeps the success value only when the predicate passes; otherwise fails with `onFalse`.
   */
  public filterOrElse<B extends A, E2>(
    predicate: (value: A) => value is B,
    onFalse: (value: A) => E2,
  ): ResultTask<B, E | E2, R>
  public filterOrElse<E2>(
    predicate: (value: A) => boolean,
    onFalse: (value: A) => E2,
  ): ResultTask<A, E | E2, R>
  public filterOrElse<E2>(
    predicate: (value: A) => boolean,
    onFalse: (value: A) => E2,
  ): ResultTask<A, E | E2, R> {
    return this.andThen((value) =>
      predicate(value) ? ResultTask.ok(value) : ResultTask.err(onFalse(value)),
    )
  }

  /**
   * Transforms both success and failure cases into a single value type.
   */
  public match<B, C = B>(
    handlers: ResultTaskMatchOptions<A, E, B, C>,
  ): ResultTask<B | C, never, R> {
    const onSuccess = taskSuccessHandler(handlers)
    const onFailure = taskFailureHandler(handlers)
    return this.map(onSuccess).orElse((error) => ResultTask.ok(onFailure(error)))
  }

  /**
   * Transforms both success and tagged failure cases into a single value type with exhaustive tag handlers.
   */
  public matchTags<B, const Handlers extends object>(
    onOk: (value: A) => B,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): ResultTask<B | MatchTagHandlerResult<Handlers>, never, R> {
    return this.map(onOk).orElse((error) =>
      ResultTask.ok(
        matchTaggedOr<E, MatchTagHandlerResult<Handlers>, never>(error, handlers, (unhandled) => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw unhandled
        }),
      ),
    )
  }

  /**
   * Transforms both success and tagged failure cases into a single value type with partial tag handlers and a narrowed fallback.
   */
  public matchTagsPartial<B, C, const Handlers extends object>(
    onOk: (value: A) => B,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: RemainingMatchTagErrors<E, Handlers>) => C,
  ): ResultTask<B | MatchTagHandlerResult<Handlers> | C, never, R> {
    return this.map(onOk).orElse((error) =>
      ResultTask.ok(
        matchTaggedOr<E, MatchTagHandlerResult<Handlers>, C, RemainingMatchTagErrors<E, Handlers>>(
          error,
          handlers,
          fallback,
        ),
      ),
    )
  }

  /** Converts this ResultTask into an eagerly started ResultAsync using the standard runtime. */
  public toResultAsync(this: ResultTask<A, E, never>): ResultAsync<A, E> {
    return ResultTask.toResultAsync(this)
  }

  /** Provides one required service and removes it from the task's requirements. */
  public provideService<Tag extends Extract<R, AnyServiceTag>>(
    tag: Tag,
    ...args: [service: ServiceForTag<Tag>]
  ): ResultTask<A, E, Exclude<R, Tag>> {
    if ((args as readonly unknown[]).length === 0) {
      throw new TypeError('ResultTask.provideService requires a service implementation')
    }
    return ResultTask.provideService(this, tag, args[0])
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
  public static provideService(...args: readonly unknown[]): unknown {
    if (args.length >= 3) {
      const [task, tag, service] = args
      if (!isResultTask(task)) {
        throw new TypeError('ResultTask.provideService expects a ResultTask as first argument')
      }
      if (!isServiceTag(tag)) {
        throw new TypeError('ResultTask.provideService requires a valid service tag')
      }
      return new ResultTask(async (context) => {
        const services = new Map([...context.services, [tag.key, service] as const])
        const namedServices = new Map([
          ...context.namedServices,
          [tag.identifier, service] as const,
        ])

        return task.execute(withNamedServices(withServices(context, services), namedServices))
      })
    }

    if (args.length === 2 && !isResultTask(args[0])) {
      const [tag, service] = args
      if (!isServiceTag(tag)) {
        throw new TypeError('ResultTask.provideService requires a valid service tag')
      }
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.provideService(task as never, tag as never, service as never)
    }

    throw new TypeError('ResultTask.provideService requires a service implementation')
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
  >
  public static provideServiceResolver<
    const Resolvers extends Readonly<Record<string, () => ResultTask<unknown, unknown, unknown>>>,
  >(
    resolvers: Resolvers,
  ): <A, E, R>(
    task: [IncompatibleResolvedServices<R, Resolvers>] extends [never]
      ? ResultTask<A, E, R>
      : never,
  ) => ResultTask<
    A,
    E | ResolverError<Resolvers>,
    EliminateResolvedServices<R, Resolvers> | ResolverRequirements<Resolvers>
  >
  public static provideServiceResolver(...args: readonly unknown[]): unknown {
    if (args.length >= 2) {
      const [task, resolvers] = args
      if (!isResultTask(task)) {
        throw new TypeError(
          'ResultTask.provideServiceResolver expects a ResultTask as first argument',
        )
      }
      if (!isPlainRecord(resolvers)) {
        throw new TypeError('ResultTask.provideServiceResolver requires a resolvers object')
      }
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

    if (!isResultTask(args[0])) {
      const [resolvers] = args
      if (!isPlainRecord(resolvers)) {
        throw new TypeError('ResultTask.provideServiceResolver requires a resolvers object')
      }
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.provideServiceResolver(task as never, resolvers as never)
    }

    throw new TypeError('ResultTask.provideServiceResolver requires a resolvers object')
  }

  static {
    registerFiberTaskFactory(
      <Value, ErrorValue>(
        execute: (context: FiberTaskContext) => Promise<Exit<Value, ErrorValue>>,
      ) =>
        new ResultTask<Value, ErrorValue>((context) =>
          execute({
            signal: context.signal,
            // eslint-disable-next-line unicorn/require-array-join-separator -- Fiber.join is not Array.join.
            join: (fiber) => fiber.join().execute(context),
          }),
        ),
    )
    registerSemaphoreTaskFactory(
      <Value, ErrorValue, Requirements>(
        acquire: (signal: AbortSignal) => Promise<(() => void) | undefined>,
        task: ResultTask<Value, ErrorValue, Requirements>,
        caller: string,
      ) => {
        if (!isResultTask(task)) {
          throw new TypeError(`${caller} requires a task`)
        }
        return new ResultTask<Value, ErrorValue, Requirements>(async (context) => {
          const release = await acquire(context.signal)
          if (release === undefined) {
            return interrupted(context.signal)
          }
          try {
            return interruptSuccess(await task.execute(context), context.signal)
          } finally {
            release()
          }
        })
      },
    )
  }

  /**
   * Creates a concurrency semaphore with `permits` total permits that can be shared across fibers and tasks.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const semaphore = ResultTask.makeSemaphore(2)
   * const limited = semaphore.withPermit(ResultTask.ok('done'))
   * ```
   */
  public static makeSemaphore(permits: number): Semaphore {
    return Semaphore.make(permits)
  }

  static #startFiber(
    task: ResultTask<unknown, unknown, unknown>,
    context: ResultTaskRuntimeContext,
  ): RuntimeFiber {
    return startFiber({
      signal: context.signal,
      scope: context.scope,
      prepare: (scope, signal) => {
        const childContext = withChildScope(context, scope, signal)
        return {
          execute: () => task.execute(childContext),
          complete: (exit) => completeCleanup(exit, childContext),
        }
      },
    })
  }

  /**
   * Forks a child fiber lazily at execution time. The enclosing scope owns, interrupts, and awaits
   * the child fiber when the scope closes.
   *
   * @example
   * ```ts
   * import { Fiber, ResultTask } from 'resultar'
   *
   * const program = ResultTask.scoped(
   *   ResultTask.gen(function* () {
   *     const child = yield* ResultTask.forkChild(ResultTask.sleep(10).as('done'))
   *     return yield* Fiber.join(child)
   *   }),
   * )
   * ```
   */
  public static forkChild<A, E, R>(
    task: ResultTask<A, E, R>,
  ): ResultTask<
    FiberHandle<A, E | ScopeError<R>>,
    never,
    WithoutScope<R> | ResultTaskScope<E | ScopeError<R>>
  > {
    return new ResultTask((context) =>
      Promise.resolve(success(ResultTask.#startFiber(task, context).handle)),
    )
  }

  /**
   * A cancelable sleep using the clock supplied to the current run (`Clock.live` by default or
   * `Clock.virtual()` in tests).
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const delayed = ResultTask.sleep(50).as('ready')
   * ```
   */
  public static sleep(milliseconds: number): ResultTask<void> {
    checkedDuration(milliseconds)
    return new ResultTask(async (context) => {
      try {
        await context.clock.sleep(milliseconds, context.signal)
        return success(undefined)
      } catch (error) {
        return context.signal.aborted ? interrupted(context.signal) : died(error)
      }
    })
  }

  /**
   * Reads monotonic time lazily from the current run's clock.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const startedAt = ResultTask.now()
   * ```
   */
  public static now(): ResultTask<number> {
    return new ResultTask((context) => Promise.resolve(success(context.clock.now())))
  }

  static async #race(
    tasks: readonly [ResultTask<unknown, unknown, unknown>, ResultTask<unknown, unknown, unknown>],
    context: ResultTaskRuntimeContext,
    firstSuccess: boolean,
  ): Promise<Exit<unknown, unknown>> {
    const children = tasks.map((task) => ResultTask.#startFiber(task, context))
    for (const child of children) child.observe()
    const pending = new Map(
      children.map((child, index) => [index, child.outcome.then((exit) => ({ index, exit }))]),
    )
    let winner: Exit<unknown, unknown> = success(undefined)
    let winnerIndex = -1
    let failures: Exit<unknown, unknown> = success(undefined)
    while (pending.size > 0) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.race(pending.values())
      pending.delete(settled.index)
      if (!firstSuccess || settled.exit._tag === 'Success') {
        winner = settled.exit
        winnerIndex = settled.index
        break
      }
      failures = combineExits(failures, settled.exit, 'Parallel')
    }
    if (winnerIndex === -1) return failures
    return finishRace(winner, winnerIndex, children)
  }

  /**
   * Races two tasks concurrently and returns the first `Success`, interrupting the loser and
   * awaiting its scope finalizers. If both tasks fail, preserves both causes in `Parallel`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const fastest = ResultTask.race(
   *   ResultTask.sleep(10).as('primary'),
   *   ResultTask.sleep(50).as('replica'),
   * )
   * ```
   */
  public static race<
    Left extends ResultTask<unknown, unknown, unknown>,
    Right extends ResultTask<unknown, unknown, unknown>,
  >(
    left: Left,
    right: Right,
  ): ResultTask<
    TaskSuccess<Left> | TaskSuccess<Right>,
    | TaskError<Left>
    | TaskError<Right>
    | ScopeError<TaskRequirements<Left> | TaskRequirements<Right>>,
    WithoutScope<TaskRequirements<Left> | TaskRequirements<Right>>
  >
  public static race<Right extends ResultTask<unknown, unknown, unknown>>(
    right: Right,
  ): <Left extends ResultTask<unknown, unknown, unknown>>(
    left: Left,
  ) => ResultTask<
    TaskSuccess<Left> | TaskSuccess<Right>,
    | TaskError<Left>
    | TaskError<Right>
    | ScopeError<TaskRequirements<Left> | TaskRequirements<Right>>,
    WithoutScope<TaskRequirements<Left> | TaskRequirements<Right>>
  >
  public static race(...args: readonly ResultTask<unknown, unknown, unknown>[]): unknown {
    const left = args[0]
    if (left === undefined) throw new TypeError('ResultTask.race requires a task')
    if (args.length === 1)
      return (task: ResultTask<unknown, unknown, unknown>) => ResultTask.race(task, left)
    const right = args[1]
    if (right === undefined) throw new TypeError('ResultTask.race requires two tasks')
    return new ResultTask((context) => ResultTask.#race([left, right], context, true))
  }

  /**
   * Races two tasks concurrently and returns the first completed outcome (`Success` or `Failure`),
   * interrupting the other child and awaiting its finalizers.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const firstOutcome = ResultTask.raceFirst(
   *   ResultTask.sleep(10).as('fast'),
   *   ResultTask.sleep(50).as('slow'),
   * )
   * ```
   */
  public static raceFirst<
    Left extends ResultTask<unknown, unknown, unknown>,
    Right extends ResultTask<unknown, unknown, unknown>,
  >(
    left: Left,
    right: Right,
  ): ResultTask<
    TaskSuccess<Left> | TaskSuccess<Right>,
    | TaskError<Left>
    | TaskError<Right>
    | ScopeError<TaskRequirements<Left> | TaskRequirements<Right>>,
    WithoutScope<TaskRequirements<Left> | TaskRequirements<Right>>
  >
  public static raceFirst<Right extends ResultTask<unknown, unknown, unknown>>(
    right: Right,
  ): <Left extends ResultTask<unknown, unknown, unknown>>(
    left: Left,
  ) => ResultTask<
    TaskSuccess<Left> | TaskSuccess<Right>,
    | TaskError<Left>
    | TaskError<Right>
    | ScopeError<TaskRequirements<Left> | TaskRequirements<Right>>,
    WithoutScope<TaskRequirements<Left> | TaskRequirements<Right>>
  >
  public static raceFirst(...args: readonly ResultTask<unknown, unknown, unknown>[]): unknown {
    const left = args[0]
    if (left === undefined) throw new TypeError('ResultTask.raceFirst requires a task')
    if (args.length === 1)
      return (task: ResultTask<unknown, unknown, unknown>) => ResultTask.raceFirst(task, left)
    const right = args[1]
    if (right === undefined) throw new TypeError('ResultTask.raceFirst requires two tasks')
    return new ResultTask((context) => ResultTask.#race([left, right], context, false))
  }

  /**
   * Times out `task` after `milliseconds` with a typed error from `onTimeout()`, interrupting the
   * task and awaiting its finalizers before completing.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const timed = ResultTask.timeout(
   *   ResultTask.sleep(500).as('slow'),
   *   100,
   *   () => ({ _tag: 'TimeoutError' as const }),
   * )
   * ```
   */
  public static timeout<Task extends ResultTask<unknown, unknown, unknown>, TimeoutError>(
    task: Task,
    milliseconds: number,
    onTimeout: () => TimeoutError,
  ): ResultTask<
    TaskSuccess<Task>,
    TaskError<Task> | ScopeError<TaskRequirements<Task>> | TimeoutError,
    WithoutScope<TaskRequirements<Task>>
  >
  public static timeout<TimeoutError>(
    milliseconds: number,
    onTimeout: () => TimeoutError,
  ): <Task extends ResultTask<unknown, unknown, unknown>>(
    task: Task,
  ) => ResultTask<
    TaskSuccess<Task>,
    TaskError<Task> | ScopeError<TaskRequirements<Task>> | TimeoutError,
    WithoutScope<TaskRequirements<Task>>
  >
  public static timeout(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'number')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.timeout(task, args[0] as number, args[1] as () => unknown)
    const task = args[0] as ResultTask<unknown, unknown, unknown>
    const milliseconds = checkedDuration(args[1] as number)
    const onTimeout = args[2] as () => unknown
    const timer = ResultTask.sleep(milliseconds).andThen(() => ResultTask.err(onTimeout()))
    return ResultTask.raceFirst(task, timer)
  }

  /**
   * Retries `task` using a portable `RetryPolicy` or retry options object. Each attempt runs in its
   * own scope and closes its finalizers before the next retry begins.
   *
   * @example
   * ```ts
   * import { ResultTask, Retry } from 'resultar'
   *
   * const policy = Retry.policy({ times: 2, delay: ({ attempt }) => attempt * 10 })
   * const resilient = ResultTask.retry(ResultTask.ok('ready'), policy)
   * ```
   */
  public static retry<A, E, R>(
    task: ResultTask<A, E, R>,
    options: ResultTaskRetryInput<E | ScopeError<R>>,
  ): ResultTask<A, E | ScopeError<R>, WithoutScope<R>>
  public static retry<E>(
    policy: RetryPolicy<E>,
  ): <A, Error extends E, R>(
    task: ResultTask<A, Error, R> & ([ScopeError<R>] extends [E] ? unknown : never),
  ) => ResultTask<A, Error | ScopeError<R>, WithoutScope<R>>
  public static retry<E>(
    options: ResultTaskRetryOptions<E>,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E | ScopeError<R>, WithoutScope<R>>
  public static retry(...args: readonly unknown[]): unknown {
    if (!isResultTask(args[0]))
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.retry(task, args[0] as ResultTaskRetryInput<unknown>)
    const task = args[0]
    const options = args[1] as ResultTaskRetryInput<unknown>
    validateTaskRetry(options)
    return new ResultTask(async (context) => {
      for (let retry = 0; ; retry += 1) {
        const scope = new TaskScope()
        // eslint-disable-next-line no-await-in-loop
        const exit = await scope.close(await task.execute(withScope(context, scope)))
        if (context.signal.aborted) return interruptSuccess(exit, context.signal)
        const plan = isRetryPolicy(options)
          ? // eslint-disable-next-line no-await-in-loop
            await canonicalRetryDelay(exit, retry, {
              policy: options,
              clock: context.clock,
              signal: context.signal,
            })
          : success(legacyRetryDelay(exit, retry, { options, clock: context.clock }))
        if (plan._tag === 'Failure') return plan
        const delay = plan.value
        if (delay === undefined) return exit
        // eslint-disable-next-line no-await-in-loop
        const waiting = await ResultTask.sleep(delay).execute(context)
        if (waiting._tag === 'Failure') return waiting
      }
    })
  }

  static async #collect(
    items: Iterable<unknown>,
    mapper: (item: unknown, index: number) => ResultTask<unknown, unknown, unknown>,
    options: {
      readonly context: ResultTaskRuntimeContext
      readonly concurrency: number
      readonly validate: boolean
    },
  ): Promise<Exit<unknown, unknown>> {
    const { context, concurrency, validate } = options
    const input = [...items]
    const values: unknown[] = []
    const errors: unknown[] = []
    const children: RuntimeFiber[] = []
    const outcomes: Exit<unknown, unknown>[] = []
    let next = 0
    let stopping = false
    const stop = (): void => {
      stopping = true
      for (const child of children) child.interrupt('ResultTask collection stopped')
    }
    const worker = async (): Promise<void> => {
      while (next < input.length) {
        if (stopping || context.signal.aborted) return
        const index = next
        next += 1
        let child: RuntimeFiber | undefined = undefined
        try {
          child = ResultTask.#startFiber(mapper(input[index], index), context)
        } catch (error) {
          outcomes[index] = died(error)
          stop()
          return
        }
        children.push(child)
        child.observe()
        // eslint-disable-next-line no-await-in-loop
        const exit = await child.outcome
        outcomes[index] = exit
        if (exit._tag === 'Success') values[index] = exit.value
        else if (validate && exit.cause._tag === 'Fail') errors[index] = exit.cause.error
        else stop()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => worker()))
    let combined = collectOutcomes(values, outcomes, validate)
    if (validate && errors.length > 0)
      combined = combineExits(
        combined,
        failed(errors.filter((_error, index) => Object.hasOwn(errors, index))),
        'Parallel',
      )
    if (context.signal.aborted)
      return combineExits(interrupted(context.signal), combined, 'Sequential')
    return combined
  }

  /**
   * Maps `items` lazily into tasks, preserving input order. Any failure stops new scheduling,
   * interrupts active children, and awaits their finalizers.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const doubled = ResultTask.forEach([1, 2, 3], (n) => ResultTask.ok(n * 2), { concurrency: 2 })
   * ```
   */
  public static forEach<Item, A, E, R>(
    items: Iterable<Item>,
    mapper: (item: Item, index: number) => ResultTask<A, E, R>,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<A[], E | ScopeError<R>, WithoutScope<R>> {
    const concurrency = checkedConcurrency(options)
    return new ResultTask((context) =>
      ResultTask.#collect(
        items,
        mapper as (item: unknown, index: number) => ResultTask<unknown, unknown, unknown>,
        { context, concurrency, validate: false },
      ),
    )
  }

  /**
   * Collects all independent typed errors in input order across `items`; defects and interruptions
   * still stop scheduling and interrupt active children.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const validated = ResultTask.validateAll(
   *   [1, -2, 3, -4],
   *   (n) => (n > 0 ? ResultTask.ok(n) : ResultTask.err(`neg:${n}`)),
   *   { concurrency: 2 },
   * )
   * ```
   */
  public static validateAll<Item, A, E, R>(
    items: Iterable<Item>,
    mapper: (item: Item, index: number) => ResultTask<A, E, R>,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<A[], (E | ScopeError<R>)[], WithoutScope<R>> {
    const concurrency = checkedConcurrency(options)
    return new ResultTask((context) =>
      ResultTask.#collect(
        items,
        mapper as (item: unknown, index: number) => ResultTask<unknown, unknown, unknown>,
        { context, concurrency, validate: true },
      ),
    )
  }

  /**
   * Runs a tuple, record, or iterable of tasks and preserves tuple/record types.
   * Defaults to sequential execution (`concurrency: 1`); pass `{ concurrency }` for parallel execution.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const summary = ResultTask.all(
   *   { count: ResultTask.ok(3), status: ResultTask.ok('complete' as const) },
   *   { concurrency: 'unbounded' },
   * )
   * ```
   */
  public static all<const Tasks extends readonly ResultTask<unknown, unknown, unknown>[]>(
    tasks: Tasks,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<
    { -readonly [K in keyof Tasks]: TaskSuccess<Tasks[K]> },
    TaskError<Tasks[number]> | ScopeError<TaskRequirements<Tasks[number]>>,
    WithoutScope<TaskRequirements<Tasks[number]>>
  >
  public static all<
    const Tasks extends Readonly<Record<string, ResultTask<unknown, unknown, unknown>>>,
  >(
    tasks: Tasks,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<
    { -readonly [K in keyof Tasks]: TaskSuccess<Tasks[K]> },
    TaskError<Tasks[keyof Tasks]> | ScopeError<TaskRequirements<Tasks[keyof Tasks]>>,
    WithoutScope<TaskRequirements<Tasks[keyof Tasks]>>
  >
  public static all<A, E, R>(
    tasks: Iterable<ResultTask<A, E, R>>,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<A[], E | ScopeError<R>, WithoutScope<R>>
  public static all(
    tasks:
      | Iterable<ResultTask<unknown, unknown, unknown>>
      | Readonly<Record<string, ResultTask<unknown, unknown, unknown>>>,
    options?: ResultTaskConcurrencyOptions,
  ): ResultTask<unknown, unknown, unknown> {
    if (Symbol.iterator in tasks)
      // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
      return ResultTask.forEach(
        tasks as Iterable<ResultTask<unknown, unknown, unknown>>,
        (task) => task,
        options,
      )
    return new ResultTask(async (context) => {
      const entries = Object.entries(tasks)
      // eslint-disable-next-line unicorn/no-array-for-each -- This is the ResultTask policy, not Array.forEach.
      const collected = await ResultTask.forEach(
        entries,
        ([key, task]) => task.map((value) => [key, value] as const),
        options,
      ).execute(context)
      return collected._tag === 'Failure'
        ? collected
        : success(Object.fromEntries(collected.value as readonly (readonly [string, unknown])[]))
    })
  }

  /** Shares one in-flight execution and successful value. Failed executions can be retried. */
  public static memoize<A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R> {
    let pending: Promise<Exit<unknown, unknown>> | undefined = undefined
    return new ResultTask(async (context) => {
      pending ??= task.execute(context)
      const current = pending
      const exit = await current
      // Stryker disable next-line ConditionalExpression: only a newer execution starting between capture and reset could distinguish the guard; microtask ordering makes the first failing attacher always observe its own pending, so the mutant is equivalent.
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
      addFinalizer: (release) => {
        if (closing !== undefined) throw new Error('Cannot acquire into a closing ResultTask scope')
        scope.add((exit) =>
          ResultTask.runExit(
            ResultTask.gen(function* () {
              yield* release(exit)
            }),
          ),
        )
      },
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
          // Stryker disable next-line all: pending-set cleanup is memory hygiene; settled promises keep close() resolving identically.
          void execution.then(() => pending.delete(execution))
          return new Promise<Exit<unknown, unknown>>((resolve) => {
            const onAbort = (): void => {
              resolve(interrupted(context.signal))
            }
            // Stryker disable next-line all: abort fires at most once and the listener is removed on success; once:true is listener hygiene.
            context.signal.addEventListener('abort', onAbort, { once: true })
            void execution.then((exit) => {
              // Stryker disable next-line all: abort fires at most once; a mismatched event name only leaks the already-fired listener.
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
          return closed
        }),
    }
    return owner
  }

  /** Provides all requirements using an object keyed by service identifier. */
  public static provideServices<A, E, R>(
    task: ResultTask<A, E, R>,
    services: ResultTaskServices<R>,
  ): ResultTask<A, E, Extract<R, ResultTaskScope<unknown>>>
  public static provideServices<const Services extends Readonly<Record<string, unknown>>>(
    services: Services,
  ): <A, E, R>(
    task: [IncompatibleProvidedServices<R, Services>] extends [never] ? ResultTask<A, E, R> : never,
  ) => ResultTask<A, E, EliminateProvidedServices<R, Services>>
  public static provideServices(...args: readonly unknown[]): unknown {
    if (args.length >= 2) {
      const [task, services] = args
      if (!isResultTask(task)) {
        throw new TypeError('ResultTask.provideServices expects a ResultTask as first argument')
      }
      if (!isPlainRecord(services)) {
        throw new TypeError('ResultTask.provideServices requires a services object')
      }
      return new ResultTask(async (context) => {
        const namedServices = new Map(context.namedServices)

        for (const [identifier, service] of Object.entries(services as Record<string, unknown>)) {
          namedServices.set(identifier, service)
        }

        return task.execute(withNamedServices(context, namedServices))
      })
    }

    if (!isResultTask(args[0])) {
      const [services] = args
      if (!isPlainRecord(services)) {
        throw new TypeError('ResultTask.provideServices requires a services object')
      }
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.provideServices(task, services)
    }

    throw new TypeError('ResultTask.provideServices requires a services object')
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
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.map requires a mapping function')
        return task.map(callback)
      },
    )(taskOrF, f) as
      | ResultTask<B, E, R>
      | (<E2, R2>(task: ResultTask<A, E2, R2>) => ResultTask<B, E2, R2>)
  }

  /** Maps the error value using the canonical functional form or curried for `pipe`. */
  public static mapErr<A, E, R, E2>(
    task: ResultTask<A, E, R>,
    f: (error: E) => E2,
  ): ResultTask<A, E2, R>
  public static mapErr<E, E2>(
    f: (error: E) => E2,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E2, R>
  public static mapErr<A, E, R, E2>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => E2),
    f?: (error: E) => E2,
  ): ResultTask<A, E2, R> | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2, E2, R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.mapErr requires an error mapping function')
        return task.mapErr(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A, E2, R>
      | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2, E2, R2>)
  }

  /** @deprecated Use mapErr. Execution and error behavior are unchanged. */
  public static mapError<A, E, R, E2>(
    task: ResultTask<A, E, R>,
    f: (error: E) => E2,
  ): ResultTask<A, E2, R>
  /** @deprecated Use mapErr. Execution and error behavior are unchanged. */
  public static mapError<E, E2>(
    f: (error: E) => E2,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E2, R>
  /** @deprecated Use mapErr. Execution and error behavior are unchanged. */
  public static mapError<A, E, R, E2>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => E2),
    f?: (error: E) => E2,
  ): ResultTask<A, E2, R> | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2, E2, R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.mapError requires an error mapping function')
        return task.mapErr(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A, E2, R>
      | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2, E2, R2>)
  }

  /** Chains a task using the canonical functional form or curried for `pipe`. */
  /** @deprecated Use andThen. Execution and error behavior are unchanged. */
  public static flatMap<A, E, R, B = never, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<B, E2, R2>,
  ): ResultTask<B, E | E2, R | R2>
  /** @deprecated Use andThen. Execution and error behavior are unchanged. */
  public static flatMap<A, B = never, E2 = never, R2 = never>(
    f: (value: A) => ResultTask<B, E2, R2>,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E | E2, R | R2>
  /** @deprecated Use andThen. Execution and error behavior are unchanged. */
  public static flatMap<A, E, R, B = never, E2 = never, R2 = never>(
    taskOrF: ResultTask<A, E, R> | ((value: A) => ResultTask<B, E2, R2>),
    f?: (value: A) => ResultTask<B, E2, R2>,
  ):
    | ResultTask<B, E | E2, R | R2>
    | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.flatMap requires a continuation function')
        return task.andThen(callback)
      },
    )(taskOrF, f) as
      | ResultTask<B, E | E2, R | R2>
      | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>)
  }

  /** Chains a task or synchronous Result using the canonical functional form or curried for `pipe`. */
  public static andThen<A, E, R, B = never, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (value: A) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<B, E | E2, R | R2>
  public static andThen<A, B = never, E2 = never, R2 = never>(
    f: (value: A) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E | E2, R | R2>
  public static andThen<A, E, R, B = never, E2 = never, R2 = never>(
    taskOrF: ResultTask<A, E, R> | ((value: A) => ResultTask<B, E2, R2> | Result<B, E2>),
    f?: (value: A) => ResultTask<B, E2, R2> | Result<B, E2>,
  ):
    | ResultTask<B, E | E2, R | R2>
    | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.andThen requires a continuation function')
        return task.andThen(callback)
      },
    )(taskOrF, f) as
      | ResultTask<B, E | E2, R | R2>
      | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<B, E3 | E2, R3 | R2>)
  }

  /** Recovers from a typed failure using the canonical functional form or curried for `pipe`. */
  public static orElse<A, E, R, B = never, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (error: E) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, E2, R | R2>
  public static orElse<E, B = never, E2 = never, R2 = never>(
    f: (error: E) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A | B, E2, R | R2>
  public static orElse<A, E, R, B = never, E2 = never, R2 = never>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => ResultTask<B, E2, R2> | Result<B, E2>),
    f?: (error: E) => ResultTask<B, E2, R2> | Result<B, E2>,
  ):
    | ResultTask<A | B, E2, R | R2>
    | (<A2, R3>(task: ResultTask<A2, E, R3>) => ResultTask<A2 | B, E2, R3 | R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.orElse requires a recovery function')
        return task.orElse(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A | B, E2, R | R2>
      | (<A2, R3>(task: ResultTask<A2, E, R3>) => ResultTask<A2 | B, E2, R3 | R2>)
  }

  /** @deprecated Use orElse. Execution and error behavior are unchanged. */
  public static catchAll<A, E, R, B = never, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (error: E) => ResultTask<B, E2, R2>,
  ): ResultTask<A | B, E2, R | R2>
  /** @deprecated Use orElse. Execution and error behavior are unchanged. */
  public static catchAll<E, B = never, E2 = never, R2 = never>(
    f: (error: E) => ResultTask<B, E2, R2>,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A | B, E2, R | R2>
  /** @deprecated Use orElse. Execution and error behavior are unchanged. */
  public static catchAll<A, E, R, B = never, E2 = never, R2 = never>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => ResultTask<B, E2, R2>),
    f?: (error: E) => ResultTask<B, E2, R2>,
  ):
    | ResultTask<A | B, E2, R | R2>
    | (<A2, R3>(task: ResultTask<A2, E, R3>) => ResultTask<A2 | B, E2, R3 | R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.catchAll requires a recovery function')
        return task.orElse(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A | B, E2, R | R2>
      | (<A2, R3>(task: ResultTask<A2, E, R3>) => ResultTask<A2 | B, E2, R3 | R2>)
  }

  /** Recovers from a typed failure with a plain success value using the canonical functional form or curried for `pipe`. */
  public static orElseSucceed<A, E, R, B>(
    task: ResultTask<A, E, R>,
    f: (error: E) => B,
  ): ResultTask<A | B, never, R>
  public static orElseSucceed<E, B>(
    f: (error: E) => B,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A | B, never, R>
  public static orElseSucceed<A, E, R, B>(
    taskOrF: ResultTask<A, E, R> | ((error: E) => B),
    f?: (error: E) => B,
  ):
    | ResultTask<A | B, never, R>
    | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2 | B, never, R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.orElseSucceed requires a recovery function')
        return task.orElseSucceed(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A | B, never, R>
      | (<A2, R2>(task: ResultTask<A2, E, R2>) => ResultTask<A2 | B, never, R2>)
  }

  /** Recovers from a typed failure with `defaultValue` using the canonical functional form or curried for `pipe`. */
  public static unwrapOr<A, E, R, B>(
    task: ResultTask<A, E, R>,
    defaultValue: B,
  ): ResultTask<A | B, never, R>
  public static unwrapOr<B>(
    defaultValue: B,
  ): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A | B, never, R>
  public static unwrapOr(...args: readonly unknown[]): unknown {
    if (args.length >= 2) {
      const task = args[0]
      if (!isResultTask(task)) throw new TypeError('ResultTask.unwrapOr requires a task')
      return task.unwrapOr(args[1])
    }
    if (isResultTask(args[0])) {
      throw new TypeError('ResultTask.unwrapOr requires a default value')
    }
    return (task: ResultTask<unknown, unknown, unknown>) => task.unwrapOr(args[0])
  }

  /** Recovers a tagged failure in direct or pipe-friendly form. */
  public static catchTag<A, E, R, const Tag extends TagsOf<E>, B = never, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    tag: Tag,
    handler: (error: NoInfer<ErrorForTag<E, Tag>>) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, ExcludeTag<E, Tag> | E2, R | R2>
  public static catchTag<A, E, R, const Tag extends TagsOf<E>, B = never, E2 = never, R2 = never>(
    tag: Tag,
    handler: (error: NoInfer<ErrorForTag<E, Tag>>) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): (task: ResultTask<A, E, R>) => ResultTask<A | B, ExcludeTag<E, Tag> | E2, R | R2>
  public static catchTag<
    const Tag extends string,
    Handled extends { readonly _tag: Tag },
    B = never,
    E2 = never,
    R2 = never,
  >(
    tag: Tag,
    handler: (error: Handled) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): <A, E, R>(
    task: ResultTask<A, E, R> &
      (Tag extends TagsOf<E> ? (ErrorForTag<E, Tag> extends Handled ? unknown : never) : never),
  ) => ResultTask<A | B, ExcludeTag<E, Tag> | E2, R | R2>
  public static catchTag(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'string')
      return (task: ResultTask<unknown, { readonly _tag: string }, unknown>) =>
        ResultTask.catchTag(
          task,
          args[0] as string,
          args[1] as (error: {
            readonly _tag: string
          }) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
        )
    const task = args[0] as ResultTask<unknown, { readonly _tag: string }, unknown>
    return task.catchTag(
      args[1] as string,
      args[2] as (error: {
        readonly _tag: string
      }) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    )
  }

  /** Recovers supplied tags in direct or pipe-friendly form. */
  public static catchTags<A, E, R, const H extends object>(
    task: ResultTask<A, E, R>,
    handlers: H & TaskHandlers<E, H>,
  ): ResultTask<
    A | TaskSuccess<CatchTagHandlerResult<H>>,
    ExcludeTag<E, CoveredHandlerKeys<H> & string> | TaskError<CatchTagHandlerResult<H>>,
    R | TaskRequirements<CatchTagHandlerResult<H>>
  >
  public static catchTags<A, E, R, const H extends object>(
    handlers: H & TaskHandlers<E, H>,
  ): (
    task: ResultTask<A, E, R>,
  ) => ResultTask<
    A | TaskSuccess<CatchTagHandlerResult<H>>,
    ExcludeTag<E, CoveredHandlerKeys<H> & string> | TaskError<CatchTagHandlerResult<H>>,
    R | TaskRequirements<CatchTagHandlerResult<H>>
  >
  public static catchTags<const H extends object>(
    handlers: H,
  ): <A, E, R>(
    task: ResultTask<A, E, R> & (H extends TaskHandlers<E, H> ? unknown : never),
  ) => ResultTask<
    A | TaskSuccess<CatchTagHandlerResult<H>>,
    ExcludeTag<E, CoveredHandlerKeys<H> & string> | TaskError<CatchTagHandlerResult<H>>,
    R | TaskRequirements<CatchTagHandlerResult<H>>
  >
  public static catchTags(...args: readonly unknown[]): unknown {
    if (args.length === 1)
      return (task: ResultTask<unknown, unknown, unknown>) => task.catchTags(args[0] as object)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.catchTags requires a task')
    return task.catchTags(args[1] as object)
  }

  /* eslint-disable max-params */
  /** Recovers a nested tagged reason on a tagged failure in direct or pipe-friendly form. */
  public static catchReason<
    A,
    E,
    R,
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    B = never,
    E2 = never,
    R2 = never,
  >(
    task: ResultTask<A, E, R>,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    handler: (
      reason: NoInfer<ReasonForTag<E, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<E, ErrorTag>>,
    ) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): ResultTask<A | B, ExcludeReasonTag<E, ErrorTag, ReasonTag> | E2, R | R2>
  public static catchReason<
    A,
    E,
    R,
    const ErrorTag extends TagsWithReasonOf<E>,
    const ReasonTag extends ReasonTagsOf<E, ErrorTag>,
    B = never,
    E2 = never,
    R2 = never,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    handler: (
      reason: NoInfer<ReasonForTag<E, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<E, ErrorTag>>,
    ) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): (
    task: ResultTask<A, E, R>,
  ) => ResultTask<A | B, ExcludeReasonTag<E, ErrorTag, ReasonTag> | E2, R | R2>
  public static catchReason<
    const ErrorTag extends string,
    const ReasonTag extends string,
    HandledReason extends { readonly _tag: ReasonTag },
    HandledError extends { readonly _tag: ErrorTag; readonly reason: unknown } = {
      readonly _tag: ErrorTag
      readonly reason: HandledReason
    },
    B = never,
    E2 = never,
    R2 = never,
  >(
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    handler: (reason: HandledReason, error: HandledError) => ResultTask<B, E2, R2> | Result<B, E2>,
  ): <A, E, R>(
    task: ResultTask<A, E, R> &
      (ErrorTag extends TagsWithReasonOf<E>
        ? ReasonTag extends ReasonTagsOf<E, ErrorTag>
          ? ReasonForTag<E, ErrorTag, ReasonTag> extends HandledReason
            ? ErrorForTag<E, ErrorTag> extends HandledError
              ? unknown
              : never
            : never
          : never
        : never),
  ) => ResultTask<A | B, ExcludeReasonTag<E, ErrorTag, ReasonTag> | E2, R | R2>
  public static catchReason(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'string')
      return (
        task: ResultTask<
          unknown,
          { readonly _tag: string; readonly reason: { readonly _tag: string } },
          unknown
        >,
      ) =>
        task.catchReason(
          args[0] as string,
          args[1] as string,
          args[2] as (
            reason: { readonly _tag: string },
            error: { readonly _tag: string; readonly reason: { readonly _tag: string } },
          ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
        )
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.catchReason requires a task')
    return (
      task as ResultTask<
        unknown,
        { readonly _tag: string; readonly reason: { readonly _tag: string } },
        unknown
      >
    ).catchReason(
      args[1] as string,
      args[2] as string,
      args[3] as (
        reason: { readonly _tag: string },
        error: { readonly _tag: string; readonly reason: { readonly _tag: string } },
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    )
  }
  /* eslint-enable max-params */

  /** Recovers supplied nested tagged reasons on a tagged failure in direct or pipe-friendly form. */
  public static catchReasons<
    A,
    E,
    R,
    const ErrorTag extends TagsWithReasonOf<E>,
    const H extends object,
  >(
    task: ResultTask<A, E, R>,
    errorTag: ErrorTag,
    handlers: H & TaskReasonHandlers<E, ErrorTag, H>,
  ): ResultTask<
    A | TaskSuccess<CatchReasonHandlerResult<H>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>
    | TaskError<CatchReasonHandlerResult<H>>,
    R | TaskRequirements<CatchReasonHandlerResult<H>>
  >
  public static catchReasons<
    A,
    E,
    R,
    const ErrorTag extends TagsWithReasonOf<E>,
    const H extends object,
  >(
    errorTag: ErrorTag,
    handlers: H & TaskReasonHandlers<E, ErrorTag, H>,
  ): (
    task: ResultTask<A, E, R>,
  ) => ResultTask<
    A | TaskSuccess<CatchReasonHandlerResult<H>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>
    | TaskError<CatchReasonHandlerResult<H>>,
    R | TaskRequirements<CatchReasonHandlerResult<H>>
  >
  public static catchReasons<const ErrorTag extends string, const H extends object>(
    errorTag: ErrorTag,
    handlers: H,
  ): <A, E, R>(
    task: ResultTask<A, E, R> &
      (ErrorTag extends TagsWithReasonOf<E>
        ? H extends TaskReasonHandlers<E, ErrorTag, H>
          ? unknown
          : never
        : never),
  ) => ResultTask<
    A | TaskSuccess<CatchReasonHandlerResult<H>>,
    | ExcludeReasonTag<E, ErrorTag, CoveredHandlerKeys<H> & string>
    | TaskError<CatchReasonHandlerResult<H>>,
    R | TaskRequirements<CatchReasonHandlerResult<H>>
  >
  public static catchReasons(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'string')
      return (
        task: ResultTask<
          unknown,
          { readonly _tag: string; readonly reason: { readonly _tag: string } },
          unknown
        >,
      ) => task.catchReasons(args[0] as string, args[1] as object)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.catchReasons requires a task')
    return (
      task as ResultTask<
        unknown,
        { readonly _tag: string; readonly reason: { readonly _tag: string } },
        unknown
      >
    ).catchReasons(args[1] as string, args[2] as object)
  }

  /** Moves the nested reason of a tagged error into the error channel in direct or pipe-friendly form. */
  public static unwrapReason<A, E, R, const ErrorTag extends TagsWithReasonOf<E>>(
    task: ResultTask<A, E, R>,
    errorTag: ErrorTag,
  ): ResultTask<A, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>, R>
  public static unwrapReason<const ErrorTag extends string>(
    errorTag: ErrorTag,
  ): <A, E, R>(
    task: ResultTask<A, E, R> & (ErrorTag extends TagsWithReasonOf<E> ? unknown : never),
  ) => ResultTask<A, ExcludeTag<E, ErrorTag> | ReasonsOf<E, ErrorTag>, R>
  public static unwrapReason(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'string')
      return (
        task: ResultTask<
          unknown,
          { readonly _tag: string; readonly reason: { readonly _tag: string } },
          unknown
        >,
      ) => task.unwrapReason(args[0] as string)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.unwrapReason requires a task')
    return (
      task as ResultTask<
        unknown,
        { readonly _tag: string; readonly reason: { readonly _tag: string } },
        unknown
      >
    ).unwrapReason(args[1] as string)
  }

  /**
   * Recovers from any non-external-interruption failure cause (`Fail`, `Die`, `Sequential`,
   * `Parallel`, or internal `Interrupt`) using the canonical functional form or curried for `pipe`.
   */
  public static catchCause<
    A,
    E,
    R,
    Next extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    task: ResultTask<A, E, R>,
    onCause: (cause: Cause<E>) => Next,
  ): ResultTask<A | TaskSuccess<Next>, TaskError<Next>, R | TaskRequirements<Next>>
  public static catchCause<
    E,
    Next extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    onCause: (cause: Cause<E>) => Next,
  ): <A, R>(
    task: ResultTask<A, E, R>,
  ) => ResultTask<A | TaskSuccess<Next>, TaskError<Next>, R | TaskRequirements<Next>>
  public static catchCause(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function') {
      const onCause = args[0] as (
        cause: Cause<unknown>,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
      return (task: ResultTask<unknown, unknown, unknown>) => task.catchCause(onCause)
    }
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.catchCause requires a task')
    return task.catchCause(
      args[1] as (
        cause: Cause<unknown>,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    )
  }

  /** Exposes the full failure `Cause<E>` in the typed error channel, directly or curried for `pipe`. */
  public static sandbox<
    Args extends readonly [task: ResultTask<unknown, unknown, unknown>] | readonly [] = readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultTask<infer Value, infer ErrorValue, infer Requirements>]
    ? ResultTask<Value, Cause<ErrorValue>, Requirements>
    : <Value, ErrorValue, Requirements>(
        task: ResultTask<Value, ErrorValue, Requirements>,
      ) => ResultTask<Value, Cause<ErrorValue>, Requirements> {
    if (args.length > 0) {
      const task = args[0]
      if (!isResultTask(task)) throw new TypeError('ResultTask.sandbox requires a task')
      return task.sandbox() as never
    }
    return ((self: ResultTask<unknown, unknown, unknown>) => self.sandbox()) as never
  }

  /** Restores a sandboxed `Cause<E>` from the typed error channel back into the runtime failure cause. */
  public static unsandbox<
    Args extends readonly [task: ResultTask<unknown, Cause<unknown>, unknown>] | readonly [] =
      readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultTask<infer Value, Cause<infer ErrorValue>, infer Requirements>]
    ? ResultTask<Value, ErrorValue, Requirements>
    : <Value, ErrorValue, Requirements>(
        task: ResultTask<Value, Cause<ErrorValue>, Requirements>,
      ) => ResultTask<Value, ErrorValue, Requirements> {
    if (args.length > 0) {
      const task = args[0]
      if (!isResultTask(task)) throw new TypeError('ResultTask.unsandbox requires a task')
      return (task as ResultTask<unknown, Cause<unknown>, unknown>).unsandbox() as never
    }
    return ((self: ResultTask<unknown, Cause<unknown>, unknown>) => self.unsandbox()) as never
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
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.tap requires a side-effect function')
        return task.tap(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A, E | E2, R | R2>
      | (<E3, R3>(task: ResultTask<A, E3, R3>) => ResultTask<A, E3 | E2, R3 | R2>)
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
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.tapError requires an error side-effect function')
        return task.tapError(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A, E | E2, R | R2>
      | (<A3, R3>(task: ResultTask<A3, E, R3>) => ResultTask<A3, E | E2, R3 | R2>)
  }

  /** Executes an effectful side effect on the full failure `Cause<E>`, using the canonical functional form or curried for `pipe`. */
  public static tapCause<A, E, R, E2 = never, R2 = never>(
    task: ResultTask<A, E, R>,
    f: (cause: Cause<E>) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): ResultTask<A, E | E2, R | R2>
  public static tapCause<E, E2 = never, R2 = never>(
    f: (cause: Cause<E>) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2, R | R2>
  public static tapCause<A, E, R, E2 = never, R2 = never>(
    taskOrF:
      | ResultTask<A, E, R>
      | ((cause: Cause<E>) => ResultTask<unknown, E2, R2> | Promise<unknown> | void),
    f?: (cause: Cause<E>) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
  ):
    | ResultTask<A, E | E2, R | R2>
    | (<A3, R3>(task: ResultTask<A3, E, R3>) => ResultTask<A3, E | E2, R3 | R2>) {
    return dual(
      (args) => typeof args[0] !== 'function',
      (task: ResultTask<A, E, R>, callback: typeof f) => {
        if (callback === undefined)
          throw new TypeError('ResultTask.tapCause requires a cause side-effect function')
        return task.tapCause(callback)
      },
    )(taskOrF, f) as
      | ResultTask<A, E | E2, R | R2>
      | (<A3, R3>(task: ResultTask<A3, E, R3>) => ResultTask<A3, E | E2, R3 | R2>)
  }

  /** Executes a side effect on the success value or simple typed error value using the canonical functional form or curried for `pipe`. */
  public static tapBoth<A, E, R, E2 = never, R2 = never, E3 = never, R3 = never>(
    task: ResultTask<A, E, R>,
    handlers: ResultTaskMatchOptions<
      A,
      E,
      ResultTask<unknown, E2, R2> | Promise<unknown> | void,
      ResultTask<unknown, E3, R3> | Promise<unknown> | void
    >,
  ): ResultTask<A, E | E2 | E3, R | R2 | R3>
  public static tapBoth<A, E, R, E2 = never, R2 = never, E3 = never, R3 = never>(
    task: ResultTask<A, E, R>,
    onOk: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
    onErr: (error: E) => ResultTask<unknown, E3, R3> | Promise<unknown> | void,
  ): ResultTask<A, E | E2 | E3, R | R2 | R3>
  public static tapBoth<A, E, E2 = never, R2 = never, E3 = never, R3 = never>(
    handlers: ResultTaskMatchOptions<
      A,
      E,
      ResultTask<unknown, E2, R2> | Promise<unknown> | void,
      ResultTask<unknown, E3, R3> | Promise<unknown> | void
    >,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2 | E3, R | R2 | R3>
  public static tapBoth<A, E, E2 = never, R2 = never, E3 = never, R3 = never>(
    onOk: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void,
    onErr: (error: E) => ResultTask<unknown, E3, R3> | Promise<unknown> | void,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2 | E3, R | R2 | R3>
  public static tapBoth(...args: readonly unknown[]): unknown {
    if (isResultTask(args[0])) {
      return args[0].tapBoth(args[1] as never, args[2] as never)
    }
    return (task: ResultTask<unknown, unknown, unknown>) =>
      task.tapBoth(args[0] as never, args[1] as never)
  }

  /** Replaces the success value with a constant using the canonical functional form or curried for `pipe`. */
  public static inspect<A, E, R>(
    task: ResultTask<A, E, R>,
    f: (value: A) => unknown,
  ): ResultTask<A, E, R>
  public static inspect<A>(
    f: (value: A) => unknown,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static inspect(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.inspect(args[0] as (value: unknown) => unknown)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.inspect requires a task')
    return task.inspect(args[1] as (value: unknown) => unknown)
  }

  public static inspectError<A, E, R>(
    task: ResultTask<A, E, R>,
    f: (error: E) => unknown,
  ): ResultTask<A, E, R>
  public static inspectError<E>(
    f: (error: E) => unknown,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static inspectError(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.inspectError(args[0] as (error: unknown) => unknown)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.inspectError requires a task')
    return task.inspectError(args[1] as (error: unknown) => unknown)
  }

  /** Synchronously observes the full failure `Cause<E>`, using the canonical functional form or curried for `pipe`. */
  public static inspectCause<A, E, R>(
    task: ResultTask<A, E, R>,
    f: (cause: Cause<E>) => unknown,
  ): ResultTask<A, E, R>
  public static inspectCause<E>(
    f: (cause: Cause<E>) => unknown,
  ): <A, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static inspectCause(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.inspectCause(args[0] as (cause: Cause<unknown>) => unknown)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.inspectCause requires a task')
    return task.inspectCause(args[1] as (cause: Cause<unknown>) => unknown)
  }

  /** Observes both success and simple typed failure using the canonical functional form or curried for `pipe`. */
  public static inspectBoth<A, E, R>(
    task: ResultTask<A, E, R>,
    handlers: ResultTaskMatchOptions<A, E, unknown, unknown>,
  ): ResultTask<A, E, R>
  public static inspectBoth<A, E, R>(
    task: ResultTask<A, E, R>,
    onOk: (value: A) => unknown,
    onErr: (error: E) => unknown,
  ): ResultTask<A, E, R>
  public static inspectBoth<A, E>(
    handlers: ResultTaskMatchOptions<A, E, unknown, unknown>,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static inspectBoth<A, E>(
    onOk: (value: A) => unknown,
    onErr: (error: E) => unknown,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static inspectBoth(...args: readonly unknown[]): unknown {
    if (isResultTask(args[0])) {
      return args[0].inspectBoth(args[1] as never, args[2] as never)
    }
    return (task: ResultTask<unknown, unknown, unknown>) =>
      task.inspectBoth(args[0] as never, args[1] as never)
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

  /** Replaces the success value with `undefined` (`void`), directly or curried for `pipe`. */
  public static asVoid<
    Args extends readonly [task: ResultTask<unknown, unknown, unknown>] | readonly [] = readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultTask<unknown, infer ErrorValue, infer Requirements>]
    ? ResultTask<void, ErrorValue, Requirements>
    : <Value, ErrorValue, Requirements>(
        task: ResultTask<Value, ErrorValue, Requirements>,
      ) => ResultTask<void, ErrorValue, Requirements> {
    if (args.length > 0) {
      const task = args[0]
      if (!isResultTask(task)) throw new TypeError('ResultTask.asVoid requires a task')
      return task.asVoid() as never
    }
    return ((self: ResultTask<unknown, unknown, unknown>) => self.asVoid()) as never
  }

  /** Delays execution of `task` by `milliseconds` using the current run's clock. */
  public static delay<A, E, R>(task: ResultTask<A, E, R>, milliseconds: number): ResultTask<A, E, R>
  public static delay(
    milliseconds: number,
  ): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  public static delay(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'number') {
      const milliseconds = checkedDuration(args[0])
      return (task: ResultTask<unknown, unknown, unknown>) => ResultTask.delay(task, milliseconds)
    }
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.delay requires a task')
    const milliseconds = checkedDuration(args[1] as number)
    return ResultTask.sleep(milliseconds).andThen(() => task)
  }

  /** Measures the execution duration of `task` in milliseconds using the current run's clock. */
  public static timed<
    Args extends readonly [task: ResultTask<unknown, unknown, unknown>] | readonly [] = readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultTask<infer Value, infer ErrorValue, infer Requirements>]
    ? ResultTask<[durationMs: number, value: Value], ErrorValue, Requirements>
    : <Value, ErrorValue, Requirements>(
        task: ResultTask<Value, ErrorValue, Requirements>,
      ) => ResultTask<[durationMs: number, value: Value], ErrorValue, Requirements> {
    if (args.length === 0) {
      return ((self: ResultTask<unknown, unknown, unknown>) => ResultTask.timed(self)) as never
    }
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.timed requires a task')
    return new ResultTask(async (context) => {
      const startedAt = context.clock.now()
      const exit = await task.execute(context)
      const resolved = interruptSuccess(exit, context.signal)
      if (resolved._tag === 'Failure') return resolved
      const durationMs = Math.max(0, context.clock.now() - startedAt)
      return success([durationMs, resolved.value])
    }) as never
  }

  static #ensuring(
    args: readonly unknown[],
    caller: 'ResultTask.ensuring' | 'ResultTask.onExit',
  ): unknown {
    if (typeof args[0] === 'function') {
      const finalizer = args[0] as (
        exit: Exit<unknown, unknown>,
      ) => ResultTask<unknown, unknown, unknown> | Promise<unknown> | void
      return (task: ResultTask<unknown, unknown, unknown>) =>
        ResultTask.#ensuring([task, finalizer], caller)
    }
    const task = args[0]
    const finalizer = args[1]
    if (!isResultTask(task)) throw new TypeError(`${caller} requires a task`)
    if (typeof finalizer !== 'function')
      throw new TypeError(`${caller} requires a finalizer function`)
    return new ResultTask(async (context) => {
      const exit = await task.execute(context)
      const finalExit = interruptSuccess(exit, context.signal)
      const scope = new TaskScope()
      const cleanupContext = withCleanupScope(context, scope)
      let released: Exit<unknown, unknown> = success(undefined)
      try {
        const res = (finalizer as (outcome: Exit<unknown, unknown>) => unknown)(finalExit)
        if (isResultTask(res)) {
          released = await res.execute(cleanupContext)
        } else {
          await res
        }
      } catch (error) {
        released = died(error)
      }
      const closed = completeCleanup(await scope.close(released), cleanupContext)
      if (closed._tag === 'Failure') {
        markCleanupCause(closed.cause)
      }
      return combineExits(finalExit, closed, 'Sequential')
    })
  }

  /**
   * Runs `finalizer` unconditionally after `task` finishes with `Success`, `Fail`, `Die`, or
   * `Interrupt`. Finalizer failures and defects are combined sequentially with the task outcome.
   */
  public static ensuring<A, E, R, ReleaseError = never, ReleaseR = never>(
    task: ResultTask<A, E, R>,
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>>
  public static ensuring<A, E, ReleaseError = never, ReleaseR = never>(
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): <R>(
    task: ResultTask<A, E, R>,
  ) => ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>>
  public static ensuring(...args: readonly unknown[]): unknown {
    return ResultTask.#ensuring(args, 'ResultTask.ensuring')
  }

  /**
   * Alias of `ResultTask.ensuring` that mirrors Effect's `Effect.onExit`: runs `finalizer`
   * unconditionally after `task` completes with `Exit<A, E>`.
   */
  public static onExit<A, E, R, ReleaseError = never, ReleaseR = never>(
    task: ResultTask<A, E, R>,
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>>
  public static onExit<A, E, ReleaseError = never, ReleaseR = never>(
    finalizer: (
      exit: Exit<A, E>,
    ) => ResultTask<unknown, ReleaseError, ReleaseR> | Promise<unknown> | void,
  ): <R>(
    task: ResultTask<A, E, R>,
  ) => ResultTask<A, E | ReleaseError | ScopeError<ReleaseR>, R | WithoutScope<ReleaseR>>
  public static onExit(...args: readonly unknown[]): unknown {
    return ResultTask.#ensuring(args, 'ResultTask.onExit')
  }

  /**
   * Combines two tasks (or a task and a synchronous `Result`) into a tuple `[A, B]`.
   * Pass `{ concurrent: true }` to execute both tasks concurrently with structured interruption.
   */
  public static zip<A, E, R, B, E2 = never, R2 = never>(
    left: ResultTask<A, E, R>,
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: { readonly concurrent?: false },
  ): ResultTask<[A, B], E | E2, R | R2>
  public static zip<A, E, R, B, E2 = never, R2 = never>(
    left: ResultTask<A, E, R>,
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options: { readonly concurrent: true },
  ): ResultTask<[A, B], E | E2 | ScopeError<R | R2>, WithoutScope<R | R2>>
  public static zip<A, E, R, B, E2 = never, R2 = never>(
    left: ResultTask<A, E, R>,
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: ResultTaskZipOptions,
  ): ResultTask<[A, B], E | E2 | ScopeError<R | R2>, R | R2>
  public static zip<B, E2 = never, R2 = never>(
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: { readonly concurrent?: false },
  ): <A, E, R>(left: ResultTask<A, E, R>) => ResultTask<[A, B], E | E2, R | R2>
  public static zip<B, E2 = never, R2 = never>(
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options: { readonly concurrent: true },
  ): <A, E, R>(
    left: ResultTask<A, E, R>,
  ) => ResultTask<[A, B], E | E2 | ScopeError<R | R2>, WithoutScope<R | R2>>
  public static zip<B, E2 = never, R2 = never>(
    right: ResultTask<B, E2, R2> | Result<B, E2>,
    options?: ResultTaskZipOptions,
  ): <A, E, R>(left: ResultTask<A, E, R>) => ResultTask<[A, B], E | E2 | ScopeError<R | R2>, R | R2>
  public static zip(...args: readonly unknown[]): unknown {
    if (isResultTask(args[1]) || isSyncResult(args[1])) {
      const left = args[0]
      if (!isResultTask(left)) throw new TypeError('ResultTask.zip requires a task')
      return left.zip(args[1], validateZipOptions(args[2]))
    }
    const right = args[0] as ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    const options = validateZipOptions(args[1])
    return (left: ResultTask<unknown, unknown, unknown>) => left.zip(right, options)
  }

  static async #evaluateCondition(
    condition: ResultTaskCondition<unknown, unknown>,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<boolean, unknown>> {
    try {
      const evaluated = typeof condition === 'function' ? condition() : condition
      if (typeof evaluated === 'boolean') {
        return success(evaluated)
      }
      if (isResultTask(evaluated)) {
        return interruptSuccess(await evaluated.execute(context), context.signal) as Exit<
          boolean,
          unknown
        >
      }
      return evaluated.isOk() ? success(evaluated.value) : failed(evaluated.error)
    } catch (error) {
      return died(error)
    }
  }

  static async #executeBranch(
    branch:
      | ResultTask<unknown, unknown, unknown>
      | Result<unknown, unknown>
      | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>),
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<unknown, unknown>> {
    try {
      const target = typeof branch === 'function' ? branch() : branch
      if (isResultTask(target)) {
        return await target.execute(context)
      }
      return target.isOk() ? success(target.value) : failed(target.error)
    } catch (error) {
      return died(error)
    }
  }

  /**
   * Runs candidate tasks sequentially until the first `Success`, or fails with the last candidate's
   * typed error when all candidates fail. Empty candidate collections defect with `EmptyResultsCollectionError`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const resolved = ResultTask.firstSuccessOf([
   *   () => ResultTask.fail('cache-miss' as const),
   *   () => ResultTask.ok('primary-value'),
   * ])
   * ```
   */
  public static firstSuccessOf<
    const Candidates extends Iterable<
      | ResultTask<unknown, unknown, unknown>
      | Result<unknown, unknown>
      | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>)
    >,
  >(
    candidates: Candidates,
  ): ResultTask<
    TaskSuccess<TaskCandidate<Candidates extends Iterable<infer Item> ? Item : never>>,
    TaskError<TaskCandidate<Candidates extends Iterable<infer Item> ? Item : never>>,
    TaskRequirements<TaskCandidate<Candidates extends Iterable<infer Item> ? Item : never>>
  > {
    return new ResultTask(async (context) => {
      let lastExit: Exit<unknown, unknown> | undefined = undefined
      for (const candidate of candidates) {
        if (context.signal.aborted) return interrupted(context.signal)
        // eslint-disable-next-line no-await-in-loop
        const exit = await ResultTask.#executeBranch(candidate, context)
        const resolved = interruptSuccess(exit, context.signal)
        if (resolved._tag === 'Success') {
          return resolved
        }
        if (resolved.cause._tag !== 'Fail') {
          return resolved
        }
        lastExit = resolved
      }
      return lastExit ?? died(createEmptyResultsCollectionError())
    })
  }

  /**
   * Chooses between `onTrue` and `onFalse` based on a boolean, `Result<boolean>`, or `ResultTask<boolean>` condition.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const routed = ResultTask.if(ResultTask.ok(true), {
   *   onTrue: () => ResultTask.ok('enabled'),
   *   onFalse: () => ResultTask.ok('disabled'),
   * })
   * ```
   */
  public static if<
    Cond extends ResultTaskCondition<unknown, unknown>,
    TrueTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    FalseTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    condition: Cond,
    branches: ResultTaskIfBranches<TrueTask, FalseTask>,
  ): ResultTask<
    TaskSuccess<TrueTask> | TaskSuccess<FalseTask>,
    ConditionError<Cond> | TaskError<TrueTask> | TaskError<FalseTask>,
    ConditionRequirements<Cond> | TaskRequirements<TrueTask> | TaskRequirements<FalseTask>
  >
  public static if<
    TrueTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
    FalseTask extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    branches: ResultTaskIfBranches<TrueTask, FalseTask>,
  ): <Cond extends ResultTaskCondition<unknown, unknown>>(
    condition: Cond,
  ) => ResultTask<
    TaskSuccess<TrueTask> | TaskSuccess<FalseTask>,
    ConditionError<Cond> | TaskError<TrueTask> | TaskError<FalseTask>,
    ConditionRequirements<Cond> | TaskRequirements<TrueTask> | TaskRequirements<FalseTask>
  >
  public static if(...args: readonly unknown[]): unknown {
    if (args.length === 1) {
      const branches = args[0] as ResultTaskIfBranches<
        ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
        ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
      >
      return (condition: ResultTaskCondition<unknown, unknown>) =>
        ResultTask.if(condition, branches)
    }
    const condition = args[0] as ResultTaskCondition<unknown, unknown>
    const branches = args[1] as ResultTaskIfBranches<
      ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
      ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    >
    return new ResultTask(async (context) => {
      const condExit = await ResultTask.#evaluateCondition(condition, context)
      if (condExit._tag === 'Failure') return condExit
      return ResultTask.#executeBranch(condExit.value ? branches.onTrue : branches.onFalse, context)
    })
  }

  static #whenByPredicate(
    condition: ResultTaskCondition<unknown, unknown>,
    body:
      | ResultTask<unknown, unknown, unknown>
      | Result<unknown, unknown>
      | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>),
    predicate: (value: boolean) => boolean,
  ): ResultTask<unknown, unknown, unknown> {
    return new ResultTask(async (context) => {
      const condExit = await ResultTask.#evaluateCondition(condition, context)
      if (condExit._tag === 'Failure') return condExit
      if (!predicate(condExit.value)) return success(undefined)
      return ResultTask.#executeBranch(body, context)
    })
  }

  /**
   * Runs `body` only when `condition` resolves to `true`; otherwise succeeds with `undefined`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const maybeAudit = ResultTask.when(true, () => ResultTask.ok('audited'))
   * ```
   */
  public static when<
    Cond extends ResultTaskCondition<unknown, unknown>,
    Body extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    condition: Cond,
    body: Body | (() => Body),
  ): ResultTask<
    TaskSuccess<Body> | undefined,
    ConditionError<Cond> | TaskError<Body>,
    ConditionRequirements<Cond> | TaskRequirements<Body>
  >
  public static when<Cond extends ResultTaskCondition<unknown, unknown>>(
    condition: Cond,
  ): <Body extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>>(
    body: Body | (() => Body),
  ) => ResultTask<
    TaskSuccess<Body> | undefined,
    ConditionError<Cond> | TaskError<Body>,
    ConditionRequirements<Cond> | TaskRequirements<Body>
  >
  public static when(...args: readonly unknown[]): unknown {
    const condition = args[0] as ResultTaskCondition<unknown, unknown>
    if (args.length === 1) {
      return (
        body:
          | ResultTask<unknown, unknown, unknown>
          | Result<unknown, unknown>
          | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>),
      ) => ResultTask.when(condition, body)
    }
    const body = args[1] as
      | ResultTask<unknown, unknown, unknown>
      | Result<unknown, unknown>
      | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>)
    return ResultTask.#whenByPredicate(condition, body, (value) => value)
  }

  /**
   * Runs `body` only when `condition` resolves to `false`; otherwise succeeds with `undefined`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const maybeSeed = ResultTask.unless(false, () => ResultTask.ok('seeded'))
   * ```
   */
  public static unless<
    Cond extends ResultTaskCondition<unknown, unknown>,
    Body extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    condition: Cond,
    body: Body | (() => Body),
  ): ResultTask<
    TaskSuccess<Body> | undefined,
    ConditionError<Cond> | TaskError<Body>,
    ConditionRequirements<Cond> | TaskRequirements<Body>
  >
  public static unless<Cond extends ResultTaskCondition<unknown, unknown>>(
    condition: Cond,
  ): <Body extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>>(
    body: Body | (() => Body),
  ) => ResultTask<
    TaskSuccess<Body> | undefined,
    ConditionError<Cond> | TaskError<Body>,
    ConditionRequirements<Cond> | TaskRequirements<Body>
  >
  public static unless(...args: readonly unknown[]): unknown {
    const condition = args[0] as ResultTaskCondition<unknown, unknown>
    if (args.length === 1) {
      return (
        body:
          | ResultTask<unknown, unknown, unknown>
          | Result<unknown, unknown>
          | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>),
      ) => ResultTask.unless(condition, body)
    }
    const body = args[1] as
      | ResultTask<unknown, unknown, unknown>
      | Result<unknown, unknown>
      | (() => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>)
    return ResultTask.#whenByPredicate(condition, body, (value) => !value)
  }

  static #trySyncStep<S, A>(fn: (state: S) => A, state: S): Exit<A, never> {
    try {
      return success(fn(state))
    } catch (error) {
      return died(error)
    }
  }

  static #runLoop(
    initial: unknown,
    options: {
      readonly while: (state: unknown) => boolean
      readonly step: (state: unknown) => unknown
      readonly body: (
        state: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
      readonly discard?: boolean
    },
  ): ResultTask<unknown, unknown, unknown> {
    return new ResultTask(async (context) => {
      const values: unknown[] | undefined = options.discard === true ? undefined : []
      let state = initial
      for (;;) {
        if (context.signal.aborted) return interrupted(context.signal)
        const currentState = state
        const shouldContinue = ResultTask.#trySyncStep(options.while, currentState)
        if (shouldContinue._tag === 'Failure') return shouldContinue
        if (!shouldContinue.value) return success(values)
        // eslint-disable-next-line no-await-in-loop
        const stepExit = await ResultTask.#executeBranch(() => options.body(currentState), context)
        const resolved = interruptSuccess(stepExit, context.signal)
        if (resolved._tag === 'Failure') return resolved
        values?.push(resolved.value)
        const nextState = ResultTask.#trySyncStep(options.step, currentState)
        if (nextState._tag === 'Failure') return nextState
        state = nextState.value
      }
    })
  }

  /**
   * Repeats a task-producing body while `while(state)` holds, advancing state with `step(state)`.
   * Pass `discard: true` to return `void` instead of collecting step values.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const pages = ResultTask.loop(1, {
   *   while: (page) => page <= 3,
   *   step: (page) => page + 1,
   *   body: (page) => ResultTask.ok(`page:${page}`),
   * })
   * ```
   */
  public static loop<
    State,
    BodyState extends State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    initial: State,
    options: ResultTaskLoopOptions<State, BodyState, R>,
  ): ResultTask<readonly TaskSuccess<R>[], TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    initial: State,
    options: ResultTaskLoopBooleanOptions<State, R>,
  ): ResultTask<readonly TaskSuccess<R>[], TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    BodyState extends State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    initial: State,
    options: ResultTaskLoopDiscardOptions<State, BodyState, R>,
  ): ResultTask<void, TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    initial: State,
    options: ResultTaskLoopBooleanDiscardOptions<State, R>,
  ): ResultTask<void, TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    BodyState extends State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    options: ResultTaskLoopOptions<State, BodyState, R>,
  ): (initial: State) => ResultTask<readonly TaskSuccess<R>[], TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    options: ResultTaskLoopBooleanOptions<State, R>,
  ): (initial: State) => ResultTask<readonly TaskSuccess<R>[], TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    BodyState extends State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    options: ResultTaskLoopDiscardOptions<State, BodyState, R>,
  ): (initial: State) => ResultTask<void, TaskError<R>, TaskRequirements<R>>
  public static loop<
    State,
    R extends ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>,
  >(
    options: ResultTaskLoopBooleanDiscardOptions<State, R>,
  ): (initial: State) => ResultTask<void, TaskError<R>, TaskRequirements<R>>
  public static loop(...args: readonly unknown[]): unknown {
    if (args.length === 1) {
      const options = args[0] as {
        readonly while: (state: unknown) => boolean
        readonly step: (state: unknown) => unknown
        readonly body: (
          state: unknown,
        ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
        readonly discard?: boolean
      }
      return (initial: unknown) => ResultTask.#runLoop(initial, options)
    }
    return ResultTask.#runLoop(
      args[0],
      args[1] as {
        readonly while: (state: unknown) => boolean
        readonly step: (state: unknown) => unknown
        readonly body: (
          state: unknown,
        ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
        readonly discard?: boolean
      },
    )
  }

  static #runIterate(
    initial: unknown,
    options: {
      readonly while: (state: unknown) => boolean
      readonly body: (
        state: unknown,
      ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
    },
  ): ResultTask<unknown, unknown, unknown> {
    return new ResultTask(async (context) => {
      let state = initial
      for (;;) {
        const currentState = state
        const shouldContinue = ResultTask.#trySyncStep(options.while, currentState)
        if (shouldContinue._tag === 'Failure') return shouldContinue
        if (!shouldContinue.value) return success(currentState)
        // eslint-disable-next-line no-await-in-loop
        const stepExit = await ResultTask.#executeBranch(() => options.body(currentState), context)
        const resolved = interruptSuccess(stepExit, context.signal)
        if (resolved._tag === 'Failure') return resolved
        state = resolved.value
      }
    })
  }

  /**
   * Repeatedly transforms state with `body(state)` while `while(state)` holds.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const total = ResultTask.iterate(1, {
   *   while: (n) => n < 8,
   *   body: (n) => ResultTask.ok(n * 2),
   * })
   * ```
   */
  public static iterate<
    State,
    BodyState extends WidenTaskLiteral<State>,
    R extends
      | ResultTask<WidenTaskLiteral<State>, unknown, unknown>
      | Result<WidenTaskLiteral<State>, unknown>,
  >(
    initial: State,
    options: ResultTaskIterateOptions<WidenTaskLiteral<State>, BodyState, R>,
  ): ResultTask<WidenTaskLiteral<State>, TaskError<R>, TaskRequirements<R>>
  public static iterate<
    State,
    R extends
      | ResultTask<WidenTaskLiteral<State>, unknown, unknown>
      | Result<WidenTaskLiteral<State>, unknown>,
  >(
    initial: State,
    options: ResultTaskIterateBooleanOptions<WidenTaskLiteral<State>, R>,
  ): ResultTask<WidenTaskLiteral<State>, TaskError<R>, TaskRequirements<R>>
  public static iterate<
    State,
    BodyState extends State,
    R extends ResultTask<State, unknown, unknown> | Result<State, unknown>,
  >(
    options: ResultTaskIterateOptions<State, BodyState, R>,
  ): (initial: State) => ResultTask<State, TaskError<R>, TaskRequirements<R>>
  public static iterate<
    State,
    R extends ResultTask<State, unknown, unknown> | Result<State, unknown>,
  >(
    options: ResultTaskIterateBooleanOptions<State, R>,
  ): (initial: State) => ResultTask<State, TaskError<R>, TaskRequirements<R>>
  public static iterate(...args: readonly unknown[]): unknown {
    if (args.length === 1) {
      const options = args[0] as {
        readonly while: (state: unknown) => boolean
        readonly body: (
          state: unknown,
        ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
      }
      return (initial: unknown) => ResultTask.#runIterate(initial, options)
    }
    return ResultTask.#runIterate(
      args[0],
      args[1] as {
        readonly while: (state: unknown) => boolean
        readonly body: (
          state: unknown,
        ) => ResultTask<unknown, unknown, unknown> | Result<unknown, unknown>
      },
    )
  }

  /** Validates or narrows success using the canonical functional form or curried for `pipe`. */
  public static filterOrElse<A, B extends A, E, R, E2>(
    task: ResultTask<A, E, R>,
    predicate: (value: A) => value is B,
    onFalse: (value: A) => E2,
  ): ResultTask<B, E | E2, R>
  public static filterOrElse<A, E, R, E2>(
    task: ResultTask<A, E, R>,
    predicate: (value: A) => boolean,
    onFalse: (value: A) => E2,
  ): ResultTask<A, E | E2, R>
  public static filterOrElse<A, B extends A, E2>(
    predicate: (value: A) => value is B,
    onFalse: (value: A) => E2,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<B, E | E2, R>
  public static filterOrElse<A, E2>(
    predicate: (value: A) => boolean,
    onFalse: (value: A) => E2,
  ): <E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E | E2, R>
  public static filterOrElse(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.filterOrElse(
          args[0] as (value: unknown) => boolean,
          args[1] as (value: unknown) => unknown,
        )
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.filterOrElse requires a task')
    return task.filterOrElse(
      args[1] as (value: unknown) => boolean,
      args[2] as (value: unknown) => unknown,
    )
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

  /** Exhaustively matches success and tagged error cases using the canonical functional form or curried for `pipe`. */
  public static matchTags<A, E, R, B, const Handlers extends object>(
    task: ResultTask<A, E, R>,
    onOk: (value: A) => B,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): ResultTask<B | MatchTagHandlerResult<Handlers>, never, R>
  public static matchTags<A, E, B, const Handlers extends object, R = never>(
    onOk: (value: A) => B,
    handlers: Handlers & MatchTagHandlers<E, Handlers>,
  ): (task: ResultTask<A, E, R>) => ResultTask<B | MatchTagHandlerResult<Handlers>, never, R>
  public static matchTags(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.matchTags(args[0] as (value: unknown) => unknown, args[1] as never)
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.matchTags requires a task')
    return task.matchTags(args[1] as (value: unknown) => unknown, args[2] as never)
  }

  /* eslint-disable max-params */
  /** Partially matches tagged error cases with a narrowed fallback using the canonical functional form or curried for `pipe`. */
  public static matchTagsPartial<A, E, R, B, C, const Handlers extends object>(
    task: ResultTask<A, E, R>,
    onOk: (value: A) => B,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: RemainingMatchTagErrors<E, Handlers>) => C,
  ): ResultTask<B | MatchTagHandlerResult<Handlers> | C, never, R>
  public static matchTagsPartial<A, E, B, C, const Handlers extends object, R = never>(
    onOk: (value: A) => B,
    handlers: Handlers & PartialMatchTagHandlers<E, Handlers>,
    fallback: (error: RemainingMatchTagErrors<E, Handlers>) => C,
  ): (task: ResultTask<A, E, R>) => ResultTask<B | MatchTagHandlerResult<Handlers> | C, never, R>
  public static matchTagsPartial(...args: readonly unknown[]): unknown {
    if (typeof args[0] === 'function')
      return (task: ResultTask<unknown, unknown, unknown>) =>
        task.matchTagsPartial(
          args[0] as (value: unknown) => unknown,
          args[1] as never,
          args[2] as (error: unknown) => unknown,
        )
    const task = args[0]
    if (!isResultTask(task)) throw new TypeError('ResultTask.matchTagsPartial requires a task')
    return task.matchTagsPartial(
      args[1] as (value: unknown) => unknown,
      args[2] as never,
      args[3] as (error: unknown) => unknown,
    )
  }
  /* eslint-enable max-params */

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
    const clock = options?.clock ?? Clock.live
    const context: ResultTaskRuntimeContext = {
      namedServices,
      services: new Map(),
      serviceResolver: undefined,
      signal,
      scope,
      clock,
      scheduling: createScheduling(clock, options),
      cleanup: undefined,
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

  /**
   * Starts an independent root fiber immediately. Its returned `FiberHandle` owns interruption,
   * status inspection, and finalization.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const fiber = ResultTask.runFork(ResultTask.sleep(10).as('done'))
   * const exit = await ResultTask.runExit(fiber.await())
   * ```
   */
  public static runFork<Task>(
    task: Task & (Task extends ResultTask<unknown, unknown, unknown> ? unknown : never),
    ...args: NoInfer<ResultTaskRunArguments<TaskRequirements<Task>>>
  ): FiberHandle<TaskSuccess<Task>, TaskError<Task> | ScopeError<TaskRequirements<Task>>>
  public static runFork<A, E>(task: ResultTask<A, E, never>): FiberHandle<A, E>
  public static runFork<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: NoInfer<ResultTaskRunArguments<R>>
  ): FiberHandle<A, E | ScopeError<R>>
  public static runFork<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: readonly [options?: ResultTaskRunOptions<R>]
  ): FiberHandle<A, E | ScopeError<R>> {
    const options: Partial<ResultTaskRunOptions<R>> = {}
    try {
      Object.assign(options, args[0])
    } catch (error) {
      return createFiberHandle({
        outcome: Promise.resolve(died(error)),
        interrupt: () => undefined,
        observe: () => undefined,
      })
    }
    const externalSignal = options.signal
    const controller = new AbortController()
    const onAbort = (): void => {
      controller.abort((externalSignal as unknown as AbortSignal).reason)
    }
    // Stryker disable next-line all: abort fires at most once and the listener is removed in finally; once:true is listener hygiene.
    externalSignal?.addEventListener('abort', onAbort, { once: true })
    if (externalSignal?.aborted === true) onAbort()
    // Replacing only the signal preserves the required service environment from the caller.
    const runOptions = Object.assign(options, {
      signal: controller.signal,
    }) as ResultTaskRunOptions<R>
    const outcome = ResultTask.runExitInternal(task, runOptions)
      // Stryker disable next-line all: runExitInternal catches defects into Exit; this catch is defensive against unexpected host promise rejections.
      .catch((error: unknown) => died(error) as Exit<A, E | ScopeError<R>>)
      .finally(() => {
        // Stryker disable next-line all: abort fires at most once; removing the listener after settlement is memory hygiene.
        externalSignal?.removeEventListener('abort', onAbort)
      })
    return createFiberHandle({
      outcome,
      interrupt: (reason) => {
        controller.abort(reason)
      },
      observe: () => undefined,
    })
  }

  /**
   * Runs a task and preserves success, typed failure, interruption, and runtime defects in an `Exit`
   * without rejecting the returned `Promise`.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const exit = await ResultTask.runExit(ResultTask.ok(42))
   * ```
   */
  public static runExit<Task>(
    task: Task & (Task extends ResultTask<unknown, unknown, unknown> ? unknown : never),
    ...args: NoInfer<ResultTaskRunArguments<TaskRequirements<Task>>>
  ): Promise<Exit<TaskSuccess<Task>, TaskError<Task> | ScopeError<TaskRequirements<Task>>>>
  public static runExit<A, E>(task: ResultTask<A, E, never>): Promise<Exit<A, E>>
  public static runExit<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: NoInfer<ResultTaskRunArguments<R>>
  ): Promise<Exit<A, E | ScopeError<R>>>
  public static runExit<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: readonly [options?: ResultTaskRunOptions<R>]
  ): Promise<Exit<A, E | ScopeError<R>>> {
    return ResultTask.runExitInternal(task, args[0])
  }

  /**
   * Runs a task and returns single typed failures as `Err<E>`; rejects defects (`Die`),
   * interruptions (`AbortError`), and composite causes (`ResultTaskCauseError`).
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const result = await ResultTask.runResult(ResultTask.ok(42))
   * ```
   */
  public static runResult<Task>(
    task: Task & (Task extends ResultTask<unknown, unknown, unknown> ? unknown : never),
    ...args: NoInfer<ResultTaskRunArguments<TaskRequirements<Task>>>
  ): Promise<Result<TaskSuccess<Task>, TaskError<Task> | ScopeError<TaskRequirements<Task>>>>
  public static runResult<A, E>(task: ResultTask<A, E, never>): Promise<Result<A, E>>
  public static runResult<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: NoInfer<ResultTaskRunArguments<R>>
  ): Promise<Result<A, E | ScopeError<R>>>
  public static runResult<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: readonly [options?: ResultTaskRunOptions<R>]
  ): Promise<Result<A, E | ScopeError<R>>> {
    return ResultTask.runResultInternal(task, args[0])
  }

  /**
   * Runs a task and resolves to the success value `A`, rejecting on typed failures, interruptions,
   * or runtime defects.
   *
   * @example
   * ```ts
   * import { ResultTask } from 'resultar'
   *
   * const value = await ResultTask.runPromise(ResultTask.ok(42))
   * ```
   */
  public static runPromise<Task>(
    task: Task & (Task extends ResultTask<unknown, unknown, unknown> ? unknown : never),
    ...args: NoInfer<ResultTaskRunArguments<TaskRequirements<Task>>>
  ): Promise<TaskSuccess<Task>>
  public static runPromise<A, E>(task: ResultTask<A, E, never>): Promise<A>
  public static runPromise<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: NoInfer<ResultTaskRunArguments<R>>
  ): Promise<A>
  public static async runPromise<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: readonly [options?: ResultTaskRunOptions<R>]
  ): Promise<A> {
    const result = await ResultTask.runResultInternal(task, args[0])
    return result.unwrapOrThrow()
  }
}
