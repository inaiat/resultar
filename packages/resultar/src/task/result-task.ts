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
  ResultAsyncCatchReasonHandlers,
  ResultAsyncCatchTagHandlers,
  TagsOf,
  TagsWithReasonOf,
} from '../tagged/tagged-types.js'
import type {
  ExtractErrAsyncTypes,
  ExtractOkAsyncTypes,
  InferAsyncErrTypes,
  InferAsyncOkTypes,
  InferErrTypes,
  InferOkTypes,
} from '../core/utils.js'
import { isError } from '../tagged/tagged-error.js'
import { type FnPipe, Pipeable, runFnPipe } from '../core/pipe.js'
import {
  type Combine,
  createEmptyResultsCollectionError,
  type Dedup,
  type EmptyArrayToNever,
  err,
  type IsLiteralArray,
  type MatchHandlers,
  type MemberListOf,
  type MembersToUnion,
  ok,
  Result,
} from '../result.js'
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
import { createFiberHandle, registerFiberTaskFactory, startDirectFiber } from './fiber-runtime.js'
import type { FiberTaskContext, RuntimeFiber, SupervisedFiber } from './fiber-runtime.js'
import { registerSemaphoreTaskFactory, Semaphore } from './semaphore.js'
import type { SemaphoreAcquire } from './semaphore.js'
import {
  combineExits,
  died,
  failed,
  failure,
  FiberSignal,
  interrupted,
  interruptSuccess,
  SUCCESS_UNDEFINED,
  success,
  toNativeAbortSignal,
} from './exit.js'
import { transformCause, withoutInterruptions } from './cause-transform.js'
import { detachedPromise, NEVER_ABORTED_SIGNAL } from './promise-interruption.js'

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

type ResultTaskExecutor = (
  context: ResultTaskRuntimeContext,
) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
type ResultTaskNestedExecutor = (
  task: ResultTask<unknown, unknown, unknown>,
) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>

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
  context.cleanup === undefined
    ? exit
    : (combineExits(exit, context.cleanup.schedulerFailure, 'Sequential') as Exit<A, E>)

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
  children: readonly SupervisedFiber[],
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
  value instanceof ServiceTagValue ||
  (isObjectLike(value) &&
    (value as Record<symbol, unknown>)[ServiceTagTypeId] === ServiceTagTypeId &&
    (value as { readonly _tag?: unknown })._tag === 'ServiceTag' &&
    typeof (value as { readonly identifier?: unknown }).identifier === 'string' &&
    typeof (value as { readonly key?: unknown }).key === 'symbol' &&
    typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function')

/** Returns true if a value is a `ResultTask` instance. */
export const isResultTask = (value: unknown): value is ResultTask<unknown, unknown, unknown> =>
  value instanceof ResultTask ||
  (isObjectLike(value) && (value as Record<symbol, unknown>)[ResultTaskTypeId] !== undefined)

const isResultTaskYield = (value: unknown): value is ResultTaskYield<unknown, unknown, unknown> =>
  // Stryker disable next-line ConditionalExpression,LogicalOperator: instanceof fast-path is equivalent to the structural brand check below.
  value instanceof ResultTaskIterator ||
  (isObjectLike(value) &&
    (value as Record<symbol, unknown>)[ResultTaskYieldTypeId] === ResultTaskYieldTypeId &&
    (value as { readonly _tag?: unknown })._tag === 'ResultTask' &&
    isResultTask((value as { readonly task?: unknown }).task))

const isServiceYield = (value: unknown): value is ResultTaskServiceYield<AnyServiceTag> =>
  // Stryker disable next-line ConditionalExpression,LogicalOperator: instanceof fast-path is equivalent to the structural brand check below.
  value instanceof ServiceTagIterator ||
  (isObjectLike(value) &&
    (value as Record<symbol, unknown>)[ResultTaskYieldTypeId] === ResultTaskYieldTypeId &&
    (value as { readonly _tag?: unknown })._tag === 'Service' &&
    isServiceTag((value as { readonly tag?: unknown }).tag))

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
const closeGeneratorAsync = async <Yield, Return, Next, E>(
  iterator: Generator<Yield, Return, Next>,
  state: { readonly initialStep: IteratorResult<Yield, Return>; readonly exit: Exit<Return, E> },
  runtime: ResultTaskCloseRuntime,
): Promise<Exit<Return, E>> => {
  try {
    let step = state.initialStep
    let finalExit = state.exit

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
  signal: NEVER_ABORTED_SIGNAL,
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

class ServiceTagIterator<
  Tag extends AnyServiceTag,
  Service,
> implements ResultTaskServiceYield<Tag> {
  public readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId = ResultTaskYieldTypeId
  public readonly _tag = 'Service' as const
  public readonly tag: Tag
  private yielded = false

  public constructor(tag: Tag) {
    this.tag = tag
  }

  public next(value: Service): IteratorResult<ResultTaskServiceYield<Tag>, Service> {
    if (!this.yielded) {
      this.yielded = true
      return { done: false, value: this }
    }
    return { done: true, value }
  }

  public return(value: Service): IteratorResult<ResultTaskServiceYield<Tag>, Service> {
    this.yielded = true
    return { done: true, value }
  }

  public throw(error: unknown): IteratorResult<ResultTaskServiceYield<Tag>, Service> {
    this.yielded = true
    return throwDefect(error)
  }

  public [Symbol.iterator](): Generator<ResultTaskServiceYield<Tag>, Service, Service> {
    return this as unknown as Generator<ResultTaskServiceYield<Tag>, Service, Service>
  }
}

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

  public [Symbol.iterator](): Generator<
    ResultTaskServiceYield<ServiceTag<Identifier, Service>>,
    Service,
    Service
  > {
    return new ServiceTagIterator<ServiceTag<Identifier, Service>, Service>(
      this,
    ) as unknown as Generator<
      ResultTaskServiceYield<ServiceTag<Identifier, Service>>,
      Service,
      Service
    >
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

class ResultTaskIterator<A, E, R> implements ResultTaskYield<A, E, R> {
  public readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId = ResultTaskYieldTypeId
  public readonly _tag = 'ResultTask' as const
  public readonly task: ResultTask<A, E, R>
  private yielded = false

  public constructor(task: ResultTask<A, E, R>) {
    this.task = task
  }

  public next(exit: Exit<A, E>): IteratorResult<ResultTaskYield<A, E, R>, A> {
    if (!this.yielded) {
      this.yielded = true
      return { done: false, value: this }
    }
    if (exit._tag === 'Success') {
      return { done: true, value: exit.value }
    }
    return throwDefect(new Error('ResultTask generator received a failed task result'))
  }

  public return(value: A): IteratorResult<ResultTaskYield<A, E, R>, A> {
    this.yielded = true
    return { done: true, value }
  }

  public throw(error: unknown): IteratorResult<ResultTaskYield<A, E, R>, A> {
    this.yielded = true
    return throwDefect(error)
  }

  public [Symbol.iterator](): Generator<ResultTaskYield<A, E, R>, A, Exit<A, E>> {
    return this as unknown as Generator<ResultTaskYield<A, E, R>, A, Exit<A, E>>
  }
}

/* eslint-disable typescript/switch-exhaustiveness-check */
const isPromiseExit = (
  value: Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>,
): value is Promise<Exit<unknown, unknown>> =>
  typeof (value as Promise<Exit<unknown, unknown>>).then === 'function'

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
export type ResultAsyncFinalizer<T, E> = (
  value: T | undefined,
  error: E | undefined,
) => void | Promise<void>

/**
 * Wrapper around a Result-producing Promise that also implements AsyncDisposable (`await using`).
 */
export class DisposableResultAsync<T, E> implements PromiseLike<Result<T, E>>, AsyncDisposable {
  readonly #promise: Promise<Result<T, E>>
  readonly #finalizer: ResultAsyncFinalizer<T, E>
  #disposed = false

  public constructor(promise: Promise<Result<T, E>>, finalizer: ResultAsyncFinalizer<T, E>) {
    this.#promise = promise
    this.#finalizer = finalizer
  }

  // eslint-disable-next-line unicorn/no-thenable -- Intentional PromiseLike implementation for `await using`.
  public then<TResult1 = Result<T, E>, TResult2 = never>(
    onfulfilled?: ((value: Result<T, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected)
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) {
      return
    }

    this.#disposed = true
    const result = await this.#promise

    try {
      await this.#finalizer(
        result.isOk() ? result.value : undefined,
        result.isErr() ? result.error : undefined,
      )
    } catch {
      /* empty */
    }
  }
}

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
  readonly #promise?: PromiseLike<Result<A, E>>

  public constructor(res: Promise<Result<A, E>>)
  /* eslint-disable typescript/unified-signatures */
  /** @internal */
  public constructor(
    instructionOrExecute: TaskInstruction | ResultTaskExecutor | PromiseLike<Result<A, E>>,
  )
  /* eslint-enable typescript/unified-signatures */
  public constructor(
    instructionOrExecute: TaskInstruction | ResultTaskExecutor | PromiseLike<Result<A, E>>,
  ) {
    super()
    if (typeof instructionOrExecute === 'function') {
      this.instruction = { _tag: 'Async', execute: instructionOrExecute }
    } else if ('_tag' in instructionOrExecute) {
      this.instruction = instructionOrExecute
    } else {
      this.#promise = instructionOrExecute
      this.instruction = {
        // Stryker disable next-line StringLiteral: Async is the default instruction branch in runTaskLoop.
        _tag: 'Async',
        execute: async (context) => {
          try {
            const result = await instructionOrExecute
            if (context.signal.aborted) {
              return interrupted(context.signal)
            }
            return result.isOk() ? success(result.value) : failed(result.error)
          } catch (error) {
            return died(error)
          }
        },
      }
    }
  }

  // Visible to internal task operators and tests that inspect `task.execute`.
  private get execute(): ResultTaskExecutor {
    return (context) => ResultTask.runTaskLoop(this, context)
  }

  private set execute(value: ResultTaskExecutor) {
    Object.defineProperty(this, 'execute', { value, writable: true, configurable: true })
  }

  private run(
    context: ResultTaskRuntimeContext,
  ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    return Object.hasOwn(this, 'execute')
      ? this.execute(context)
      : ResultTask.runTaskLoop(this, context)
  }

  static #applySuccessContinuation(
    continuation: TaskContinuation,
    exit: Exit<unknown, unknown> & { readonly _tag: 'Success' },
  ): ContinuationStep {
    switch (continuation._tag) {
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
    const finalize = (observed: Exit<unknown, unknown>): Exit<unknown, unknown> => {
      if (observed._tag === 'Failure') {
        if (cleanupMarked) {
          markCleanupCause(observed.cause)
        }
        return observed
      }
      return passThroughExit
    }
    const retain = (
      task: ResultTask<unknown, unknown, unknown>,
    ): ResultTask<unknown, unknown, unknown> =>
      new ResultTask((context) => {
        const observed = task.run(context)
        return isPromiseExit(observed) ? observed.then(finalize) : finalize(observed)
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

  /* eslint-disable complexity, max-statements, max-depth, max-params, init-declarations */
  // fallow-ignore-next-line complexity
  private static runTaskLoop(
    rootTask: ResultTask<unknown, unknown, unknown>,
    context: ResultTaskRuntimeContext,
  ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: NEVER_ABORTED_SIGNAL.aborted is always false; trackSignal is a fast-path check.
    const trackSignal = context.signal !== NEVER_ABORTED_SIGNAL
    /* Stryker disable all: root instruction fast-path is behaviorally equivalent to the general continuation loop below. */
    if ((!trackSignal || !context.signal.aborted) && context.scheduling.remaining > 1) {
      const rootInstruction = rootTask.instruction
      if (rootInstruction._tag === 'Succeed') {
        context.scheduling.remaining -= 1
        return success(rootInstruction.value)
      }
      if (rootInstruction._tag === 'Fail') {
        context.scheduling.remaining -= 1
        return failed(rootInstruction.error)
      }
      if (rootInstruction._tag === 'Sync') {
        context.scheduling.remaining -= 1
        try {
          return rootInstruction.evaluate()
        } catch (error) {
          return died(error)
        }
      }
      if (rootInstruction._tag === 'Async') {
        context.scheduling.remaining -= 1
        try {
          const executed = rootInstruction.execute(context)
          return isPromiseExit(executed) ? executed.catch(died) : executed
        } catch (error) {
          return died(error)
        }
      }
    }
    /* Stryker restore all */

    const continuations: TaskContinuation[] = []
    let current: ResultTask<unknown, unknown, unknown> | undefined = rootTask
    let currentExit: Exit<unknown, unknown> | undefined = undefined

    /* eslint-disable typescript/switch-exhaustiveness-check */
    // Stryker disable next-line ConditionalExpression: runTaskLoop terminates when both current and continuations are exhausted.
    while (current !== undefined || continuations.length > 0) {
      try {
        const yielding = schedulerCheckpoint(context.scheduling, context.signal)
        // Stryker disable next-line ConditionalExpression: awaiting undefined when no scheduler yield is needed produces the same Exit outcome.
        if (yielding !== undefined) {
          return ResultTask.#runTaskLoopFromYield(
            yielding,
            current,
            currentExit,
            continuations,
            context,
          )
        }
      } catch (error) {
        if (!context.signal.aborted) {
          recoverScheduling(context.scheduling)
          const defect = died(error)
          if (context.cleanup === undefined) {
            return combineExits(currentExit ?? success(undefined), defect, 'Sequential')
          }
          context.cleanup.schedulerFailure = defect
        }
      }

      if (current === undefined) {
        const nextContinuation = continuations.pop() as unknown as TaskContinuation
        const activeExit = currentExit as unknown as Exit<unknown, unknown>

        const resolvedExit: Exit<unknown, unknown> =
          trackSignal && activeExit._tag === 'Success' && context.signal.aborted
            ? interrupted(context.signal)
            : activeExit

        if (resolvedExit._tag === 'Success') {
          if (nextContinuation._tag === 'FlatMap') {
            try {
              const next = nextContinuation.f(resolvedExit.value)
              if (isResultTask(next)) {
                current = next
                currentExit = undefined
              } else {
                current = undefined
                currentExit = next.isOk() ? success(next.value) : failed(next.error)
              }
            } catch (error) {
              current = undefined
              currentExit = died(error)
            }
          } else if (nextContinuation._tag === 'Map') {
            current = undefined
            try {
              currentExit = success(nextContinuation.f(resolvedExit.value))
            } catch (error) {
              currentExit = died(error)
            }
          } else {
            const step = ResultTask.#applySuccessContinuation(nextContinuation, resolvedExit)
            current = step.current
            currentExit = step.currentExit
          }
        } else {
          const step = ResultTask.#applyFailureContinuation(nextContinuation, resolvedExit)
          current = step.current
          currentExit = step.currentExit
        }
      } else {
        if (trackSignal && context.signal.aborted) {
          return interrupted(context.signal)
        }

        const instruction = current.instruction
        switch (instruction._tag) {
          case 'FlatMap':
          case 'Map':
          case 'MapError':
          case 'Tap':
          case 'TapError':
          case 'TapBoth':
          case 'CatchAll': {
            continuations.push(instruction)
            current = instruction.task
            break
          }
          case 'Succeed': {
            current = undefined
            currentExit = success(instruction.value)
            break
          }
          case 'Fail': {
            current = undefined
            currentExit = failed(instruction.error)
            break
          }
          case 'Sync': {
            current = undefined
            try {
              currentExit = instruction.evaluate()
            } catch (error) {
              currentExit = died(error)
            }
            break
          }
          default: {
            current = undefined
            try {
              const executed = instruction.execute(context)
              if (isPromiseExit(executed)) {
                /* Stryker disable all: zero-continuation fast-path is equivalent to #runTaskLoopFromAsync. */
                if (continuations.length === 0) {
                  return executed.catch(died)
                }
                /* Stryker restore all */
                return ResultTask.#runTaskLoopFromAsync(executed, continuations, context)
              }
              currentExit = executed
            } catch (error) {
              currentExit = died(error)
            }
            break
          }
        }
      }
    }
    /* eslint-enable typescript/switch-exhaustiveness-check */

    return currentExit as unknown as Exit<unknown, unknown>
  }

  static async #runTaskLoopFromYield(
    yielding: Promise<void>,
    current: ResultTask<unknown, unknown, unknown> | undefined,
    currentExit: Exit<unknown, unknown> | undefined,
    continuations: TaskContinuation[],
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<unknown, unknown>> {
    try {
      await yielding
    } catch (error) {
      if (!context.signal.aborted) {
        recoverScheduling(context.scheduling)
        const defect = died(error)
        if (context.cleanup === undefined) {
          return combineExits(currentExit ?? success(undefined), defect, 'Sequential')
        }
        context.cleanup.schedulerFailure = defect
      }
    }
    return ResultTask.#resumeTaskLoopAsync(current, currentExit, continuations, context)
  }

  static async #runTaskLoopFromAsync(
    pendingExit: Promise<Exit<unknown, unknown>>,
    continuations: TaskContinuation[],
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<unknown, unknown>> {
    let currentExit: Exit<unknown, unknown>
    try {
      currentExit = await pendingExit
    } catch (error) {
      currentExit = died(error)
    }
    return ResultTask.#resumeTaskLoopAsync(undefined, currentExit, continuations, context)
  }

  // fallow-ignore-next-line complexity
  static async #resumeTaskLoopAsync(
    initialCurrent: ResultTask<unknown, unknown, unknown> | undefined,
    initialExit: Exit<unknown, unknown> | undefined,
    continuations: TaskContinuation[],
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<unknown, unknown>> {
    let current = initialCurrent
    let currentExit = initialExit
    // Stryker disable next-line ConditionalExpression,EqualityOperator: NEVER_ABORTED_SIGNAL.aborted is always false; trackSignal is a fast-path check.
    const trackSignal = context.signal !== NEVER_ABORTED_SIGNAL

    /* eslint-disable typescript/switch-exhaustiveness-check */
    while (current !== undefined || continuations.length > 0) {
      if (current === undefined) {
        const nextContinuation = continuations.pop() as unknown as TaskContinuation
        const activeExit = currentExit as unknown as Exit<unknown, unknown>

        const resolvedExit: Exit<unknown, unknown> =
          trackSignal && activeExit._tag === 'Success' && context.signal.aborted
            ? interrupted(context.signal)
            : activeExit

        if (resolvedExit._tag === 'Success') {
          if (nextContinuation._tag === 'FlatMap') {
            try {
              const next = nextContinuation.f(resolvedExit.value)
              if (isResultTask(next)) {
                current = next
                currentExit = undefined
              } else {
                current = undefined
                currentExit = next.isOk() ? success(next.value) : failed(next.error)
              }
            } catch (error) {
              current = undefined
              currentExit = died(error)
            }
          } else if (nextContinuation._tag === 'Map') {
            current = undefined
            try {
              currentExit = success(nextContinuation.f(resolvedExit.value))
            } catch (error) {
              currentExit = died(error)
            }
          } else {
            const step = ResultTask.#applySuccessContinuation(nextContinuation, resolvedExit)
            current = step.current
            currentExit = step.currentExit
          }
        } else {
          const step = ResultTask.#applyFailureContinuation(nextContinuation, resolvedExit)
          current = step.current
          currentExit = step.currentExit
        }
      } else {
        if (trackSignal && context.signal.aborted) {
          return interrupted(context.signal)
        }

        const instruction = current.instruction
        switch (instruction._tag) {
          case 'FlatMap':
          case 'Map':
          case 'MapError':
          case 'Tap':
          case 'TapError':
          case 'TapBoth':
          case 'CatchAll': {
            continuations.push(instruction)
            current = instruction.task
            break
          }
          case 'Succeed': {
            current = undefined
            currentExit = success(instruction.value)
            break
          }
          case 'Fail': {
            current = undefined
            currentExit = failed(instruction.error)
            break
          }
          case 'Sync': {
            current = undefined
            try {
              currentExit = instruction.evaluate()
            } catch (error) {
              currentExit = died(error)
            }
            break
          }
          default: {
            current = undefined
            try {
              const executed = instruction.execute(context)
              // eslint-disable-next-line no-await-in-loop
              currentExit = isPromiseExit(executed) ? await executed : executed
            } catch (error) {
              currentExit = died(error)
            }
            break
          }
        }
      }

      if (current !== undefined || continuations.length > 0) {
        try {
          const yielding = schedulerCheckpoint(context.scheduling, context.signal)
          // Stryker disable next-line ConditionalExpression: awaiting undefined when no scheduler yield is needed is a no-op.
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
        }
      }
    }
    /* eslint-enable typescript/switch-exhaustiveness-check */

    return currentExit as unknown as Exit<unknown, unknown>
  }
  /* eslint-enable complexity, max-statements, max-depth, max-params, init-declarations */

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
    if (interruption === 'detach') {
      return new ResultTask<A, unknown>((context) =>
        detachedPromise(
          context.signal,
          () => normalized.try(toNativeAbortSignal(context.signal)),
          (error) => normalized.catch(error),
        ),
      )
    }
    return new ResultTask<A, unknown>((context) => {
      try {
        return Promise.resolve(normalized.try(toNativeAbortSignal(context.signal))).then(
          success,
          (error: unknown): Exit<A, unknown> => {
            if (context.signal.aborted) {
              return interrupted(context.signal)
            }
            try {
              return failed<A, unknown>(normalized.catch(error))
            } catch (catchError) {
              return died(catchError)
            }
          },
        )
      } catch (error) {
        if (context.signal.aborted) {
          return interrupted(context.signal)
        }
        try {
          return failed<A, unknown>(normalized.catch(error))
        } catch (catchError) {
          return died(catchError)
        }
      }
    })
  }

  static #registerAcquireReleaseFinalizer<A, E, R, ReleaseError, ReleaseR>(
    acquired: Exit<unknown, unknown>,
    options: ResultTaskAcquireReleaseOptions<A, E, R, ReleaseError, ReleaseR>,
    context: ResultTaskRuntimeContext,
  ): Exit<unknown, unknown> {
    if (acquired._tag === 'Failure') return acquired

    // Register before checking interruption again: acquisition may have completed during abort.
    context.scope.add((exit) => {
      // eslint-disable-next-line init-declarations
      let releaseTask: ResultTask<unknown, ReleaseError, ReleaseR>
      try {
        releaseTask = options.release(acquired.value as A, exit)
      } catch (error) {
        return died(error)
      }
      /* Stryker disable all: synchronous release fast-path is behaviorally equivalent to running releaseTask in cleanupContext below. */
      if (context.scheduling.remaining > 1 && !Object.hasOwn(releaseTask, 'execute')) {
        const instruction = releaseTask.instruction
        if (instruction._tag === 'Sync') {
          context.scheduling.remaining -= 1
          try {
            return instruction.evaluate()
          } catch (error) {
            return died(error)
          }
        }
        if (instruction._tag === 'Succeed') {
          context.scheduling.remaining -= 1
          return success(instruction.value)
        }
        if (instruction._tag === 'Fail') {
          context.scheduling.remaining -= 1
          return failed(instruction.error)
        }
      }
      /* Stryker restore all */
      const scope = new TaskScope()
      const cleanupContext = withCleanupScope(context, scope)
      const finishRelease = (
        released: Exit<unknown, unknown>,
      ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> => {
        const closed = scope.closeSyncOrAsync(released)
        return isPromiseExit(closed)
          ? closed.then((closedExit) => completeCleanup(closedExit, cleanupContext))
          : completeCleanup(closed, cleanupContext)
      }
      try {
        const released = releaseTask.run(cleanupContext)
        return isPromiseExit(released)
          ? released.then(
              (resolved) => finishRelease(resolved),
              (error: unknown) => finishRelease(died(error)),
            )
          : finishRelease(released)
      } catch (error) {
        return finishRelease(died(error))
      }
    })
    return acquired
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
    return new ResultTask((context) => {
      const acquired = options.acquire.run(context)
      return isPromiseExit(acquired)
        ? acquired.then((resolved) =>
            ResultTask.#registerAcquireReleaseFinalizer(resolved, options, context),
          )
        : ResultTask.#registerAcquireReleaseFinalizer(acquired, options, context)
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
    return new ResultTask((context) => {
      const scope = new TaskScope()
      const exit = task.run(withScope(context, scope))
      if (isPromiseExit(exit)) {
        return exit.then((resolvedExit) => {
          const closed = scope.closeSyncOrAsync(interruptSuccess(resolvedExit, context.signal))
          return isPromiseExit(closed)
            ? closed.then((closedExit) => interruptSuccess(closedExit, context.signal))
            : interruptSuccess(closed, context.signal)
        })
      }
      const closed = scope.closeSyncOrAsync(interruptSuccess(exit, context.signal))
      return isPromiseExit(closed)
        ? closed.then((closedExit) => interruptSuccess(closedExit, context.signal))
        : interruptSuccess(closed, context.signal)
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
  /* eslint-disable max-statements, max-depth, init-declarations */
  static #closeGenerator<Yield, Return, Next, E>(
    iterator: Generator<Yield, Return, Next>,
    exit: Exit<Return, E>,
    context: ResultTaskRuntimeContext,
  ): Exit<Return, E> | Promise<Exit<Return, E>> {
    try {
      const step = iterator.return(undefined as Return)
      // Stryker disable next-line ConditionalExpression: closeGeneratorAsync immediately exits its loop when step.done is true.
      if (step.done === true) return exit
      const cleanupContext = withCleanupScope(context, context.scope)
      return closeGeneratorAsync(
        iterator,
        { initialStep: step, exit },
        { context: cleanupContext, executeTask: (task) => task.execute(cleanupContext) },
      )
    } catch (error) {
      return died<Return, E>(error)
    }
  }

  public static gen<Yield extends ResultTaskYieldable = never, Return = unknown, Next = unknown>(
    body: () => Generator<Yield, Return, Next>,
  ): ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>> {
    return new ResultTask<Return, GeneratorError<Yield>, GeneratorRequirements<Yield>>(
      // fallow-ignore-next-line complexity
      (context) => {
        try {
          const iterator = body()
          let step = iterator.next()

          while (step.done === false) {
            if (isResultTaskYield(step.value)) {
              let executed: Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
              try {
                executed = step.value.task.run(context)
              } catch (error) {
                return ResultTask.#closeGenerator(
                  iterator,
                  died<Return, GeneratorError<Yield>>(error),
                  context,
                )
              }

              // Stryker disable next-line ConditionalExpression: awaiting a synchronous Exit in #resumeGenFromTaskAsync produces the same outcome.
              if (isPromiseExit(executed)) {
                return ResultTask.#resumeGenFromTaskAsync(iterator, executed, context)
              }

              const outcome = interruptSuccess(executed, context.signal)
              if (outcome._tag === 'Failure') {
                return ResultTask.#closeGenerator(
                  iterator,
                  outcome as Exit<Return, GeneratorError<Yield>>,
                  context,
                )
              }

              step = iterator.next(outcome as Next)
            } else if (isServiceYield(step.value)) {
              const supplied = lookupService(step.value.tag, context)
              if (supplied._tag === 'Found') {
                step = iterator.next(supplied.value as Next)
              } else {
                /* Stryker disable all: synchronous MissingServiceError fast-path is equivalent to #resumeGenFromServiceAsync. */
                if (context.serviceResolver === undefined) {
                  return ResultTask.#closeGenerator(
                    iterator,
                    died<Return, GeneratorError<Yield>>(
                      new MissingServiceError(step.value.tag.identifier),
                    ),
                    context,
                  )
                }
                /* Stryker restore all */
                return ResultTask.#resumeGenFromServiceAsync(iterator, step.value.tag, context)
              }
            } else if (isErrResult(step.value)) {
              return ResultTask.#closeGenerator(
                iterator,
                failed<Return, GeneratorError<Yield>>(step.value.error as GeneratorError<Yield>),
                context,
              )
            } else {
              return ResultTask.#closeGenerator(
                iterator,
                died<Return, GeneratorError<Yield>>(
                  new TypeError('ResultTask.gen yielded an unsupported value'),
                ),
                context,
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

  static async #resumeGenFromTaskAsync<Yield extends ResultTaskYieldable, Return, Next>(
    iterator: Generator<Yield, Return, Next>,
    pendingExit: Promise<Exit<unknown, unknown>>,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<Return, GeneratorError<Yield>>> {
    let outcome: Exit<unknown, unknown>
    try {
      outcome = interruptSuccess(await pendingExit, context.signal)
    } catch (error) {
      return ResultTask.#closeGenerator(
        iterator,
        died<Return, GeneratorError<Yield>>(error),
        context,
      )
    }
    if (outcome._tag === 'Failure') {
      return ResultTask.#closeGenerator(
        iterator,
        outcome as Exit<Return, GeneratorError<Yield>>,
        context,
      )
    }
    let nextStep: IteratorResult<Yield, Return>
    try {
      nextStep = iterator.next(outcome as Next)
    } catch (error) {
      return died<Return, GeneratorError<Yield>>(error)
    }
    return ResultTask.#resumeGenLoopAsync(iterator, nextStep, context)
  }

  static async #resumeGenFromServiceAsync<Yield extends ResultTaskYieldable, Return, Next>(
    iterator: Generator<Yield, Return, Next>,
    tag: AnyServiceTag,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<Return, GeneratorError<Yield>>> {
    const executeTask: ResultTaskNestedExecutor = async (task) =>
      interruptSuccess(await task.run(context), context.signal)
    const resolution = await resolveService(tag, context, executeTask)
    if (resolution._tag === 'Failure') {
      return ResultTask.#closeGenerator(
        iterator,
        resolution.exit as Exit<Return, GeneratorError<Yield>>,
        context,
      )
    }
    if (resolution._tag !== 'Found') {
      return ResultTask.#closeGenerator(
        iterator,
        died<Return, GeneratorError<Yield>>(
          resolution._tag === 'Error' ? resolution.error : new MissingServiceError(tag.identifier),
        ),
        context,
      )
    }
    let nextStep: IteratorResult<Yield, Return>
    try {
      nextStep = iterator.next(resolution.value as Next)
    } catch (error) {
      return died<Return, GeneratorError<Yield>>(error)
    }
    return ResultTask.#resumeGenLoopAsync(iterator, nextStep, context)
  }

  // fallow-ignore-next-line complexity
  static async #resumeGenLoopAsync<Yield extends ResultTaskYieldable, Return, Next>(
    iterator: Generator<Yield, Return, Next>,
    initialStep: IteratorResult<Yield, Return>,
    context: ResultTaskRuntimeContext,
  ): Promise<Exit<Return, GeneratorError<Yield>>> {
    try {
      let executeTask: ResultTaskNestedExecutor | undefined = undefined
      let step = initialStep

      while (step.done === false) {
        if (isResultTaskYield(step.value)) {
          let executed: Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
          try {
            executed = step.value.task.run(context)
            // Stryker disable next-line ConditionalExpression: awaiting a synchronous Exit in #resumeGenLoopAsync produces the same outcome.
            if (isPromiseExit(executed)) {
              // eslint-disable-next-line no-await-in-loop
              executed = await executed
            }
          } catch (error) {
            // eslint-disable-next-line no-await-in-loop
            return await ResultTask.#closeGenerator(
              iterator,
              died<Return, GeneratorError<Yield>>(error),
              context,
            )
          }

          const outcome = interruptSuccess(executed, context.signal)
          if (outcome._tag === 'Failure') {
            // eslint-disable-next-line no-await-in-loop
            return await ResultTask.#closeGenerator(
              iterator,
              outcome as Exit<Return, GeneratorError<Yield>>,
              context,
            )
          }

          step = iterator.next(outcome as Next)
        } else if (isServiceYield(step.value)) {
          const supplied = lookupService(step.value.tag, context)
          // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: resolveService repeats lookupService synchronously before resolving.
          if (supplied._tag === 'Found') {
            step = iterator.next(supplied.value as Next)
          } else {
            executeTask ??= async (task) =>
              interruptSuccess(await task.run(context), context.signal)
            // eslint-disable-next-line no-await-in-loop
            const resolution = await resolveService(step.value.tag, context, executeTask)

            if (resolution._tag === 'Found') {
              step = iterator.next(resolution.value as Next)
            } else if (resolution._tag === 'Failure') {
              // eslint-disable-next-line no-await-in-loop
              return await ResultTask.#closeGenerator(
                iterator,
                resolution.exit as Exit<Return, GeneratorError<Yield>>,
                context,
              )
            } else {
              // eslint-disable-next-line no-await-in-loop
              return await ResultTask.#closeGenerator(
                iterator,
                died<Return, GeneratorError<Yield>>(
                  resolution._tag === 'Error'
                    ? resolution.error
                    : new MissingServiceError(step.value.tag.identifier),
                ),
                context,
              )
            }
          }
        } else if (isErrResult(step.value)) {
          // eslint-disable-next-line no-await-in-loop
          return await ResultTask.#closeGenerator(
            iterator,
            failed<Return, GeneratorError<Yield>>(step.value.error as GeneratorError<Yield>),
            context,
          )
        } else {
          // eslint-disable-next-line no-await-in-loop
          return await ResultTask.#closeGenerator(
            iterator,
            died<Return, GeneratorError<Yield>>(
              new TypeError('ResultTask.gen yielded an unsupported value'),
            ),
            context,
          )
        }
      }

      return success<Return, GeneratorError<Yield>>(step.value as Return)
    } catch (error) {
      return died<Return, GeneratorError<Yield>>(error)
    }
  }
  /* eslint-enable max-statements, max-depth, init-declarations */

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
          const observed = f(exit.value as A)
          /* Stryker disable all: awaiting a ResultTask would execute it via its PromiseLike .then(), while skipping await on a rejected Promise triggers an unhandled rejection in Vitest. */
          if (!isResultTask(observed)) {
            await observed
          }
          /* Stryker restore all */
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
          const observed = f(exit.cause.error as E)
          /* Stryker disable all: awaiting a ResultTask would execute it via its PromiseLike .then(), while skipping await on a rejected Promise triggers an unhandled rejection in Vitest. */
          if (!isResultTask(observed)) {
            await observed
          }
          /* Stryker restore all */
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
          const observed = f(exit.cause as Cause<E>)
          /* Stryker disable all: awaiting a ResultTask would execute it via its PromiseLike .then(), while skipping await on a rejected Promise triggers an unhandled rejection in Vitest. */
          if (!isResultTask(observed)) {
            await observed
          }
          /* Stryker restore all */
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
   * const retried = ResultTask.fail('transient' as const).retry(Retry.policy({ times: 2, delayMs: 10 }))
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
  public match<B, C = B>(handlers: ResultTaskMatchOptions<A, E, B, C>): ResultTask<B | C, never, R>
  public match<B, C = B>(onOk: (value: A) => B, onErr: (error: E) => C): ResultTask<B | C, never, R>
  public match<B, C = B>(
    input: ResultTaskMatchOptions<A, E, B, C> | ((value: A) => B),
    onErr?: (error: E) => C,
  ): ResultTask<B | C, never, R> {
    if (typeof input === 'function') {
      if (typeof onErr !== 'function') {
        throw new TypeError('ResultTask.match requires both onOk and onErr callbacks')
      }
      return this.map(input).orElse((error) => ResultTask.ok(onErr(error)))
    }
    const onSuccess = taskSuccessHandler(input)
    const onFailure = taskFailureHandler(input)
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
  public [Symbol.iterator](): Generator<ResultTaskYield<A, E, R>, A, Exit<A, E>> {
    return new ResultTaskIterator(this) as unknown as Generator<
      ResultTaskYield<A, E, R>,
      A,
      Exit<A, E>
    >
  }

  /**
   * Enables `await task` when all requirements (`R`) have been satisfied (`R = never`).
   * Executes the task using `ResultTask.runResult(this)`.
   */
  // eslint-disable-next-line unicorn/no-thenable -- Intentional PromiseLike implementation when R = never.
  public then<TResult1 = Result<A, E>, TResult2 = never>(
    this: ResultTask<A, E, never>,
    onfulfilled?: ((value: Result<A, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.#promise !== undefined) {
      return Promise.resolve(this.#promise).then(onfulfilled, onrejected)
    }
    return ResultTask.runResult(this).then(onfulfilled, onrejected)
  }

  /**
   * Enables `yield* task` inside `safeAsyncGen` when `R = never`.
   */
  public async *[Symbol.asyncIterator](
    this: ResultTask<A, E, never>,
  ): AsyncGenerator<Result<never, E>, A> {
    const result = await ResultTask.runResult(this)
    if (result.isOk()) {
      return result.value
    }
    yield err(result.error)
    return undefined as A
  }

  /**
   * Runs this task and resolves to its `Ok` value or rejects if the result is `Err`.
   */
  public unwrapOrThrow(this: ResultTask<A, E, never>): Promise<A> {
    return ResultTask.runPromise(this)
  }

  /**
   * Wraps this task with an `AsyncDisposable` finalizer for `await using`.
   */
  public toAsyncDisposable(
    this: ResultTask<A, E, never>,
    finalizer: ResultAsyncFinalizer<A, E>,
  ): DisposableResultAsync<A, E> {
    return new DisposableResultAsync(ResultTask.runResult(this), finalizer)
  }

  /**
   * Runs a non-failing side-effect callback on either the success value or error.
   */
  public log(f: (value?: A, error?: E) => void | Promise<void>): ResultTask<A, E, R> {
    return this.inspectBoth(
      (value) => f(value, undefined),
      (error) => f(undefined, error),
    )
  }

  /**
   * Conditional branching based on a predicate over the success value.
   */
  public if(fCondition: (value: A) => boolean): {
    true: <X1, Y1, R1 = never>(
      fTrue: (value: A) => Result<X1, Y1> | ResultTask<X1, Y1, R1>,
    ) => {
      false: <X2, Y2, R2 = never>(
        fFalse: (value: A) => Result<X2, Y2> | ResultTask<X2, Y2, R2>,
      ) => ResultTask<X1 | X2, E | Y1 | Y2, R | R1 | R2>
    }
  } {
    return {
      true: <X1, Y1, R1 = never>(fTrue: (value: A) => Result<X1, Y1> | ResultTask<X1, Y1, R1>) => ({
        false: <X2, Y2, R2 = never>(
          fFalse: (value: A) => Result<X2, Y2> | ResultTask<X2, Y2, R2>,
        ): ResultTask<X1 | X2, E | Y1 | Y2, R | R1 | R2> =>
          this.andThen(
            (value) =>
              (fCondition(value) ? fTrue(value) : fFalse(value)) as
                | Result<X1 | X2, Y1 | Y2>
                | ResultTask<X1 | X2, Y1 | Y2, R1 | R2>,
          ),
      }),
    }
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
      return new ResultTask((context) => {
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
      return new ResultTask((context) => {
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
        execute: (
          context: FiberTaskContext,
        ) => Exit<Value, ErrorValue> | Promise<Exit<Value, ErrorValue>>,
      ) => new ResultTask<Value, ErrorValue>(execute),
      (fiber, context) => {
        // eslint-disable-next-line unicorn/require-array-join-separator -- Fiber.join is not Array.join.
        const exit = fiber.join().run(context as ResultTaskRuntimeContext)
        return isPromiseExit(exit) ? exit : Promise.resolve(exit)
      },
    )
    registerSemaphoreTaskFactory(
      <Value, ErrorValue, Requirements>(
        acquire: SemaphoreAcquire,
        task: ResultTask<Value, ErrorValue, Requirements>,
        caller: string,
      ) => {
        if (!isResultTask(task)) {
          throw new TypeError(`${caller} requires a task`)
        }
        const runWithRelease = (
          release: () => void,
          context: ResultTaskRuntimeContext,
        ): Exit<unknown, unknown> | Promise<Exit<unknown, unknown>> => {
          // eslint-disable-next-line init-declarations
          let executed: Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
          try {
            executed = task.run(context)
          } catch (error) {
            release()
            throw error
          }
          if (isPromiseExit(executed)) {
            return executed.then(
              (exit) => {
                release()
                return interruptSuccess(exit, context.signal)
              },
              (error: unknown) => {
                release()
                return died(error)
              },
            )
          }
          release()
          return interruptSuccess(executed, context.signal)
        }
        return new ResultTask<Value, ErrorValue, Requirements>((context) => {
          const acquired = acquire(context.signal)
          if (acquired === undefined) {
            return interrupted(context.signal)
          }
          if (typeof acquired === 'function') {
            return runWithRelease(acquired, context)
          }
          return acquired.then((release) => {
            if (release === undefined) {
              return interrupted(context.signal)
            }
            return runWithRelease(release, context)
          })
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
    withHandle = true,
  ): RuntimeFiber {
    const scope = new TaskScope()
    const fiberSignal = new FiberSignal(context.signal)
    const childContext = withChildScope(context, scope, fiberSignal.asAbortSignal())
    const completeFn =
      // Stryker disable next-line ConditionalExpression: completeCleanup is a no-op when cleanup is undefined or schedulerFailure is Success.
      childContext.cleanup === undefined
        ? undefined
        : (exit: Exit<unknown, unknown>) => completeCleanup(exit, childContext)
    return startDirectFiber(
      context.scope,
      scope,
      fiberSignal,
      () => task.run(childContext),
      completeFn,
      withHandle,
    )
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
    return new ResultTask((context) => success(ResultTask.#startFiber(task, context).handle))
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
        await context.clock.sleep(
          milliseconds,
          // Stryker disable next-line ConditionalExpression,EqualityOperator: Clock.live accepts TaskAbortSignal directly; toNativeAbortSignal is a fast-path skip for Clock.live.
          context.clock === Clock.live ? context.signal : toNativeAbortSignal(context.signal),
        )
        return SUCCESS_UNDEFINED
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
    return new ResultTask((context) => success(context.clock.now()))
  }

  static async #race(
    tasks: readonly [ResultTask<unknown, unknown, unknown>, ResultTask<unknown, unknown, unknown>],
    context: ResultTaskRuntimeContext,
    firstSuccess: boolean,
  ): Promise<Exit<unknown, unknown>> {
    // Stryker disable next-line BooleanLiteral: skipping handle allocation is an internal optimization for race fibers.
    const children = tasks.map((task) => ResultTask.#startFiber(task, context, false))
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
   * const policy = Retry.policy({ times: 2, delayMs: ({ attempt }) => (attempt + 1) * 10 })
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
        const exit = await scope.close(await task.run(withScope(context, scope)))
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
        const waiting = await ResultTask.sleep(delay).run(context)
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
    const outcomes: Exit<unknown, unknown>[] = []
    const fiberSignal = new FiberSignal(context.signal)
    const signal = fiberSignal.asAbortSignal()
    // Stryker disable next-line ConditionalExpression,EqualityOperator: NEVER_ABORTED_SIGNAL.aborted is always false; trackSignal is a fast-path check.
    const trackSignal = context.signal !== NEVER_ABORTED_SIGNAL
    const workerCount = Math.min(concurrency, input.length)
    let next = 0
    let stopping = false
    const stop = (): void => {
      // Stryker disable next-line ConditionalExpression: fiberSignal.abort is idempotent when stop() is called multiple times.
      if (stopping) return
      stopping = true
      fiberSignal.abort('ResultTask collection stopped')
    }
    const worker = async (): Promise<void> => {
      while (next < input.length) {
        // Stryker disable next-line ConditionalExpression,LogicalOperator: child signal is already aborted when stopping or parent signal is aborted; early return avoids spawning extra work.
        if (stopping || (trackSignal && context.signal.aborted)) return
        const index = next
        next += 1
        // eslint-disable-next-line init-declarations
        let mapped: ResultTask<unknown, unknown, unknown>
        try {
          mapped = mapper(input[index], index)
        } catch (error) {
          outcomes[index] = died(error)
          stop()
          return
        }
        const scope = new TaskScope()
        const childContext = withChildScope(context, scope, signal)
        // eslint-disable-next-line init-declarations
        let exit: Exit<unknown, unknown>
        try {
          const exitOrPromise = mapped.run(childContext)
          // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: awaiting a synchronous Exit in an async worker produces the same outcome.
          const shouldAwait = workerCount > 1 || isPromiseExit(exitOrPromise)
          // eslint-disable-next-line no-await-in-loop
          const rawExit = shouldAwait ? await exitOrPromise : exitOrPromise
          const closed = scope.closeSyncOrAsync(interruptSuccess(rawExit, signal))
          // eslint-disable-next-line no-await-in-loop
          const finalized = isPromiseExit(closed) ? await closed : closed
          exit = completeCleanup(finalized, childContext)
        } catch (error) {
          const closed = scope.closeSyncOrAsync(died(error))
          // eslint-disable-next-line no-await-in-loop
          const finalized = isPromiseExit(closed) ? await closed : closed
          exit = completeCleanup(finalized, childContext)
        }
        outcomes[index] = exit
        if (exit._tag === 'Success') values[index] = exit.value
        else if (validate && exit.cause._tag === 'Fail') errors[index] = exit.cause.error
        else stop()
      }
    }
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
    } finally {
      // Stryker disable next-line all: listener cleanup prevents parent AbortSignal memory leaks after collection completes.
      fiberSignal.dispose()
    }
    let combined = collectOutcomes(values, outcomes, validate)
    if (validate && errors.length > 0)
      combined = combineExits(
        combined,
        failed(errors.filter((_error, index) => Object.hasOwn(errors, index))),
        'Parallel',
      )
    if (trackSignal && context.signal.aborted)
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
      pending ??= Promise.resolve(task.execute(context))
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
          const execution = Promise.resolve(
            task.execute(withScope(context, attempt, controller.signal)),
          ).then(async (exit) => {
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
  public static match<A, E, R, B, C = B>(
    task: ResultTask<A, E, R>,
    onOk: (value: A) => B,
    onErr: (error: E) => C,
  ): ResultTask<B | C, never, R>
  public static match<A, E, B, C = B>(
    handlers: ResultTaskMatchOptions<A, E, B, C>,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<B | C, never, R>
  public static match<A, E, B, C = B>(
    onOk: (value: A) => B,
    onErr: (error: E) => C,
  ): <R>(task: ResultTask<A, E, R>) => ResultTask<B | C, never, R>
  public static match<A, E, R, B, C = B>(
    taskOrHandlers: ResultTask<A, E, R> | ResultTaskMatchOptions<A, E, B, C> | ((value: A) => B),
    handlersOrOnOk?: ResultTaskMatchOptions<A, E, B, C> | ((value: A) => B) | ((error: E) => C),
    onErr?: (error: E) => C,
  ):
    | ResultTask<B | C, never, R>
    | (<R2>(task: ResultTask<A, E, R2>) => ResultTask<B | C, never, R2>) {
    if (taskOrHandlers instanceof ResultTask) {
      if (typeof handlersOrOnOk === 'function') {
        if (typeof onErr !== 'function') {
          throw new TypeError('ResultTask.match requires both onOk and onErr callbacks')
        }
        return taskOrHandlers.match(handlersOrOnOk as (value: A) => B, onErr)
      }
      if (handlersOrOnOk === undefined) {
        throw new TypeError('ResultTask.match requires match handlers')
      }
      return taskOrHandlers.match(handlersOrOnOk)
    }
    if (typeof taskOrHandlers === 'function') {
      if (typeof handlersOrOnOk !== 'function') {
        throw new TypeError('ResultTask.match requires both onOk and onErr callbacks')
      }
      const onOkFn = taskOrHandlers
      const onErrFn = handlersOrOnOk as (error: E) => C
      return (task) => task.match(onOkFn, onErrFn)
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
    return new ResultTask(ResultTask.runResult(task))
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
            ? asyncResultOrFactory(toNativeAbortSignal(context.signal))
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

  private static runExitSyncOrAsync<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Exit<A, E | ScopeError<R>> | Promise<Exit<A, E | ScopeError<R>>> {
    const signal = options?.signal ?? NEVER_ABORTED_SIGNAL
    const suppliedServices =
      options !== undefined && 'services' in options ? options.services : undefined
    const namedServices =
      suppliedServices === undefined
        ? EMPTY_NAMED_SERVICES
        : new Map(Object.entries(suppliedServices))
    const scope = new TaskScope()
    const clock = options?.clock ?? Clock.live
    const context: ResultTaskRuntimeContext = {
      namedServices,
      services: EMPTY_SERVICES,
      serviceResolver: undefined,
      signal,
      scope,
      clock,
      scheduling: createScheduling(clock, options),
      cleanup: undefined,
    }
    const exit = task.run(context)
    if (isPromiseExit(exit)) {
      return exit.then((resolvedExit) => {
        const closed = scope.closeSyncOrAsync(interruptSuccess(resolvedExit, signal))
        if (isPromiseExit(closed)) {
          return closed.then(
            (closedExit) => interruptSuccess(closedExit, signal) as Exit<A, E | ScopeError<R>>,
          )
        }
        return interruptSuccess(closed, signal) as Exit<A, E | ScopeError<R>>
      })
    }
    const closed = scope.closeSyncOrAsync(interruptSuccess(exit, signal))
    if (isPromiseExit(closed)) {
      return closed.then(
        (closedExit) => interruptSuccess(closedExit, signal) as Exit<A, E | ScopeError<R>>,
      )
    }
    return interruptSuccess(closed, signal) as Exit<A, E | ScopeError<R>>
  }

  private static runExitInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<Exit<A, E | ScopeError<R>>> {
    try {
      const outcome = ResultTask.runExitSyncOrAsync(task, options)
      return isPromiseExit(outcome) ? outcome : Promise.resolve(outcome)
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      )
    }
  }

  private static exitToResult<A, E>(exit: Exit<A, E>): Result<A, E> {
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

  private static exitToValue<A, E>(exit: Exit<A, E>): A {
    return ResultTask.exitToResult<A, E>(exit).unwrapOrThrow()
  }

  private static runResultInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<Result<A, E | ScopeError<R>>> {
    try {
      const outcome = ResultTask.runExitSyncOrAsync(task, options)
      if (isPromiseExit(outcome)) {
        return outcome.then((exit) => ResultTask.exitToResult(exit))
      }
      return Promise.resolve(ResultTask.exitToResult(outcome))
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      )
    }
  }

  private static runPromiseInternal<A, E, R>(
    task: ResultTask<A, E, R>,
    options?: ResultTaskRunOptions<R>,
  ): Promise<A> {
    try {
      const outcome = ResultTask.runExitSyncOrAsync(task, options)
      if (isPromiseExit(outcome)) {
        return outcome.then((exit) => ResultTask.exitToValue(exit))
      }
      return Promise.resolve(ResultTask.exitToValue(outcome))
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      )
    }
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
  public static runPromise<A, E, R>(
    task: ResultTask<A, E, R>,
    ...args: readonly [options?: ResultTaskRunOptions<R>]
  ): Promise<A> {
    return ResultTask.runPromiseInternal(task, args[0])
  }
}

const EMPTY_NAMED_SERVICES: ReadonlyMap<string, unknown> = new Map()
const EMPTY_SERVICES: ReadonlyMap<symbol, unknown> = new Map()

/**
 * Object form accepted by `tryResultAsync`.
 *
 * Use this form when named `try` and `catch` fields make an async boundary easier to read, or when
 * you want the mapper next to the promise factory.
 */
export interface TryResultAsyncOptions<T, E = unknown> {
  /**
   * Creates the promise whose rejection should become `Err<E>`.
   *
   * Synchronous throws from this function are also captured.
   */
  readonly try: () => Promise<T>
  /**
   * Converts a rejected or thrown `unknown` cause into the typed Resultar error channel.
   *
   * If omitted, the error channel is `unknown`.
   */
  readonly catch?: (e: unknown) => E
}

/** Minimal abort-signal contract used by cancellable Resultar operations. */
export interface ResultAsyncAbortSignal {
  /**
   * Whether the cooperative async operation has been aborted.
   */
  readonly aborted: boolean
  /**
   * Optional abort cause provided by the losing race, timeout, or caller.
   */
  readonly reason?: unknown
  /**
   * Registers an abort listener.
   */
  addEventListener: (
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ) => void
  /**
   * Removes an abort listener.
   */
  removeEventListener: (type: 'abort', listener: () => void) => void
}

/**
 * Context passed to `ResultAsync.fromCallback` subscriptions.
 */
export interface ResultAsyncCallbackContext<T> {
  /**
   * Completes the operation with `Ok(value)`.
   */
  readonly resolve: (value: T) => void
  /**
   * Completes the operation with a cause mapped by the subscription's `catch` function.
   */
  readonly reject: (cause: unknown) => void
  /**
   * Cooperative cancellation signal for the subscription.
   */
  readonly signal: ResultAsyncAbortSignal
}

/**
 * Synchronous cleanup returned by a `ResultAsync.fromCallback` subscription.
 */
export type ResultAsyncCallbackCleanup = () => void

/**
 * Options for adapting a callback or subscription API into `ResultAsync`.
 */
export interface ResultAsyncFromCallbackOptions<T, E> {
  /**
   * Maps callback failures and synchronous subscription throws into the typed error channel.
   */
  readonly catch: (cause: unknown) => E
  /**
   * Optional external signal that cancels the subscription with `AbortError`.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Registers the callback source and optionally returns a synchronous unsubscribe function.
   */
  readonly subscribe: (context: ResultAsyncCallbackContext<T>) => ResultAsyncCallbackCleanup | void
}

/**
 * Concurrency setting for async collection helpers.
 *
 * Use a number for bounded parallelism or `'unbounded'` when every task may start immediately.
 */
export type ResultAsyncConcurrency = number | 'unbounded'

type HandlerOk<R> = InferOkTypes<R> | InferAsyncOkTypes<R>
type HandlerErr<R> = InferErrTypes<R> | InferAsyncErrTypes<R>
type IterableElement<T> = T extends Iterable<infer Element> ? Element : never
/**
 * Candidate used by `ResultAsync.firstSuccessOf`.
 */
export type ResultAsyncCandidate = () => ResultAsync<unknown, unknown>
type ResultAsyncRecord = Readonly<Record<string, ResultAsync<unknown, unknown>>>
type CombineResultAsyncsRecord<T extends ResultAsyncRecord> = ResultAsync<
  { readonly [Key in keyof T]: InferAsyncOkTypes<T[Key]> },
  InferAsyncErrTypes<T[keyof T]>
>
type CombineResultAsyncsRecordWithAllErrors<T extends ResultAsyncRecord> = ResultAsync<
  { readonly [Key in keyof T]: InferAsyncOkTypes<T[Key]> },
  InferAsyncErrTypes<T[keyof T]>[]
>
type CombineResultAsyncsIterable<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type CombineResultAsyncsIterableWithAllErrors<R extends ResultAsync<unknown, unknown>> =
  ResultAsync<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>
/**
 * Task used by race, timeout, and retry helpers.
 *
 * The signal lets the task cooperate with cancellation when another task wins or a timeout fires.
 */
export type ResultAsyncRaceTask<T, E> = (signal: ResultAsyncAbortSignal) => ResultAsync<T, E>
type ResultAsyncRaceTaskOk<Task> = Task extends ResultAsyncRaceTask<infer T, unknown> ? T : never
type ResultAsyncRaceTaskErr<Task> = Task extends ResultAsyncRaceTask<unknown, infer E> ? E : never
type ResultAsyncRaceTasksOk<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> =
  ResultAsyncRaceTaskOk<Tasks[number]>
type ResultAsyncRaceTasksErr<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> =
  ResultAsyncRaceTaskErr<Tasks[number]>
/** Running cancellable task returned by Resultar race helpers. */
export interface ResultAsyncRaceHandle<T, E> {
  /**
   * Abort signal associated with the running task.
   */
  readonly signal: ResultAsyncAbortSignal
  /**
   * Aborts the running task with an optional reason.
   */
  abort: (reason?: unknown) => void
  /**
   * Waits for the task to settle as a ResultAsync.
   */
  wait: () => ResultAsync<T, E>
}

/**
 * Options for `ResultAsync.timeout`.
 */
export interface ResultAsyncTimeoutOptions<E> {
  /**
   * Creates the typed timeout error when the timeout wins.
   */
  readonly onTimeout: () => E
  /**
   * Timeout duration in milliseconds.
   */
  readonly timeoutMs: number
}

/**
 * Metadata passed to retry predicates, delays, callbacks, and fallback handlers.
 */
export interface ResultAsyncRetryContext extends RetryContext {
  /**
   * Current attempt number, starting at 0.
   */
  readonly attempt: number
  /**
   * Next attempt number if another retry is scheduled.
   */
  readonly nextAttempt: number
  /**
   * Number of retries still available after the current failure.
   */
  readonly retriesRemaining: number
}

/**
 * Task used by `ResultAsync.retry` and `ResultAsync.retryOrElse`.
 */
export type ResultAsyncRetryTask<T, E> = (
  attempt: number,
  signal: ResultAsyncAbortSignal,
) => ResultAsync<T, E>
type ResultAsyncRetryTaskOk<Task> = Task extends ResultAsyncRetryTask<infer T, infer _E> ? T : never
type ResultAsyncRetryTaskErr<Task> =
  Task extends ResultAsyncRetryTask<infer _T, infer E> ? E : never
// eslint-disable-next-line typescript/no-explicit-any -- Unknown contextual returns erase concrete errors in inline factories; outputs are inferred from Task.
type ResultAsyncRetryCandidate = ResultAsyncRetryTask<any, any>
type ResultAsyncRetryDelay = number | ((context: ResultAsyncRetryContext) => number)
/** Retry policy for `ResultAsync.retry` and related helpers. */
export interface ResultAsyncRetryOptions<E> {
  /**
   * Delay in milliseconds before retrying. Functions receive retry context.
   */
  readonly delayMs?: ResultAsyncRetryDelay
  /**
   * Randomizes the computed delay by this percentage factor.
   *
   * For example, `0.5` means 50% below to 50% above the computed delay.
   */
  readonly jittered?: number
  /**
   * Side effect called after a failed attempt that will be retried.
   */
  readonly onRetry?: (error: E, context: ResultAsyncRetryContext) => void | Promise<void>
  /**
   * Optional external abort signal for the retry loop.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Maximum number of retries after the initial attempt.
   */
  readonly times: number
  /**
   * Predicate deciding whether a failure is retryable.
   */
  readonly while?: (error: E, context: ResultAsyncRetryContext) => boolean | Promise<boolean>
}

/**
 * Options for `ResultAsync.retryOrElse`.
 */
export interface ResultAsyncRetryOrElseOptions<E, F, U> extends ResultAsyncRetryOptions<E> {
  /**
   * Fallback Resultar operation used after retry exhaustion.
   */
  readonly orElse: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>
}

type ResultAsyncRetryInput<E> =
  | ResultAsyncRetryOptions<E>
  | (RetryPolicy<E> & { readonly signal?: ResultAsyncAbortSignal })
type ResultAsyncRetryOrElseInput<E, F, U> = ResultAsyncRetryInput<E> & {
  readonly orElse: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>
}

/**
 * Acquires a resource for `ResultAsync.withResource`.
 */
export type ResultAsyncResourceAcquire<Resource, E> = (
  signal: ResultAsyncAbortSignal,
) => ResultAsync<Resource, E>
/**
 * Operation accepted by `ResultAsync.withResource` use/release callbacks.
 */
export type ResultAsyncResourceEffect<T, E> = Result<T, E> | ResultAsync<T, E>
/**
 * Uses an acquired resource inside `ResultAsync.withResource`.
 */
export type ResultAsyncResourceUse<Resource, T, E> = (
  resource: Resource,
  signal: ResultAsyncAbortSignal,
) => ResultAsyncResourceEffect<T, E>

/**
 * Context passed to resource release callbacks.
 */
export interface ResultAsyncResourceReleaseContext {
  /**
   * Result produced by the use phase, or undefined when acquisition failed.
   */
  readonly result: Result<unknown, unknown> | undefined
  /**
   * Abort signal shared by the resource lifecycle.
   */
  readonly signal: ResultAsyncAbortSignal
}
/**
 * Releases a resource after use, regardless of success or failure.
 */
export type ResultAsyncResourceRelease<Resource> = (
  resource: Resource,
  context: ResultAsyncResourceReleaseContext,
) => ResultAsyncResourceEffect<unknown, unknown> | Promise<void> | void

/**
 * Options for `ResultAsync.withResource`.
 */
export interface ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError> {
  /**
   * Acquires the resource.
   */
  readonly acquire: ResultAsyncResourceAcquire<Resource, AcquireError>
  /**
   * Releases the resource after use.
   */
  readonly release: ResultAsyncResourceRelease<Resource>
  /**
   * Optional external abort signal for the full lifecycle.
   */
  readonly signal?: ResultAsyncAbortSignal
  /**
   * Uses the acquired resource.
   */
  readonly use: ResultAsyncResourceUse<Resource, T, UseError>
}
export type FirstSuccessOfAsync<Candidates extends Iterable<ResultAsyncCandidate>> = ResultAsync<
  InferAsyncOkTypes<ReturnType<IterableElement<Candidates>>>,
  InferAsyncErrTypes<ReturnType<IterableElement<Candidates>>>
>
type ResultAsyncLoopCollected<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type ResultAsyncLoopDiscarded<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  void,
  InferAsyncErrTypes<R>
>
type ResultAsyncIterated<State, R extends ResultAsync<State, unknown>> = ResultAsync<
  State,
  InferAsyncErrTypes<R>
>
type ResultAsyncForEachCollected<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>
>
type ResultAsyncForEachDiscarded<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  void,
  InferAsyncErrTypes<R>
>
type ResultAsyncValidatedAll<R extends ResultAsync<unknown, unknown>> = ResultAsync<
  readonly InferAsyncOkTypes<R>[],
  InferAsyncErrTypes<R>[]
>
type ResultAsyncZipped<
  Left extends ResultAsync<unknown, unknown>,
  Right extends ResultAsync<unknown, unknown>,
> = ResultAsync<
  [InferAsyncOkTypes<Left>, InferAsyncOkTypes<Right>],
  InferAsyncErrTypes<Left> | InferAsyncErrTypes<Right>
>
type ResultAsyncBooleanCondition = boolean | (() => boolean)
type ResultAsyncConditional = Result<unknown, unknown> | ResultAsync<unknown, unknown>
type ResultAsyncConditionResult = Result<boolean, unknown> | ResultAsync<boolean, unknown>
type ResultAsyncCondition =
  | ResultAsyncBooleanCondition
  | ResultAsyncConditionResult
  | (() => ResultAsyncConditionResult)
type ResultAsyncConditionError<Condition> = Condition extends () => infer Value
  ? HandlerErr<Value>
  : HandlerErr<Condition>
type ResultAsyncIf<
  ConditionErr,
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
> = ResultAsync<
  HandlerOk<OnTrue> | HandlerOk<OnFalse>,
  ConditionErr | HandlerErr<OnTrue> | HandlerErr<OnFalse>
>
type ResultAsyncWhen<R extends ResultAsyncConditional, ConditionErr = never> = ResultAsync<
  HandlerOk<R> | undefined,
  ConditionErr | HandlerErr<R>
>
type ResultAsyncWhenWithCondition<
  Condition extends ResultAsyncConditionResult,
  R extends ResultAsyncConditional,
> = ResultAsyncWhen<R, HandlerErr<Condition>>
type WidenLiteral<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T

interface ResultAsyncLoopOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard?: false
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncLoopBooleanOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: false
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncLoopDiscardOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<unknown, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly discard: true
  readonly step: (state: BodyState) => State
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncLoopBooleanDiscardOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard: true
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncLoopRuntimeOptions<State, R extends ResultAsync<unknown, unknown>> {
  readonly body: (state: State) => R
  readonly discard?: boolean
  readonly step: (state: State) => State
  readonly while: (state: State) => boolean
}

interface ResultAsyncIterateOptions<
  State,
  BodyState extends State,
  R extends ResultAsync<State, unknown>,
> {
  readonly body: (state: BodyState) => R
  readonly while: (state: State) => state is BodyState
}

interface ResultAsyncIterateBooleanOptions<State, R extends ResultAsync<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultAsyncIterateRuntimeOptions<State, R extends ResultAsync<State, unknown>> {
  readonly body: (state: State) => R
  readonly while: (state: State) => boolean
}

interface ResultAsyncForEachOptions {
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard?: false
}

interface ResultAsyncForEachDiscardOptions {
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard: true
}

interface ResultAsyncForEachRuntimeOptions {
  readonly concurrency?: ResultAsyncConcurrency
  readonly discard?: boolean
}

interface ResultAsyncValidateAllOptions {
  readonly concurrency?: ResultAsyncConcurrency
}

interface ResultAsyncIfOptions<
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
> {
  readonly onFalse: () => OnFalse
  readonly onTrue: () => OnTrue
}

function isTryResultAsyncOptions<T, E>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T, E>,
): input is TryResultAsyncOptions<T, E> {
  // Stryker disable next-line all: guards prevent applying `in` to null/non-objects in invalid runtime calls.
  return typeof input === 'object' && input !== null && 'try' in input
}

const combineResultAsyncList = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combine(resultList),
  )

const collectResultAsyncRecord = async (
  asyncResultRecord: ResultAsyncRecord,
): Promise<Record<string, Result<unknown, unknown>>> => {
  const entries = await Promise.all(
    Object.entries(asyncResultRecord).map(
      async ([key, asyncResult]) => [key, await asyncResult] as const,
    ),
  )

  return Object.fromEntries(entries)
}

const combineResultAsyncRecord = <T extends ResultAsyncRecord>(
  asyncResultRecord: T,
): CombineResultAsyncsRecord<T> => {
  const promise = collectResultAsyncRecord(asyncResultRecord).then((resultRecord) =>
    Result.combine(resultRecord),
  )
  return new ResultAsync(promise) as CombineResultAsyncsRecord<T>
}

const combineResultAsyncListWithAllErrors = <T, E>(
  asyncResultList: readonly ResultAsync<T, E>[],
): ResultAsync<readonly T[], E[]> =>
  ResultAsync.fromSafePromise(Promise.all(asyncResultList)).andThen((resultList) =>
    Result.combineWithAllErrors(resultList),
  ) as ResultAsync<T[], E[]>

const combineResultAsyncRecordWithAllErrors = <T extends ResultAsyncRecord>(
  asyncResultRecord: T,
): CombineResultAsyncsRecordWithAllErrors<T> => {
  const promise = collectResultAsyncRecord(asyncResultRecord).then((resultRecord) =>
    Result.combineWithAllErrors(resultRecord),
  )
  return new ResultAsync(promise) as CombineResultAsyncsRecordWithAllErrors<T>
}

const isIterable = (value: unknown): value is Iterable<unknown> =>
  // Stryker disable next-line all: invalid null input still fails outside the iterable branch; this guard keeps the hot check explicit.
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'

interface IndexedResultAsyncError<E> {
  readonly error: E
  readonly index: number
}

const createIllegalArgumentException = (message: string): Error => {
  const error = new Error(message)
  error.name = 'IllegalArgumentException'

  return error
}

const createInvalidResultAsyncConcurrencyError = (): Error =>
  createIllegalArgumentException(
    'ResultAsync concurrency must be a positive integer or "unbounded"',
  )

const normalizeResultAsyncConcurrency = (concurrency?: ResultAsyncConcurrency): number => {
  if (concurrency === undefined) {
    return 1
  }

  if (concurrency === 'unbounded') {
    return Number.POSITIVE_INFINITY
  }

  if (Number.isInteger(concurrency) && concurrency > 0) {
    return concurrency
  }

  throw createInvalidResultAsyncConcurrencyError()
}

const toResultAsyncRejectionError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const sortIndexedResultAsyncErrors = <E>(
  errors: readonly IndexedResultAsyncError<E>[],
): IndexedResultAsyncError<E>[] => [...errors].toSorted((left, right) => left.index - right.index)

interface ResultAsyncTraversalState<T, E> {
  activeCount: number
  readonly errors: IndexedResultAsyncError<E>[]
  iteratorDone: boolean
  nextIndex: number
  stopScheduling: boolean
  readonly values: T[]
}

interface RunConcurrentResultAsyncItemsOptions<Item, T, E, Output, Failure> {
  readonly concurrency: ResultAsyncConcurrency | undefined
  readonly finish: (state: ResultAsyncTraversalState<T, E>) => Result<Output, Failure> | undefined
  readonly items: Iterable<Item>
  readonly onResult: (
    result: Result<T, E>,
    index: number,
    state: ResultAsyncTraversalState<T, E>,
  ) => void
  readonly run: (value: Item, index: number) => ResultAsync<T, E>
}

const createResultAsyncTraversalState = <T, E>(): ResultAsyncTraversalState<T, E> => ({
  activeCount: 0,
  errors: [],
  iteratorDone: false,
  nextIndex: 0,
  stopScheduling: false,
  values: [],
})

const runConcurrentResultAsyncItems = <Item, T, E, Output, Failure>(
  options: RunConcurrentResultAsyncItemsOptions<Item, T, E, Output, Failure>,
): Promise<Result<Output, Failure>> =>
  Promise.try(async () => {
    const concurrency = normalizeResultAsyncConcurrency(options.concurrency)
    const iterator = options.items[Symbol.iterator]()
    const state = createResultAsyncTraversalState<T, E>()

    return new Promise<Result<Output, Failure>>((resolve, reject) => {
      let settled = false

      const rejectOnce = (error: unknown): void => {
        // Stryker disable next-line all: setting the guard prevents later state updates after rejection.
        settled = true
        reject(toResultAsyncRejectionError(error))
      }

      const finishIfDone = (): void => {
        const result = options.finish(state)

        if (result !== undefined) {
          // Stryker disable next-line all: setting the guard prevents later state updates after resolution.
          settled = true
          resolve(result)
        }
      }

      const readNext = (): IteratorResult<Item> | undefined => {
        try {
          return iterator.next()
        } catch (error) {
          rejectOnce(error)
          return undefined
        }
      }

      const schedule = (): void => {
        while (!state.stopScheduling && !state.iteratorDone && state.activeCount < concurrency) {
          const next = readNext()

          // Stryker disable next-line all: undefined means iterator.next threw and rejectOnce already settled.
          if (next === undefined) {
            return
          }

          if (next.done === true) {
            state.iteratorDone = true
            break
          }

          const currentIndex = state.nextIndex
          state.nextIndex += 1
          startItem(next.value, currentIndex)
        }

        finishIfDone()
      }

      const startItem = (item: Item, currentIndex: number): void => {
        state.activeCount += 1

        try {
          const resultAsync = options.run(item, currentIndex)

          void Promise.resolve(resultAsync)
            .then((result) => {
              options.onResult(result, currentIndex, state)
            }, rejectOnce)
            .finally(() => {
              // Stryker disable next-line all: skip bookkeeping after rejectOnce/resolveOnce settled the promise.
              if (settled) {
                return
              }

              state.activeCount -= 1
              schedule()
            })
        } catch (error) {
          rejectOnce(error)
        }
      }

      schedule()
    })
  })

const createResultAsyncRetryAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync retry aborted')
    : new AbortError('ResultAsync retry aborted', { cause: signal.reason })

const createResultAsyncResourceAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync resource scope aborted')
    : new AbortError('ResultAsync resource scope aborted', { cause: signal.reason })

const createResultAsyncCallbackAbortError = (signal: ResultAsyncAbortSignal): AbortError =>
  signal.reason === undefined
    ? new AbortError('ResultAsync callback aborted')
    : new AbortError('ResultAsync callback aborted', { cause: signal.reason })

const emptyResultAsyncCallbackCleanup = (): void => undefined

const callResultAsyncCallbackCleanup = (cleanup: ResultAsyncCallbackCleanup): void => {
  try {
    cleanup()
  } catch {
    /* Cleanup is best-effort; use ResultTask.scoped/acquireRelease to preserve release failures. */
  }
}

const normalizeResultAsyncCallbackUnexpectedError = (error: unknown): Error =>
  isError(error)
    ? error
    : new Error('ResultAsync callback error mapper threw a non-Error value', { cause: error })

type ResultAsyncCallbackSettlement<T, E> =
  | { readonly error: unknown }
  | { readonly result: Result<T, E | AbortError> }

interface ResultAsyncCallbackCompletion<T, E> {
  readonly rejectResult: (error: Error) => void
  readonly resolveResult: (result: Result<T, E | AbortError>) => void
  readonly settlement: ResultAsyncCallbackSettlement<T, E>
}

const completeResultAsyncCallback = <T, E>(
  completion: ResultAsyncCallbackCompletion<T, E>,
): void => {
  if ('error' in completion.settlement) {
    completion.rejectResult(
      normalizeResultAsyncCallbackUnexpectedError(completion.settlement.error),
    )
    return
  }

  completion.resolveResult(completion.settlement.result)
}

const fromResultAsyncCallback = <T, E>(
  options: ResultAsyncFromCallbackOptions<T, E>,
): ResultAsync<T, E | AbortError> => {
  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal
  const promise = new Promise<Result<T, E | AbortError>>((resolveResult, rejectResult) => {
    if (signal.aborted) {
      resolveResult(Result.err(createResultAsyncCallbackAbortError(signal)))
      return
    }

    let cleanup: ResultAsyncCallbackCleanup = emptyResultAsyncCallbackCleanup
    let settlement: ResultAsyncCallbackSettlement<T, E> | undefined = undefined
    let subscribed = false

    const finalize = (): void => {
      if (!subscribed) {
        return
      }

      const completed = settlement

      if (completed === undefined) {
        return
      }

      signal.removeEventListener('abort', abort)
      callResultAsyncCallbackCleanup(cleanup)
      completeResultAsyncCallback({ rejectResult, resolveResult, settlement: completed })
    }
    const settle = (result: Result<T, E | AbortError>): void => {
      if (settlement !== undefined) {
        return
      }

      settlement = { result }
      finalize()
    }
    const rejectUnexpected = (error: unknown): void => {
      settlement = { error }
      finalize()
    }
    const abort = (): void => {
      settle(Result.err(createResultAsyncCallbackAbortError(signal)))
    }
    const context: ResultAsyncCallbackContext<T> = {
      reject: (cause) => {
        if (settlement !== undefined) {
          return
        }

        try {
          settle(Result.err(options.catch(cause)))
        } catch (error) {
          rejectUnexpected(error)
        }
      },
      resolve: (value) => {
        settle(Result.ok(value))
      },
      signal,
    }

    signal.addEventListener('abort', abort)

    try {
      cleanup = options.subscribe(context) ?? emptyResultAsyncCallbackCleanup
    } catch (error) {
      context.reject(error)
    }

    subscribed = true
    finalize()
  })

  return new ResultAsync(promise)
}

const validateResultAsyncRetryTimes = (times: number): void => {
  if (!Number.isInteger(times) || times < 0) {
    throw createIllegalArgumentException('ResultAsync retry times must be a non-negative integer')
  }
}

const validateResultAsyncRetryDelayValue = (delayMs: number): void => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw createIllegalArgumentException(
      'ResultAsync retry delayMs must be a non-negative finite number',
    )
  }
}

const validateResultAsyncRetryJittered = (jittered: number): void => {
  if (!Number.isFinite(jittered) || jittered < 0) {
    throw createIllegalArgumentException(
      'ResultAsync retry jittered must be a non-negative finite number',
    )
  }
}

const validateResultAsyncRetryJitterRandomValue = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw createIllegalArgumentException(
      'ResultAsync retry jitter random value must be a finite number between 0 and 1',
    )
  }
}

const validateResultAsyncRetryStaticJittered = (jittered: number | undefined): void => {
  if (jittered !== undefined) {
    validateResultAsyncRetryJittered(jittered)
  }
}

const validateResultAsyncRetryStaticDelay = (delay: ResultAsyncRetryDelay | undefined): void => {
  if (typeof delay === 'number') {
    validateResultAsyncRetryDelayValue(delay)
  }
}

const validateResultAsyncRetry = <E>(options: ResultAsyncRetryInput<E>): void => {
  if (isRetryPolicy<E>(options)) {
    validateRetryPolicy(options)
  } else {
    validateResultAsyncRetryTimes(options.times)
    validateResultAsyncRetryStaticDelay(options.delayMs)
    validateResultAsyncRetryStaticJittered(options.jittered)
  }
}

const resultAsyncRetryDelay = <E>(
  options: ResultAsyncRetryInput<E>,
  context: ResultAsyncRetryContext,
): number => {
  if (isRetryPolicy<E>(options)) return retryPolicyDelay(options, context, Math.random)
  let delayMs =
    typeof options.delayMs === 'function' ? options.delayMs(context) : (options.delayMs ?? 0)
  validateResultAsyncRetryDelayValue(delayMs)
  const jittered = options.jittered
  if (jittered !== undefined && jittered !== 0 && delayMs !== 0) {
    const random = Math.random()
    validateResultAsyncRetryJitterRandomValue(random)
    const range = delayMs * jittered
    const min = Math.max(0, delayMs - range)
    const max = delayMs + range
    delayMs = min + (max - min) * random
  }
  return delayMs
}

const waitResultAsyncRetryDelay = async (
  delayMs: number,
  signal: ResultAsyncAbortSignal,
): Promise<Result<void, AbortError>> => {
  if (signal.aborted) {
    return Result.err(createResultAsyncRetryAbortError(signal))
  }

  if (delayMs === 0) {
    return Result.ok(undefined)
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(Result.ok(undefined))
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timeout)
      resolve(Result.err(createResultAsyncRetryAbortError(signal)))
    }

    signal.addEventListener('abort', abort, { once: true })
  })
}

const canRetryResultAsyncAttempt = async <E>(
  options: ResultAsyncRetryInput<E>,
  error: E,
  context: ResultAsyncRetryContext,
): Promise<boolean> => {
  if (context.attempt >= options.times) {
    if (options.while !== undefined && !isRetryPolicy<E>(options)) {
      await options.while(error, context)
    }
    return false
  }
  return options.while === undefined ? true : options.while(error, context)
}

// Expected failures stay in Result; unexpected callback failures reject the eager operation.
const runResultAsyncRetryAttempts = async <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryInput<E>,
  recover: (error: E, context: ResultAsyncRetryContext) => Result<U, F> | ResultAsync<U, F>,
): Promise<Result<T | U, F | AbortError>> => {
  validateResultAsyncRetry(options)

  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal
  let attempt = 0

  while (true) {
    if (signal.aborted) {
      return Result.err(createResultAsyncRetryAbortError(signal))
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await task(attempt, signal)

    if (result.isOk()) {
      return Result.ok(result.value)
    }

    const context = retryContext(attempt, options.times)

    // eslint-disable-next-line no-await-in-loop
    if (!(await canRetryResultAsyncAttempt(options, result.error, context))) {
      return recover(result.error, context)
    }

    const onRetry = options.onRetry

    // Stryker disable next-line all: skip a needless function call and await when no retry hook exists.
    if (onRetry !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      await observeRetry(options, result.error, context)
    }

    const delayMs = resultAsyncRetryDelay(options, context)

    // eslint-disable-next-line no-await-in-loop
    const delayResult = await waitResultAsyncRetryDelay(delayMs, signal)

    if (delayResult.isErr()) {
      return Result.err(delayResult.error)
    }

    attempt += 1
  }
}

const retryResultAsyncTask = <T, E>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryInput<E>,
): ResultAsync<T, E | AbortError> =>
  new ResultAsync(
    runResultAsyncRetryAttempts<T, E, never, E>(task, options, (error) => Result.err(error)),
  )

const retryOrElseResultAsyncTask = <T, E, U, F>(
  task: ResultAsyncRetryTask<T, E>,
  options: ResultAsyncRetryOrElseInput<E, F, U>,
): ResultAsync<T | U, F | AbortError> =>
  new ResultAsync(
    runResultAsyncRetryAttempts<T, E, U, F>(task, options, (error, context) =>
      options.orElse(error, context),
    ),
  )

const callResultAsyncResourceRelease = async <Resource>(
  release: ResultAsyncResourceRelease<Resource>,
  resource: Resource,
  context: ResultAsyncResourceReleaseContext,
): Promise<void> => {
  try {
    await release(resource, context)
  } catch {
    /* empty */
  }
}

const runResultAsyncWithResource = async <Resource, AcquireError, T, UseError>(
  options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
): Promise<Result<T, AcquireError | UseError | AbortError>> => {
  const signal: ResultAsyncAbortSignal = options.signal ?? new AbortController().signal

  if (signal.aborted) {
    return Result.err(createResultAsyncResourceAbortError(signal))
  }

  const acquired = await options.acquire(signal)

  if (acquired.isErr()) {
    return Result.err(acquired.error)
  }

  let result: Result<T, UseError | AbortError> | undefined = undefined

  try {
    if (signal.aborted) {
      result = Result.err(createResultAsyncResourceAbortError(signal))
      return result
    }

    result = await toResultAsync(options.use(acquired.value, signal))

    return result
  } finally {
    await callResultAsyncResourceRelease(options.release, acquired.value, { result, signal })
  }
}

const withResultAsyncResource = <Resource, AcquireError, T, UseError>(
  options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
): ResultAsync<T, AcquireError | UseError | AbortError> =>
  new ResultAsync(runResultAsyncWithResource(options))

const validateAllResultAsyncItems = <Item, R extends ResultAsync<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
  options?: ResultAsyncValidateAllOptions,
): ResultAsyncValidatedAll<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>> =
    runConcurrentResultAsyncItems({
      concurrency: options?.concurrency,
      finish: (state) => {
        if (!state.iteratorDone || state.activeCount > 0) {
          return undefined
        }

        if (state.errors.length > 0) {
          return Result.err<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>(
            sortIndexedResultAsyncErrors(state.errors).map((entry) => entry.error),
          )
        }

        return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>[]>(state.values)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          return
        }

        state.values[currentIndex] = result.value
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

  return new ResultAsync(promise) as ResultAsyncValidatedAll<R>
}

const firstSuccessOfAsyncCandidates = <Candidates extends Iterable<ResultAsyncCandidate>>(
  candidates: Candidates,
): FirstSuccessOfAsync<Candidates> => {
  const promise = Promise.try(async () => {
    let latestError: Result<unknown, unknown> | undefined = undefined

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const result = await candidate()

      if (result.isOk()) {
        return result
      }

      latestError = result
    }

    if (latestError === undefined) {
      throw createEmptyResultsCollectionError()
    }

    return latestError
  })

  return new ResultAsync(promise) as FirstSuccessOfAsync<Candidates>
}

interface StartedRaceTask<T, E> {
  readonly controller: AbortController
  readonly result: ResultAsync<T, E>
  readonly settled: Promise<{ readonly index: number; readonly result: Result<T, E> }>
}

const createRaceAbortReason = (): AbortError => new AbortError('ResultAsync race loser interrupted')

const startRaceTask = <T, E>(
  task: ResultAsyncRaceTask<T, E>,
  index: number,
): StartedRaceTask<T, E> => {
  const controller = new AbortController()
  const result = task(controller.signal)
  const settled = Promise.resolve(result).then((taskResult) => ({ index, result: taskResult }))

  return { controller, result, settled }
}

const createRaceHandle = <T, E>(task: StartedRaceTask<T, E>): ResultAsyncRaceHandle<T, E> => ({
  get signal() {
    return task.controller.signal
  },
  abort(reason = createRaceAbortReason()) {
    task.controller.abort(reason)
  },
  wait() {
    return task.result
  },
})

interface RaceSettlementState {
  settled: boolean
}

interface RaceSuccessState extends RaceSettlementState {
  completedCount: number
  completedIndexes: Set<number>
  latestError: Result<unknown, unknown> | undefined
}

interface RaceFirstObserverContext<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> {
  readonly resolve: (
    result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
  ) => void
  readonly startedTasks: readonly StartedRaceTask<unknown, unknown>[]
  readonly state: RaceSettlementState
}

interface RaceSuccessObserverContext<
  Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[],
> {
  readonly resolve: (
    result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
  ) => void
  readonly startedTasks: readonly StartedRaceTask<unknown, unknown>[]
  readonly state: RaceSuccessState
}

type RaceTaskResolve<Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]> = (
  result: Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
) => void

const observeRaceFirstTask = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  task: StartedRaceTask<unknown, unknown>,
  context: RaceFirstObserverContext<Tasks>,
): void => {
  void task.settled.then(({ index, result }) => {
    if (context.state.settled) {
      return
    }

    context.state.settled = true
    const startedTasks = context.startedTasks

    for (const [loserIndex, loser] of startedTasks.entries()) {
      if (loserIndex !== index) {
        loser.controller.abort(createRaceAbortReason())
      }
    }

    context.resolve(result as Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>)
  })
}

const observeRaceSuccessTask = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  task: StartedRaceTask<unknown, unknown>,
  context: RaceSuccessObserverContext<Tasks>,
): void => {
  void task.settled.then(({ index, result }) => {
    // Stryker disable next-line all: ignore late settlements after the race already resolved.
    if (context.state.settled) {
      return
    }

    context.state.completedIndexes.add(index)

    if (result.isOk()) {
      // Stryker disable next-line all: marks the race as resolved before aborting pending losers.
      context.state.settled = true
      const startedTasks = context.startedTasks

      for (const [loserIndex, loser] of startedTasks.entries()) {
        if (!context.state.completedIndexes.has(loserIndex)) {
          loser.controller.abort(createRaceAbortReason())
        }
      }

      context.resolve(
        result as Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>,
      )
      return
    }

    context.state.completedCount += 1
    context.state.latestError = result

    if (context.state.completedCount === context.startedTasks.length) {
      // Stryker disable next-line all: all tasks failed, so future late settlements must be ignored.
      context.state.settled = true
      context.resolve(
        context.state.latestError as Result<
          ResultAsyncRaceTasksOk<Tasks>,
          ResultAsyncRaceTasksErr<Tasks>
        >,
      )
    }
  })
}

const observeRaceResultAsyncTasks = <
  Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[],
  Context,
>(
  tasks: Tasks,
  createContext: (
    resolve: RaceTaskResolve<Tasks>,
    startedTasks: readonly StartedRaceTask<unknown, unknown>[],
  ) => Context,
  observeTask: (task: StartedRaceTask<unknown, unknown>, context: Context) => void,
): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> => {
  const taskList = [...tasks]

  if (taskList.length === 0) {
    return new ResultAsync(
      Promise.resolve(Result.err(createEmptyResultsCollectionError())),
    ) as ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>
  }

  const promise = new Promise<
    Result<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>>
  >((resolve) => {
    const startedTasks = taskList.map((task, index) => startRaceTask(task, index))
    const context = createContext(resolve, startedTasks)

    for (const task of startedTasks) {
      observeTask(task, context)
    }
  })

  return new ResultAsync(promise)
}

const raceResultAsyncTasks = <Tasks extends readonly ResultAsyncRaceTask<unknown, unknown>[]>(
  tasks: Tasks,
): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> =>
  observeRaceResultAsyncTasks<Tasks, RaceSuccessObserverContext<Tasks>>(
    tasks,
    (resolve, startedTasks) => ({
      resolve,
      startedTasks,
      state: {
        completedCount: 0,
        completedIndexes: new Set<number>(),
        latestError: undefined,
        // Stryker disable next-line all: explicit false and missing value are equivalent before first settlement.
        settled: false,
      },
    }),
    observeRaceSuccessTask,
  )

const loopResultAsync = <State, R extends ResultAsync<unknown, unknown>>(
  initial: State,
  options: ResultAsyncLoopRuntimeOptions<State, R>,
): ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R> => {
  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    Promise.try(async () => {
      let state = initial

      if (options.discard === true) {
        while (options.while(state)) {
          // eslint-disable-next-line no-await-in-loop
          const result = await options.body(state)

          if (result.isErr()) {
            return Result.err(result.error as InferAsyncErrTypes<R>)
          }

          state = options.step(state)
        }

        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      }

      const values: InferAsyncOkTypes<R>[] = []

      while (options.while(state)) {
        // eslint-disable-next-line no-await-in-loop
        const result = await options.body(state)

        if (result.isErr()) {
          return Result.err(result.error as InferAsyncErrTypes<R>)
        }

        values.push(result.value as InferAsyncOkTypes<R>)
        state = options.step(state)
      }

      return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>>(values)
    })

  return new ResultAsync(promise) as ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R>
}

const iterateResultAsync = <State, R extends ResultAsync<State, unknown>>(
  initial: State,
  options: ResultAsyncIterateRuntimeOptions<State, R>,
): ResultAsyncIterated<State, R> => {
  const promise = Promise.try(async () => {
    let state = initial

    while (options.while(state)) {
      // eslint-disable-next-line no-await-in-loop
      const result = await options.body(state)

      if (result.isErr()) {
        return Result.err(result.error as InferAsyncErrTypes<R>)
      }

      state = result.value
    }

    return Result.ok<State, InferAsyncErrTypes<R>>(state)
  })

  return new ResultAsync(promise) as ResultAsyncIterated<State, R>
}

const forEachResultAsync = <Item, R extends ResultAsync<unknown, unknown>>(
  items: Iterable<Item>,
  f: (value: Item, index: number) => R,
  options?: ResultAsyncForEachRuntimeOptions,
): ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R> => {
  if (options?.discard === true) {
    const promise: Promise<Result<void, InferAsyncErrTypes<R>>> = runConcurrentResultAsyncItems({
      concurrency: options.concurrency,
      finish: (state) => {
        if (state.activeCount > 0) {
          return undefined
        }

        const firstError = sortIndexedResultAsyncErrors(state.errors)[0]

        if (firstError !== undefined) {
          return Result.err<void, InferAsyncErrTypes<R>>(firstError.error)
        }

        return Result.ok<void, InferAsyncErrTypes<R>>(undefined)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          state.stopScheduling = true
        }
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

    return new ResultAsync(promise) as ResultAsyncForEachDiscarded<R>
  }

  const promise: Promise<Result<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>> =
    runConcurrentResultAsyncItems({
      concurrency: options?.concurrency,
      finish: (state) => {
        if (state.activeCount > 0) {
          return undefined
        }

        const firstError = sortIndexedResultAsyncErrors(state.errors)[0]

        if (firstError !== undefined) {
          return Result.err<readonly InferAsyncOkTypes<R>[] | void, InferAsyncErrTypes<R>>(
            firstError.error,
          )
        }

        return Result.ok<readonly InferAsyncOkTypes<R>[], InferAsyncErrTypes<R>>(state.values)
      },
      items,
      onResult: (result, currentIndex, state) => {
        if (result.isErr()) {
          state.errors.push({ error: result.error, index: currentIndex })
          state.stopScheduling = true
          return
        }

        state.values[currentIndex] = result.value
      },
      run: f as (
        value: Item,
        index: number,
      ) => ResultAsync<InferAsyncOkTypes<R>, InferAsyncErrTypes<R>>,
    })

  return new ResultAsync(promise) as ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R>
}

const resolveResultAsyncBooleanCondition = (condition: ResultAsyncBooleanCondition): boolean =>
  typeof condition === 'function' ? condition() : condition

const toResultAsync = <R extends ResultAsyncConditional>(
  result: R,
): ResultAsync<HandlerOk<R>, HandlerErr<R>> => {
  // Stryker disable next-line all: preserve existing ResultAsync instead of wrapping it in another thenable.
  if (result instanceof ResultAsync) {
    return result as ResultAsync<HandlerOk<R>, HandlerErr<R>>
  }

  return new ResultAsync(Promise.resolve(result as Result<HandlerOk<R>, HandlerErr<R>>))
}

const ifResultAsync = <
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
>(
  condition: ResultAsyncBooleanCondition,
  options: ResultAsyncIfOptions<OnTrue, OnFalse>,
): ResultAsyncIf<never, OnTrue, OnFalse> => {
  const promise: Promise<
    Result<HandlerOk<OnTrue> | HandlerOk<OnFalse>, HandlerErr<OnTrue> | HandlerErr<OnFalse>>
  > = Promise.try(async () => {
    const result = resolveResultAsyncBooleanCondition(condition)
      ? options.onTrue()
      : options.onFalse()

    return (await toResultAsync(result)) as Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  })

  return new ResultAsync(promise) as ResultAsyncIf<never, OnTrue, OnFalse>
}

const ifResultAsyncWithCondition = <
  Condition extends ResultAsyncConditionResult,
  OnTrue extends ResultAsyncConditional,
  OnFalse extends ResultAsyncConditional,
>(
  condition: Condition,
  options: ResultAsyncIfOptions<OnTrue, OnFalse>,
): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse> => {
  const promise: Promise<
    Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<Condition> | HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  > = Promise.try(async () => {
    const conditionResult = await toResultAsync(condition)

    if (conditionResult.isErr()) {
      return Result.err(conditionResult.error)
    }

    const result = conditionResult.value ? options.onTrue() : options.onFalse()

    return (await toResultAsync(result)) as Result<
      HandlerOk<OnTrue> | HandlerOk<OnFalse>,
      HandlerErr<Condition> | HandlerErr<OnTrue> | HandlerErr<OnFalse>
    >
  })

  return new ResultAsync(promise) as ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse>
}

const whenResultAsyncByPredicate = <
  Condition extends ResultAsyncCondition,
  R extends ResultAsyncConditional,
>(
  condition: Condition,
  body: R | (() => R),
  predicate: (condition: boolean) => boolean,
): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>> => {
  const promise: Promise<
    Result<HandlerOk<R> | undefined, ResultAsyncConditionError<Condition> | HandlerErr<R>>
  > = Promise.try(async () => {
    const rawCondition: ResultAsyncCondition = condition
    const evaluatedCondition = typeof rawCondition === 'function' ? rawCondition() : rawCondition
    const conditionResult =
      typeof evaluatedCondition === 'boolean'
        ? Result.ok(evaluatedCondition)
        : await toResultAsync(evaluatedCondition)

    if (conditionResult.isErr()) {
      return Result.err(conditionResult.error as ResultAsyncConditionError<Condition>)
    }

    const conditionValue = conditionResult.value

    if (!predicate(conditionValue)) {
      return Result.ok<
        HandlerOk<R> | undefined,
        ResultAsyncConditionError<Condition> | HandlerErr<R>
      >(undefined)
    }

    const evaluatedBody = typeof body === 'function' ? body() : body
    return (await toResultAsync(evaluatedBody)) as Result<
      HandlerOk<R> | undefined,
      ResultAsyncConditionError<Condition> | HandlerErr<R>
    >
  })

  return new ResultAsync(promise) as ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
}

/**
 * Represents an asynchronous Result type that is an alias for `ResultTask<T, E, never>`.
 *
 * @template T - The type of the success value
 * @template E - The type of the error value
 */
export type ResultAsync<T, E = never> = ResultTask<T, E, never>

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Static overload holder copied onto ResultAsyncFactory.
class ResultAsyncStatic {
  /** Maps the success value directly or as a reusable operator for `pipe`. */
  public static map<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => Output,
  ): ResultAsync<Output, ErrorValue>
  public static map<Input, Output>(
    this: void,
    f: (value: Input) => Output,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output, ErrorValue>
  public static map(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (value: unknown) => unknown) => self.map(f),
    )(...args)
  }

  /** Maps the error value directly or as a reusable operator for `pipe`. */
  public static mapErr<Input, ErrorValue, ErrorOutput>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => ErrorOutput,
  ): ResultAsync<Input, ErrorOutput>
  public static mapErr<ErrorValue, ErrorOutput>(
    this: void,
    f: (error: ErrorValue) => ErrorOutput,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorOutput>
  public static mapErr(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => unknown) => self.mapErr(f),
    )(...args)
  }

  /** Chains a Result or ResultAsync directly or as a reusable operator for `pipe`. */
  public static andThen<
    Input,
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => Next,
  ): ResultAsync<HandlerOk<Next>, ErrorValue | HandlerErr<Next>>
  public static andThen<
    Input,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    f: (value: Input) => Next,
  ): <ErrorValue>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<HandlerOk<Next>, ErrorValue | HandlerErr<Next>>
  public static andThen(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (
        self: ResultAsync<unknown, unknown>,
        f: (value: unknown) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.andThen(f),
    )(...args)
  }

  /** Recovers the error channel directly or as a reusable operator for `pipe`. */
  public static orElse<
    Input,
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => Next,
  ): ResultAsync<Input | HandlerOk<Next>, HandlerErr<Next>>
  public static orElse<
    ErrorValue,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    f: (error: ErrorValue) => Next,
  ): <Input>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Input | HandlerOk<Next>, HandlerErr<Next>>
  public static orElse(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (
        self: ResultAsync<unknown, unknown>,
        f: (error: unknown) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.orElse(f),
    )(...args)
  }

  /** Recovers the error channel with a plain success value directly or in `pipe`. */
  public static orElseSucceed<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => Output,
  ): ResultAsync<Input | Output, never>
  public static orElseSucceed<ErrorValue, Output>(
    this: void,
    f: (error: ErrorValue) => Output,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input | Output, never>
  public static orElseSucceed(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => unknown) =>
        self.orElseSucceed(f),
    )(...args)
  }

  /** Resolves to the Ok value or `defaultValue` when Err, directly or in `pipe`. */
  public static unwrapOr<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    defaultValue: Output,
  ): ResultAsync<Input | Output, never>
  public static unwrapOr<Output>(
    this: void,
    defaultValue: Output,
  ): <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input | Output, never>
  public static unwrapOr(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, defaultValue: unknown) => self.unwrapOr(defaultValue),
    )(...args)
  }

  /** Recovers from a specific tagged error directly or as a reusable operator for `pipe`. */
  public static catchTag<
    Input,
    ErrorValue,
    const Tag extends TagsOf<ErrorValue>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<ErrorValue, Tag>>) => Next,
  ): ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag<
    Input,
    ErrorValue,
    const Tag extends TagsOf<ErrorValue>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    tag: Tag,
    f: (error: NoInfer<ErrorForTag<ErrorValue, Tag>>) => Next,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag<
    const Tag extends string,
    Handled extends { readonly _tag: Tag },
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    tag: Tag,
    f: (error: Handled) => Next,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (Tag extends TagsOf<ErrorValue>
        ? ErrorForTag<ErrorValue, Tag> extends Handled
          ? unknown
          : never
        : never),
  ) => ResultAsync<Input | HandlerOk<Next>, ExcludeTag<ErrorValue, Tag> | HandlerErr<Next>>
  public static catchTag(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (
        self: ResultAsync<unknown, unknown>,
        tag: string,
        f: (error: never) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.catchTag(tag as never, f),
    )(...args)
  }

  /** Recovers from multiple tagged errors directly or as a reusable operator for `pipe`. */
  public static catchTags<Input, ErrorValue, const Handlers extends object>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: Handlers & ResultAsyncCatchTagHandlers<ErrorValue, Handlers>,
  ): ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags<Input, ErrorValue, const Handlers extends object>(
    this: void,
    handlers: Handlers & ResultAsyncCatchTagHandlers<ErrorValue, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags<const Handlers extends object>(
    this: void,
    handlers: Handlers,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (Handlers extends ResultAsyncCatchTagHandlers<ErrorValue, Handlers> ? unknown : never),
  ) => ResultAsync<
    Input | HandlerOk<CatchTagHandlerResult<Handlers>>,
    | ExcludeTag<ErrorValue, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchTagHandlerResult<Handlers>>
  >
  public static catchTags(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, handlers: Record<string, never>) =>
        self.catchTags(handlers),
    )(...args)
  }

  /* eslint-disable max-params */
  /** Recovers from a nested tagged reason on a specific tagged error directly or in `pipe`. */
  public static catchReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<ErrorValue, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<ErrorValue, ErrorTag>>,
    ) => Next,
  ): ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>,
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (
      reason: NoInfer<ReasonForTag<ErrorValue, ErrorTag, ReasonTag>>,
      error: NoInfer<ErrorForTag<ErrorValue, ErrorTag>>,
    ) => Next,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason<
    const ErrorTag extends string,
    const ReasonTag extends string,
    HandledReason extends { readonly _tag: ReasonTag },
    HandledError extends { readonly _tag: ErrorTag; readonly reason: unknown } = {
      readonly _tag: ErrorTag
      readonly reason: HandledReason
    },
    Next extends Result<unknown, unknown> | ResultAsync<unknown, unknown> =
      | Result<unknown, unknown>
      | ResultAsync<unknown, unknown>,
  >(
    this: void,
    errorTag: ErrorTag,
    reasonTag: ReasonTag,
    f: (reason: HandledReason, error: HandledError) => Next,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue>
        ? ReasonTag extends ReasonTagsOf<ErrorValue, ErrorTag>
          ? ReasonForTag<ErrorValue, ErrorTag, ReasonTag> extends HandledReason
            ? ErrorForTag<ErrorValue, ErrorTag> extends HandledError
              ? unknown
              : never
            : never
          : never
        : never),
  ) => ResultAsync<
    Input | HandlerOk<Next>,
    ExcludeReasonTag<ErrorValue, ErrorTag, ReasonTag> | HandlerErr<Next>
  >
  public static catchReason(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 4,
      (
        self: ResultAsync<unknown, unknown>,
        errorTag: string,
        reasonTag: string,
        f: (
          reason: never,
          error: never,
        ) => Result<unknown, unknown> | ResultAsync<unknown, unknown>,
      ) => self.catchReason(errorTag as never, reasonTag as never, f),
    )(...args)
  }
  /* eslint-enable max-params */

  /** Recovers from multiple nested tagged reasons on a specific tagged error directly or in `pipe`. */
  public static catchReasons<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const Handlers extends object,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
    handlers: Handlers & ResultAsyncCatchReasonHandlers<ErrorValue, ErrorTag, Handlers>,
  ): ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
    const Handlers extends object,
  >(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers & ResultAsyncCatchReasonHandlers<ErrorValue, ErrorTag, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons<const ErrorTag extends string, const Handlers extends object>(
    this: void,
    errorTag: ErrorTag,
    handlers: Handlers,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue>
        ? Handlers extends ResultAsyncCatchReasonHandlers<ErrorValue, ErrorTag, Handlers>
          ? unknown
          : never
        : never),
  ) => ResultAsync<
    Input | HandlerOk<CatchReasonHandlerResult<Handlers>>,
    | ExcludeReasonTag<ErrorValue, ErrorTag, CoveredHandlerKeys<Handlers> & string>
    | HandlerErr<CatchReasonHandlerResult<Handlers>>
  >
  public static catchReasons(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (self: ResultAsync<unknown, unknown>, errorTag: string, handlers: Record<string, never>) =>
        self.catchReasons(errorTag as never, handlers),
    )(...args)
  }

  /** Moves the nested reason of a tagged error into the error channel directly or in `pipe`. */
  public static unwrapReason<
    Input,
    ErrorValue,
    const ErrorTag extends TagsWithReasonOf<ErrorValue>,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    errorTag: ErrorTag,
  ): ResultAsync<Input, ExcludeTag<ErrorValue, ErrorTag> | ReasonsOf<ErrorValue, ErrorTag>>
  public static unwrapReason<const ErrorTag extends string>(
    this: void,
    errorTag: ErrorTag,
  ): <Input, ErrorValue>(
    self: ResultAsync<Input, ErrorValue> &
      (ErrorTag extends TagsWithReasonOf<ErrorValue> ? unknown : never),
  ) => ResultAsync<Input, ExcludeTag<ErrorValue, ErrorTag> | ReasonsOf<ErrorValue, ErrorTag>>
  public static unwrapReason(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, errorTag: string) =>
        self.unwrapReason(errorTag as never),
    )(...args)
  }

  /** Observes success, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspect<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (value: Input) => void | Promise<void>,
  ): ResultAsync<Input, ErrorValue>
  public static inspect<Input>(
    this: void,
    f: (value: Input) => void | Promise<void>,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspect(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (value: unknown) => void | Promise<void>) =>
        self.inspect(f),
    )(...args)
  }

  /** Observes failure, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspectError<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    f: (error: ErrorValue) => void | Promise<void>,
  ): ResultAsync<Input, ErrorValue>
  public static inspectError<ErrorValue>(
    this: void,
    f: (error: ErrorValue) => void | Promise<void>,
  ): <Input>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectError(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, f: (error: unknown) => void | Promise<void>) =>
        self.inspectError(f),
    )(...args)
  }

  /** Observes both branches, ignoring callback failures, directly or as an operator for `pipe`. */
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: MatchHandlers<Input, ErrorValue, void | Promise<void>, void | Promise<void>>,
  ): ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => void | Promise<void>,
    onErr: (error: ErrorValue) => void | Promise<void>,
  ): ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    handlers: MatchHandlers<Input, ErrorValue, void | Promise<void>, void | Promise<void>>,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectBoth<Input, ErrorValue>(
    this: void,
    onOk: (value: Input) => void | Promise<void>,
    onErr: (error: ErrorValue) => void | Promise<void>,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue>
  public static inspectBoth(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input[0] instanceof ResultAsync,
      (
        self: ResultAsync<unknown, unknown>,
        handlers:
          | MatchHandlers<unknown, unknown, void | Promise<void>, void | Promise<void>>
          | ((value: unknown) => void | Promise<void>),
        onErr?: (error: unknown) => void | Promise<void>,
      ) =>
        self.inspectBoth(
          handlers as (value: unknown) => void | Promise<void>,
          onErr as (error: unknown) => void | Promise<void>,
        ),
    )(...args)
  }

  /** Converts either variant to a ResultAsync of a plain value, directly or in `pipe`. */
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    handlers: MatchHandlers<Input, ErrorValue, Output, FailureOutput>,
  ): ResultAsync<Output | FailureOutput, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    onErr: (error: ErrorValue) => FailureOutput,
  ): ResultAsync<Output | FailureOutput, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    handlers: MatchHandlers<Input, ErrorValue, Output, FailureOutput>,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output | FailureOutput, never>
  public static match<Input, ErrorValue, Output, FailureOutput = Output>(
    this: void,
    onOk: (value: Input) => Output,
    onErr: (error: ErrorValue) => FailureOutput,
  ): (self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output | FailureOutput, never>
  public static match(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input[0] instanceof ResultAsync,
      (
        self: ResultAsync<unknown, unknown>,
        handlers: MatchHandlers<unknown, unknown, unknown> | ((value: unknown) => unknown),
        onErr?: (error: unknown) => unknown,
      ) =>
        self.match(handlers as (value: unknown) => unknown, onErr as (error: unknown) => unknown),
    )(...args)
  }

  /** Exhaustively matches tagged errors into a ResultAsync directly or in `pipe`. */
  public static matchTags<Input, ErrorValue, Output, const Handlers extends object>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    handlers: Handlers & MatchTagHandlers<ErrorValue, Handlers>,
  ): ResultAsync<Output | MatchTagHandlerResult<Handlers>, never>
  public static matchTags<Input, ErrorValue, Output, const Handlers extends object>(
    this: void,
    onOk: (value: Input) => Output,
    handlers: Handlers & MatchTagHandlers<ErrorValue, Handlers>,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Output | MatchTagHandlerResult<Handlers>, never>
  public static matchTags(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (self: ResultAsync<unknown, unknown>, onOk: (value: unknown) => unknown, handlers: never) =>
        self.matchTags(onOk, handlers),
    )(...args)
  }

  /* eslint-disable max-params */
  /** Partially matches tagged errors with a narrowed fallback into a ResultAsync directly or in `pipe`. */
  public static matchTagsPartial<
    Input,
    ErrorValue,
    Output,
    FallbackOutput,
    const Handlers extends object,
  >(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    onOk: (value: Input) => Output,
    handlers: Handlers & PartialMatchTagHandlers<ErrorValue, Handlers>,
    fallback: (error: RemainingMatchTagErrors<ErrorValue, Handlers>) => FallbackOutput,
  ): ResultAsync<Output | MatchTagHandlerResult<Handlers> | FallbackOutput, never>
  public static matchTagsPartial<
    Input,
    ErrorValue,
    Output,
    FallbackOutput,
    const Handlers extends object,
  >(
    this: void,
    onOk: (value: Input) => Output,
    handlers: Handlers & PartialMatchTagHandlers<ErrorValue, Handlers>,
    fallback: (error: RemainingMatchTagErrors<ErrorValue, Handlers>) => FallbackOutput,
  ): (
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Output | MatchTagHandlerResult<Handlers> | FallbackOutput, never>
  public static matchTagsPartial(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 4,
      (
        self: ResultAsync<unknown, unknown>,
        onOk: (value: unknown) => unknown,
        handlers: never,
        fallback: (error: unknown) => unknown,
      ) => self.matchTagsPartial(onOk, handlers, fallback),
    )(...args)
  }
  /* eslint-enable max-params */

  /** Replaces success with a constant directly or as a reusable operator for `pipe`. */
  public static as<Input, ErrorValue, Output>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    value: Output,
  ): ResultAsync<Output, ErrorValue>
  public static as<Output>(
    this: void,
    value: Output,
  ): <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Output, ErrorValue>
  public static as(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 2,
      (self: ResultAsync<unknown, unknown>, value: unknown) => self.as(value),
    )(...args)
  }

  /** Replaces success with `undefined` (`void`) directly or as a reusable operator for `pipe`. */
  public static asVoid<
    Args extends readonly [self: ResultAsync<unknown, unknown>] | readonly [] = readonly [],
  >(
    this: void,
    ...args: Args
  ): Args extends readonly [ResultAsync<unknown, infer ErrorValue>]
    ? ResultAsync<void, ErrorValue>
    : <Input, ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<void, ErrorValue> {
    if (args.length === 0) {
      return ((self: ResultAsync<unknown, unknown>) => self.asVoid()) as never
    }
    return args[0].asVoid() as never
  }

  /** Validates or narrows success directly or as a reusable operator for `pipe`. */
  public static filterOrElse<Input, Narrowed extends Input, ErrorValue, Failure>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    predicate: (value: Input) => value is Narrowed,
    onFalse: (value: Input) => Failure,
  ): ResultAsync<Narrowed, ErrorValue | Failure>
  public static filterOrElse<Input, ErrorValue, Failure>(
    this: void,
    self: ResultAsync<Input, ErrorValue>,
    predicate: (value: Input) => boolean,
    onFalse: (value: Input) => Failure,
  ): ResultAsync<Input, ErrorValue | Failure>
  public static filterOrElse<Input, Narrowed extends Input, Failure>(
    this: void,
    predicate: (value: Input) => value is Narrowed,
    onFalse: (value: Input) => Failure,
  ): <ErrorValue>(
    self: ResultAsync<Input, ErrorValue>,
  ) => ResultAsync<Narrowed, ErrorValue | Failure>
  public static filterOrElse<Input, Failure>(
    this: void,
    predicate: (value: Input) => boolean,
    onFalse: (value: Input) => Failure,
  ): <ErrorValue>(self: ResultAsync<Input, ErrorValue>) => ResultAsync<Input, ErrorValue | Failure>
  public static filterOrElse(this: void, ...args: readonly unknown[]): unknown {
    return dual(
      (input) => input.length === 3,
      (
        self: ResultAsync<unknown, unknown>,
        predicate: (value: unknown) => boolean,
        onFalse: (value: unknown) => unknown,
      ) => self.filterOrElse(predicate, onFalse),
    )(...args)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  public static ok<T, E = never>(this: void, value: T): ResultAsync<T, E>
  public static ok<E = never>(this: void, value: void): ResultAsync<void, E>
  public static ok<T, E = never>(this: void, value: T): ResultAsync<T, E> {
    return ResultAsync.okAsync<T, E>(value)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.ok(value).
   *
   * @param {T} value - The value to be wrapped in a Result.ok.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given value and error type E.
   */
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E>
  public static okAsync<E = never>(this: void, value: void): ResultAsync<void, E>
  public static okAsync<T, E = never>(this: void, value: T): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(ok<T, E>(value)))
  }

  /**
   * Returns a ResultAsync that is immediately resolved with a Result.ok(undefined) value.
   *
   * @return {ResultAsync<undefined, E>} A ResultAsync instance with undefined as the value type and E as the error type.
   */
  public static unitAsync<E = never>(this: void): ResultAsync<undefined, E> {
    return new ResultAsync<undefined, E>(Promise.resolve(Result.unit()))
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(error).
   *
   * @param {E} error - The error to be wrapped in a Result.err.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given error and value type T.
   */
  public static err<T = never, E = unknown>(this: void, err: E): ResultAsync<T, E>
  public static err<T = never>(this: void, err: void): ResultAsync<T, void>
  public static err<T = never, E = unknown>(this: void, error: E): ResultAsync<T, E> {
    return ResultAsync.errAsync<T, E>(error)
  }

  /**
   * Returns a ResultAsync instance that is immediately resolved with a Result.err(error).
   *
   * @param {E} error - The error to be wrapped in a Result.err.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given error and value type T.
   */
  public static errAsync<T = never, E = unknown>(this: void, err: E): ResultAsync<T, E>
  public static errAsync<T = never>(this: void, err: void): ResultAsync<T, void>
  public static errAsync<T = never, E = unknown>(this: void, error: E): ResultAsync<T, E> {
    return new ResultAsync<T, E>(Promise.resolve(err<T, E>(error)))
  }

  /**
   * Creates a ResultAsync from a Promise, catching any errors that occur during its execution.
   *
   * Compatibility alias. Prefer the top-level `tryResultAsync` helper in new code.
   *
   * @param fn - The Promise or a function returning a Promise to be wrapped in a ResultAsync.
   * @param errorFn - Optional function to transform the caught error into a specific error type.
   *                  If not provided, the original error will be used.
   * @returns A ResultAsync that will resolve to Ok with the promise's value if successful,
   *          or Err with either the transformed error (if errorFn is provided) or the original error.
   *
   * New code should use the top-level `tryResultAsync` helper instead.
   */
  public static tryCatch<T>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
  ): ResultAsync<T, unknown>
  public static tryCatch<T, E>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E>
  public static tryCatch<T, E>(
    this: void,
    fn: Promise<T> | (() => Promise<T>),
    errorFn?: (e: unknown) => E,
  ): ResultAsync<T, unknown> {
    const promiseToProcess = typeof fn === 'function' ? Promise.try(fn) : fn
    const newPromise = promiseToProcess
      .then((value: T) => ok<T, unknown>(value))
      .catch((error: unknown) => {
        if (errorFn) {
          return err<T, unknown>(errorFn(error))
        }
        return err<T, unknown>(error)
      })
    return new ResultAsync<T, unknown>(newPromise)
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  public static fromSafePromise<T, E = never>(
    this: void,
    promise: PromiseLike<T>,
  ): ResultAsync<T, E>
  public static fromSafePromise<T, E = never>(this: void, promise: Promise<T>): ResultAsync<T, E> {
    const newPromise = promise.then((value: T) => ok<T, E>(value))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Eagerly executes a ResultTask using the standard runtime and wraps it in a ResultAsync.
   * @deprecated Use ResultTask.toResultAsync. Both execute the task eagerly.
   */
  public static fromTask<T, E>(this: void, task: ResultTask<T, E, never>): ResultAsync<T, E> {
    return ResultTask.toResultAsync(task)
  }

  /**
   * Returns a ResultAsync instance that is resolved with a Result.ok(value) or Result.err(error)
   * based on the provided promise.
   *
   * @param {Promise<T>} promise - The promise to be wrapped in a ResultAsync.
   * @param {(e: unknown) => E} errorFn - A function that transforms the error from the promise into the error type E.
   * @return {ResultAsync<T, E>} A ResultAsync instance with the given promise and error type E.
   */
  public static fromPromise<T, E>(
    this: void,
    promise: PromiseLike<T>,
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E>
  public static fromPromise<T, E>(
    this: void,
    promise: Promise<T>,
    errorFn: (e: unknown) => E,
  ): ResultAsync<T, E> {
    const newPromise = promise
      .then((value: T) => ok<T, E>(value))
      .catch((error: unknown) => err<T, E>(errorFn(error)))

    return new ResultAsync<T, E>(newPromise)
  }

  /**
   * Adapts a callback or subscription API into a cancellable ResultAsync.
   *
   * The returned cleanup function runs once after resolve, reject, cancellation, or synchronous
   * subscription failure. Cleanup errors are ignored.
   */
  public static fromCallback<T, E>(
    this: void,
    options: ResultAsyncFromCallbackOptions<T, E>,
  ): ResultAsync<T, E | AbortError> {
    return fromResultAsyncCallback(options)
  }

  /**
   * Combines many ResultAsync values and stops at the first Err.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   */
  public static combine<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  public static combine<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  public static combine<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecord<T>
  public static combine<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterable<R>
  public static combine<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecord<ResultAsyncRecord>
    | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultAsyncList(input) as CombineResultAsyncs<
        T & readonly ResultAsync<unknown, unknown>[]
      >
    }

    if (isIterable(input)) {
      return combineResultAsyncList([...input] as readonly ResultAsync<unknown, unknown>[]) as
        | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
        | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>>
    }

    return combineResultAsyncRecord(input)
  }

  /**
   * Combines many ResultAsync values and stops at the first Err, matching `ResultTask.all` and `Promise.all`.
   *
   * Arrays return an Ok array, records return an Ok record with the same keys, and iterables return
   * an Ok readonly array.
   */
  public static all<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultAsyncs<T>
  public static all<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultAsyncs<T>
  public static all<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecord<T>
  public static all<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterable<R>
  public static all<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecord<ResultAsyncRecord>
    | CombineResultAsyncsIterable<ResultAsync<unknown, unknown>> {
    return ResultAsync.combine(
      input as readonly ResultAsync<unknown, unknown>[],
    ) as CombineResultAsyncs<T & readonly ResultAsync<unknown, unknown>[]>
  }

  /**
   * Combines many ResultAsync values and collects every Err instead of stopping at the first one.
   */
  public static combineWithAllErrors<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  public static combineWithAllErrors<T extends ResultAsyncRecord>(
    this: void,
    asyncResultRecord: T,
  ): CombineResultAsyncsRecordWithAllErrors<T>
  public static combineWithAllErrors<R extends ResultAsync<unknown, unknown>>(
    this: void,
    asyncResults: Iterable<R>,
  ): CombineResultAsyncsIterableWithAllErrors<R>
  public static combineWithAllErrors<
    T extends
      | readonly ResultAsync<unknown, unknown>[]
      | ResultAsyncRecord
      | Iterable<ResultAsync<unknown, unknown>>,
  >(
    this: void,
    input: T,
  ):
    | CombineResultsWithAllErrorsArrayAsync<T & readonly ResultAsync<unknown, unknown>[]>
    | CombineResultAsyncsRecordWithAllErrors<ResultAsyncRecord>
    | CombineResultAsyncsIterableWithAllErrors<ResultAsync<unknown, unknown>> {
    // Stryker disable next-line all: array fast path avoids cloning arrays through the iterable branch.
    if (Array.isArray(input)) {
      return combineResultAsyncListWithAllErrors(input) as CombineResultsWithAllErrorsArrayAsync<
        T & readonly ResultAsync<unknown, unknown>[]
      >
    }

    if (isIterable(input)) {
      return combineResultAsyncListWithAllErrors([...input] as readonly ResultAsync<
        unknown,
        unknown
      >[]) as
        | CombineResultsWithAllErrorsArrayAsync<T & readonly ResultAsync<unknown, unknown>[]>
        | CombineResultAsyncsIterableWithAllErrors<ResultAsync<unknown, unknown>>
    }

    return combineResultAsyncRecordWithAllErrors(input)
  }

  /**
   * Validates many ResultAsync values and collects every Err.
   *
   * When passed items plus a mapper, the mapper must return a ResultAsync for each item. Use the
   * optional concurrency setting to bound parallel work.
   */
  public static validateAll<
    T extends readonly [ResultAsync<unknown, unknown>, ...ResultAsync<unknown, unknown>[]],
  >(this: void, asyncResultList: T): CombineResultsWithAllErrorsArrayAsync<T>
  public static validateAll<T extends readonly ResultAsync<unknown, unknown>[]>(
    this: void,
    asyncResultList: T,
  ): CombineResultsWithAllErrorsArrayAsync<T>
  public static validateAll<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncValidateAllOptions,
  ): ResultAsyncValidatedAll<R>
  public static validateAll<
    T extends readonly ResultAsync<unknown, unknown>[],
    Item,
    R extends ResultAsync<unknown, unknown>,
  >(
    this: void,
    asyncResultListOrItems: T | Iterable<Item>,
    f?: (value: Item, index: number) => R,
    options?: ResultAsyncValidateAllOptions,
  ): CombineResultsWithAllErrorsArrayAsync<T> | ResultAsyncValidatedAll<R> {
    if (f === undefined) {
      return combineResultAsyncListWithAllErrors(
        asyncResultListOrItems as T,
      ) as CombineResultsWithAllErrorsArrayAsync<T>
    }

    return validateAllResultAsyncItems(asyncResultListOrItems as Iterable<Item>, f, options)
  }

  /**
   * Combines exactly two ResultAsync values into an Ok tuple or the first Err.
   */
  public static zip<
    Left extends ResultAsync<unknown, unknown>,
    Right extends ResultAsync<unknown, unknown>,
  >(this: void, left: Left, right: Right): ResultAsyncZipped<Left, Right> {
    return combineResultAsyncList([left, right]) as ResultAsyncZipped<Left, Right>
  }

  /**
   * Retries a ResultAsync task according to a typed retry policy.
   *
   * The returned error channel includes the task error and `AbortError`.
   */
  public static retry<Task extends ResultAsyncRetryCandidate>(
    this: void,
    task: Task,
    policy: RetryPolicy<NoInfer<ResultAsyncRetryTaskErr<Task>>> & {
      readonly signal?: ResultAsyncAbortSignal
    },
  ): ResultAsync<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task> | AbortError>
  public static retry<Task extends ResultAsyncRetryTask<unknown, unknown>>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOptions<ResultAsyncRetryTaskErr<Task>>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task>, ResultAsyncRetryTaskErr<Task> | AbortError>
  public static retry<T, E>(
    this: void,
    task: ResultAsyncRetryTask<T, E>,
    options: ResultAsyncRetryInput<E>,
  ): ResultAsync<T, E | AbortError> {
    return retryResultAsyncTask(task, options)
  }

  /**
   * Retries a ResultAsync task and falls back to another Resultar operation after retry exhaustion.
   */
  public static retryOrElse<Task extends ResultAsyncRetryCandidate, U, F>(
    this: void,
    task: Task,
    policy: RetryPolicy<NoInfer<ResultAsyncRetryTaskErr<Task>>> & {
      readonly signal?: ResultAsyncAbortSignal
      readonly orElse: (
        error: NoInfer<ResultAsyncRetryTaskErr<Task>>,
        context: ResultAsyncRetryContext,
      ) => Result<U, F> | ResultAsync<U, F>
    },
  ): ResultAsync<ResultAsyncRetryTaskOk<Task> | U, F | AbortError>
  public static retryOrElse<Task extends ResultAsyncRetryTask<unknown, unknown>, U, F>(
    this: void,
    task: Task,
    options: ResultAsyncRetryOrElseOptions<ResultAsyncRetryTaskErr<Task>, F, U>,
  ): ResultAsync<ResultAsyncRetryTaskOk<Task> | U, F | AbortError>
  public static retryOrElse<T, E, U, F>(
    this: void,
    task: ResultAsyncRetryTask<T, E>,
    options: ResultAsyncRetryOrElseInput<E, F, U>,
  ): ResultAsync<T | U, F | AbortError> {
    return retryOrElseResultAsyncTask(task, options)
  }

  /**
   * Acquires, uses, and releases a resource with cleanup on every path.
   *
   * Release errors are intentionally not part of the success/error channel; model cleanup failures
   * in `use` when they should affect control flow.
   */
  public static withResource<Resource, AcquireError, T, UseError>(
    this: void,
    options: ResultAsyncWithResourceOptions<Resource, AcquireError, T, UseError>,
  ): ResultAsync<T, AcquireError | UseError | AbortError> {
    return withResultAsyncResource(options)
  }

  /**
   * Races two cooperative ResultAsync tasks and returns the first successful Ok.
   *
   * Earlier Err results do not finish the race. If both tasks fail, returns the last completed Err.
   * Pending losers are aborted without waiting for their settlement or cleanup.
   */
  public static race<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
  >(
    this: void,
    left: Left,
    right: Right,
  ): ResultAsync<
    ResultAsyncRaceTaskOk<Left> | ResultAsyncRaceTaskOk<Right>,
    ResultAsyncRaceTaskErr<Left> | ResultAsyncRaceTaskErr<Right>
  > {
    return raceResultAsyncTasks([left, right] as const)
  }

  /**
   * Races multiple cooperative ResultAsync tasks and returns the first successful Ok.
   *
   * Earlier Err results do not finish the race. If every task fails, returns the last completed Err.
   * Pending losers are aborted without waiting for their settlement or cleanup.
   */
  public static raceAll<
    Tasks extends readonly [
      ResultAsyncRaceTask<unknown, unknown>,
      ...ResultAsyncRaceTask<unknown, unknown>[],
    ],
  >(
    this: void,
    tasks: Tasks,
  ): ResultAsync<ResultAsyncRaceTasksOk<Tasks>, ResultAsyncRaceTasksErr<Tasks>> {
    return raceResultAsyncTasks(tasks)
  }

  /**
   * Races two cooperative ResultAsync tasks and returns the first settled Result, whether Ok or Err.
   *
   * Remaining tasks are aborted without waiting for their settlement or cleanup.
   */
  public static raceFirst<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
  >(
    this: void,
    left: Left,
    right: Right,
  ): ResultAsync<
    ResultAsyncRaceTaskOk<Left> | ResultAsyncRaceTaskOk<Right>,
    ResultAsyncRaceTaskErr<Left> | ResultAsyncRaceTaskErr<Right>
  > {
    return observeRaceResultAsyncTasks<
      readonly [Left, Right],
      RaceFirstObserverContext<readonly [Left, Right]>
    >(
      [left, right] as const,
      // Stryker disable next-line all: explicit false and missing value are equivalent before first settlement.
      (resolve, startedTasks) => ({ resolve, startedTasks, state: { settled: false } }),
      observeRaceFirstTask,
    )
  }

  /**
   * Races two cooperative ResultAsync tasks and lets handlers decide what to do when either side
   * settles first.
   *
   * Handlers receive the settled Result and a handle to the still-running opposite task.
   */
  public static raceWith<
    Left extends ResultAsyncRaceTask<unknown, unknown>,
    Right extends ResultAsyncRaceTask<unknown, unknown>,
    OnLeftDone extends ResultAsyncConditional,
    OnRightDone extends ResultAsyncConditional,
  >(
    this: void,
    left: Left,
    right: Right,
    handlers: {
      readonly onLeftDone: (
        result: Result<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
        right: ResultAsyncRaceHandle<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
      ) => OnLeftDone
      readonly onRightDone: (
        result: Result<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
        left: ResultAsyncRaceHandle<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
      ) => OnRightDone
    },
  ): ResultAsync<
    HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
    HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
  > {
    const promise = new Promise<
      Result<
        HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
        HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
      >
    >((resolve) => {
      const leftTask = startRaceTask(left, 0)
      const rightTask = startRaceTask(right, 1)
      const leftHandle = createRaceHandle(leftTask) as ResultAsyncRaceHandle<
        ResultAsyncRaceTaskOk<Left>,
        ResultAsyncRaceTaskErr<Left>
      >
      const rightHandle = createRaceHandle(rightTask) as ResultAsyncRaceHandle<
        ResultAsyncRaceTaskOk<Right>,
        ResultAsyncRaceTaskErr<Right>
      >
      let settled = false

      void leftTask.settled.then(({ result }) => {
        if (settled) {
          return
        }

        settled = true
        const handled = handlers.onLeftDone(
          result as Result<ResultAsyncRaceTaskOk<Left>, ResultAsyncRaceTaskErr<Left>>,
          rightHandle,
        )

        void Promise.resolve(toResultAsync(handled)).then((handledResult) => {
          resolve(
            handledResult as Result<
              HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
              HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
            >,
          )
        })
      })

      void rightTask.settled.then(({ result }) => {
        if (settled) {
          return
        }

        settled = true
        const handled = handlers.onRightDone(
          result as Result<ResultAsyncRaceTaskOk<Right>, ResultAsyncRaceTaskErr<Right>>,
          leftHandle,
        )

        void Promise.resolve(toResultAsync(handled)).then((handledResult) => {
          resolve(
            handledResult as Result<
              HandlerOk<OnLeftDone> | HandlerOk<OnRightDone>,
              HandlerErr<OnLeftDone> | HandlerErr<OnRightDone>
            >,
          )
        })
      })
    })

    return new ResultAsync(promise)
  }

  /**
   * Runs a cooperative ResultAsync task with a typed timeout error.
   */
  public static timeout<Task extends ResultAsyncRaceTask<unknown, unknown>, TimeoutError>(
    this: void,
    task: Task,
    options: ResultAsyncTimeoutOptions<TimeoutError>,
  ): ResultAsync<ResultAsyncRaceTaskOk<Task>, ResultAsyncRaceTaskErr<Task> | TimeoutError> {
    const timeoutTask = (signal: ResultAsyncAbortSignal): ResultAsync<never, TimeoutError> => {
      const promise = new Promise<Result<never, TimeoutError>>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(Result.err(options.onTimeout()))
        }, options.timeoutMs)

        signal.addEventListener('abort', () => {
          clearTimeout(timeout)
        })
      })

      return new ResultAsync(promise)
    }

    return ResultAsync.raceWith(task, timeoutTask, {
      onLeftDone: (result, timeoutHandle) => {
        timeoutHandle.abort(createRaceAbortReason())
        return result
      },
      onRightDone: (result, taskHandle) => {
        taskHandle.abort((result as { readonly error: TimeoutError }).error)
        return result
      },
    })
  }

  /**
   * Runs async candidates until the first Ok and returns the last Err if every candidate fails.
   */
  public static firstSuccessOf<Candidates extends Iterable<ResultAsyncCandidate>>(
    this: void,
    candidates: Candidates,
  ): FirstSuccessOfAsync<Candidates> {
    return firstSuccessOfAsyncCandidates(candidates)
  }

  /**
   * Chooses one of two Resultar async branches from a boolean or Resultar boolean condition.
   */
  public static if<OnTrue extends ResultAsyncConditional, OnFalse extends ResultAsyncConditional>(
    this: void,
    condition: ResultAsyncBooleanCondition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<never, OnTrue, OnFalse>
  public static if<
    Condition extends ResultAsyncConditionResult,
    OnTrue extends ResultAsyncConditional,
    OnFalse extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse>
  public static if<
    Condition extends ResultAsyncConditionResult,
    OnTrue extends ResultAsyncConditional,
    OnFalse extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition | ResultAsyncBooleanCondition,
    options: ResultAsyncIfOptions<OnTrue, OnFalse>,
  ): ResultAsyncIf<HandlerErr<Condition>, OnTrue, OnFalse> | ResultAsyncIf<never, OnTrue, OnFalse> {
    if (typeof condition === 'boolean' || typeof condition === 'function') {
      return ifResultAsync(condition, options)
    }

    return ifResultAsyncWithCondition(condition, options)
  }

  /**
   * Runs `body` only when the condition resolves to `true`; otherwise returns `Ok(undefined)`.
   */
  public static when<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static when<Condition extends ResultAsyncCondition>(
    this: void,
    condition: Condition,
  ): <R extends ResultAsyncConditional>(
    body: R | (() => R),
  ) => ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static when<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
    | (<Body extends ResultAsyncConditional>(
        target: Body | (() => Body),
      ) => ResultAsyncWhen<Body, ResultAsyncConditionError<Condition>>) {
    if (body === undefined) {
      return <Body extends ResultAsyncConditional>(target: Body | (() => Body)) =>
        whenResultAsyncByPredicate(condition, target, (value) => value)
    }

    return whenResultAsyncByPredicate(condition, body, (value) => value)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(true).
   */
  public static whenResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncByPredicate(condition, body, (value) => value)
  }

  /**
   * Runs `body` only when the condition resolves to `false`; otherwise returns `Ok(undefined)`.
   */
  public static unless<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static unless<Condition extends ResultAsyncCondition>(
    this: void,
    condition: Condition,
  ): <R extends ResultAsyncConditional>(
    body: R | (() => R),
  ) => ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
  public static unless<Condition extends ResultAsyncCondition, R extends ResultAsyncConditional>(
    this: void,
    condition: Condition,
    body?: R | (() => R),
  ):
    | ResultAsyncWhen<R, ResultAsyncConditionError<Condition>>
    | (<Body extends ResultAsyncConditional>(
        target: Body | (() => Body),
      ) => ResultAsyncWhen<Body, ResultAsyncConditionError<Condition>>) {
    if (body === undefined) {
      return <Body extends ResultAsyncConditional>(target: Body | (() => Body)) =>
        whenResultAsyncByPredicate(condition, target, (value) => !value)
    }

    return whenResultAsyncByPredicate(condition, body, (value) => !value)
  }

  /**
   * Runs `body` only when a Resultar boolean condition is Ok(false).
   */
  public static unlessResult<
    Condition extends ResultAsyncConditionResult,
    R extends ResultAsyncConditional,
  >(
    this: void,
    condition: Condition,
    body: R | (() => R),
  ): ResultAsyncWhenWithCondition<Condition, R> {
    return whenResultAsyncByPredicate(condition, body, (value) => !value)
  }

  /**
   * Repeats a ResultAsync-producing body while a condition holds.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed.
   */
  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopOptions<State, BodyState, R>,
  ): ResultAsyncLoopCollected<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopBooleanOptions<State, R>,
  ): ResultAsyncLoopCollected<R>
  public static loop<State, BodyState extends State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopDiscardOptions<State, BodyState, R>,
  ): ResultAsyncLoopDiscarded<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncLoopBooleanDiscardOptions<State, R>,
  ): ResultAsyncLoopDiscarded<R>
  public static loop<State, R extends ResultAsync<unknown, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultAsyncLoopBooleanOptions<State, R>
      | ResultAsyncLoopBooleanDiscardOptions<State, R>
      | ResultAsyncLoopOptions<State, State, R>
      | ResultAsyncLoopDiscardOptions<State, State, R>,
  ): ResultAsyncLoopCollected<R> | ResultAsyncLoopDiscarded<R> {
    return loopResultAsync(initial, options as ResultAsyncLoopRuntimeOptions<State, R>)
  }

  /**
   * Repeatedly transforms state with a ResultAsync-producing body until the condition fails.
   */
  public static iterate<
    State,
    BodyState extends WidenLiteral<State>,
    R extends ResultAsync<WidenLiteral<State>, unknown>,
  >(
    this: void,
    initial: State,
    options: ResultAsyncIterateOptions<WidenLiteral<State>, BodyState, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends ResultAsync<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options: ResultAsyncIterateBooleanOptions<WidenLiteral<State>, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R>
  public static iterate<State, R extends ResultAsync<WidenLiteral<State>, unknown>>(
    this: void,
    initial: State,
    options:
      | ResultAsyncIterateBooleanOptions<WidenLiteral<State>, R>
      | ResultAsyncIterateOptions<WidenLiteral<State>, WidenLiteral<State>, R>,
  ): ResultAsyncIterated<WidenLiteral<State>, R> {
    return iterateResultAsync(
      initial as WidenLiteral<State>,
      options as ResultAsyncIterateRuntimeOptions<WidenLiteral<State>, R>,
    )
  }

  /**
   * Runs a ResultAsync-producing mapper for each item.
   *
   * Use `discard: true` when only failure matters and collected Ok values are not needed. Use
   * `concurrency` to bound parallel work.
   */
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncForEachOptions,
  ): ResultAsyncForEachCollected<R>
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options: ResultAsyncForEachDiscardOptions,
  ): ResultAsyncForEachDiscarded<R>
  public static forEach<Item, R extends ResultAsync<unknown, unknown>>(
    this: void,
    items: Iterable<Item>,
    f: (value: Item, index: number) => R,
    options?: ResultAsyncForEachOptions | ResultAsyncForEachDiscardOptions,
  ): ResultAsyncForEachCollected<R> | ResultAsyncForEachDiscarded<R> {
    return forEachResultAsync(items, f, options)
  }

  /**
   * Wraps an async function so every later call returns a ResultAsync.
   *
   * Prefer `tryResultAsync` when you want to run the operation immediately.
   */
  public static fromThrowable<A extends readonly unknown[], T, E>(
    this: void,
    fn: (...args: A) => Promise<T>,
    errorFn?: (err: unknown) => E,
  ): (...args: A) => ResultAsync<T, E> {
    return (...args) =>
      new ResultAsync<T, E>(
        (async () => {
          try {
            const v = await fn(...args)
            return ok<T, E>(v)
          } catch (error) {
            const e = errorFn ? errorFn(error) : error
            return err<T, E>(e as E)
          }
        })(),
      )
  }
}

type ResultAsyncConstructor = (new <T, E = never>(
  res: Promise<Result<T, E>>,
) => ResultAsync<T, E>) &
  Omit<typeof ResultAsyncStatic, 'prototype'> &
  Omit<typeof ResultTask, 'prototype' | keyof typeof ResultAsyncStatic>

function ResultAsyncFactory<T, E = never>(
  this: unknown,
  res: Promise<Result<T, E>>,
): ResultAsync<T, E> {
  return new ResultTask(res)
}

Object.setPrototypeOf(ResultAsyncFactory, ResultTask)
ResultAsyncFactory.prototype = ResultTask.prototype

for (const [key, descriptor] of Object.entries(
  Object.getOwnPropertyDescriptors(ResultAsyncStatic),
)) {
  if (key !== 'length' && key !== 'name' && key !== 'prototype') {
    Object.defineProperty(ResultAsyncFactory, key, descriptor)
  }
}

export const ResultAsync: ResultAsyncConstructor =
  ResultAsyncFactory as unknown as ResultAsyncConstructor

/** `ResultAsync` convention that restricts the error channel to real `Error` instances. */
export type StrictResultAsync<T, E extends Error = Error> = ResultAsync<T, E>

/**
 * Creates an Ok ResultAsync.
 */
export const okAsync: typeof ResultAsync.okAsync = ResultAsync.okAsync
/**
 * Creates an Err ResultAsync.
 */
export const errAsync: typeof ResultAsync.errAsync = ResultAsync.errAsync
/**
 * Adapts a callback or subscription API into a cancellable ResultAsync.
 */
export const fromCallback: typeof ResultAsync.fromCallback = ResultAsync.fromCallback
/**
 * Converts an existing promise into a ResultAsync and maps rejection into a typed Err.
 */
export const fromPromise: typeof ResultAsync.fromPromise = ResultAsync.fromPromise
/**
 * Converts an existing promise that is expected not to reject into a ResultAsync.
 *
 * Use `fromPromise` or `tryResultAsync` when rejection should become a typed Err.
 */
export const fromSafePromise: typeof ResultAsync.fromSafePromise = ResultAsync.fromSafePromise
/**
 * Creates an Ok ResultAsync with `undefined`.
 */
export const unitAsync: typeof ResultAsync.unitAsync = ResultAsync.unitAsync
/**
 * Wraps an async function so every later call returns a ResultAsync.
 */
export const fromThrowableAsync: typeof ResultAsync.fromThrowable = ResultAsync.fromThrowable

/**
 * Captures a promise or async factory into `ResultAsync<T, E>`.
 *
 * Use `tryResultAsync` at the edge of uncontrolled async code: network calls, file I/O,
 * third-party SDKs, JSON parsing promises, and framework APIs that can reject. The mapper receives
 * the rejected or thrown `unknown` cause and returns the typed error for the Resultar channel.
 *
 * Passing a factory is preferred when creating the promise can throw synchronously.
 *
 * @example
 * ```ts
 * const user = tryResultAsync(
 *   () => fetchUser(id),
 *   (cause) => new FetchUserError({ cause, id }),
 * )
 * ```
 */
export function tryResultAsync<T, E>(
  fn: Promise<T> | (() => Promise<T>),
  errorFn: (e: unknown) => E,
): ResultAsync<T, E>
/**
 * Captures an async boundary with named `try` and `catch` fields.
 *
 * This is equivalent to `tryResultAsync(() => ..., toError)`, but it reads better for reusable
 * infrastructure helpers where the label, task, and mapper live together.
 *
 * @example
 * ```ts
 * const startup = tryResultAsync({
 *   try: () => fastify.register(plugin),
 *   catch: (cause) => new StartupTaskError({ cause, label: "register plugin" }),
 * })
 * ```
 */
export function tryResultAsync<T, E>(
  options: TryResultAsyncOptions<T, E> & { readonly catch: (e: unknown) => E },
): ResultAsync<T, E>
/**
 * Captures a promise or async factory into `ResultAsync<T, unknown>`.
 *
 * Prefer the overload with a catch mapper in application code so the error channel stays documented.
 * This overload is useful while adapting unknown external failures or during migration.
 */
export function tryResultAsync<T>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T>,
): ResultAsync<T, unknown>
export function tryResultAsync<T, E = unknown>(
  input: Promise<T> | (() => Promise<T>) | TryResultAsyncOptions<T, E>,
  errorFn?: (e: unknown) => E,
): ResultAsync<T, E> {
  const promiseOrFn = isTryResultAsyncOptions(input) ? input.try : input
  const catchFn = isTryResultAsyncOptions(input) ? input.catch : errorFn
  const promiseToProcess =
    typeof promiseOrFn === 'function' ? Promise.try(promiseOrFn) : promiseOrFn
  const newPromise = promiseToProcess
    .then((value: T) => Result.ok<T, E>(value))
    .catch((error: unknown) => {
      if (catchFn) {
        return Result.err<T, E>(catchFn(error))
      }

      return Result.err<T, E>(error as E)
    })

  return new ResultAsync<T, E>(newPromise)
}

/**
 * Runs a `ResultAsync` at an application boundary and returns the success value.
 *
 * If the result is `Err`, this rejects with the error. Use it at final framework, CLI, test, or
 * bootstrap boundaries after the error channel has already been modeled with Resultar.
 */
export const runPromise = <T, E>(result: ResultAsync<T, E>): Promise<T> => result.unwrapOrThrow()

/** @deprecated Use tryResultAsync; this alias retains its existing behavior. */
export const tryCatchAsync: typeof tryResultAsync = tryResultAsync

// Combines the array of async results into one result.
export type CombineResultAsyncs<T extends readonly ResultAsync<unknown, unknown>[]> =
  IsLiteralArray<T> extends 1
    ? TraverseAsync<UnwrapAsync<T>>
    : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number]>

// Combines the array of async results into one result with all errors.
export type CombineResultsWithAllErrorsArrayAsync<
  T extends readonly ResultAsync<unknown, unknown>[],
> =
  IsLiteralArray<T> extends 1
    ? TraverseWithAllErrorsAsync<UnwrapAsync<T>>
    : ResultAsync<ExtractOkAsyncTypes<T>, ExtractErrAsyncTypes<T>[number][]>

// Unwraps the inner `Result` from a `ResultAsync` for all elements.
type UnwrapAsync<T> =
  IsLiteralArray<T> extends 1
    ? Writable<T> extends [infer H, ...infer Rest]
      ? H extends ResultAsync<infer L, infer R>
        ? [Dedup<Result<L, R>>, ...UnwrapAsync<Rest>]
        : never
      : []
    : // If we got something too general such as ResultAsync<X, Y>[] then we
      // simply need to map it to ResultAsync<X[], Y[]>. Yet `ResultAsync`
      // itself is a union therefore it would be enough to cast it to Ok.
      T extends (infer A)[]
      ? A extends ResultAsync<infer L, infer R>
        ? Result<L, R>[]
        : never
      : never

// Traverse through the tuples of the async results and create one
// `ResultAsync` where the collected tuples are merged.
type TraverseAsync<T, Depth extends number = 5> =
  IsLiteralArray<T> extends 1
    ? Combine<T, Depth> extends [infer Oks, infer Errs]
      ? ResultAsync<EmptyArrayToNever<Oks>, MembersToUnion<Errs>>
      : never
    : // The following check is important if we somehow reach to the point of
      // checking something similar to ResultAsync<X, Y>[]. In this case we don't
      // know the length of the elements, therefore we need to traverse the X and Y
      // in a way that the result should contain X[] and Y[].
      T extends (infer I)[]
      ? // The MemberListOf<I> here is to include all possible types. Therefore
        // if we face (ResultAsync<X, Y> | ResultAsync<A, B>)[] this type should
        // handle the case.
        Combine<MemberListOf<I>, Depth> extends [infer Oks, infer Errs]
        ? // The following `extends unknown[]` checks are just to satisfy the TS.
          // we already expect them to be an array.
          Oks extends unknown[]
          ? Errs extends unknown[]
            ? ResultAsync<EmptyArrayToNever<Oks[number][]>, MembersToUnion<Errs[number][]>>
            : ResultAsync<EmptyArrayToNever<Oks[number][]>, Errs>
          : // The rest of the conditions are to satisfy the TS and support
            // the edge cases which are not really expected to happen.
            Errs extends unknown[]
            ? ResultAsync<Oks, MembersToUnion<Errs[number][]>>
            : ResultAsync<Oks, Errs>
        : never
      : never

// This type is similar to the `TraverseAsync` while the errors are also
// collected in a list. For the checks/conditions made here, see that type
// for the documentation.
type TraverseWithAllErrorsAsync<T, Depth extends number = 5> =
  TraverseAsync<T, Depth> extends ResultAsync<infer Oks, infer Errs>
    ? ResultAsync<Oks, Errs[]>
    : never

// Converts a reaodnly array into a writable array
type Writable<T> = T extends readonly unknown[] ? [...T] : T
