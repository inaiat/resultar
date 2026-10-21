import { success } from './exit.js'
import { NEVER_ABORTED_SIGNAL } from './promise-interruption.js'
import type { Exit, ResultTask } from './result-task.js'
import type { TaskScope } from './scope.js'
import { Clock } from './task-clock.js'
import type { TaskClock } from './task-clock.js'
import { isObjectLike } from './task-helpers.js'
import { createScheduling, forkScheduling } from './task-scheduler.js'
import type { TaskScheduling } from './task-scheduler.js'

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
export type ResolverError<Resolvers> = [ResolverTasks<Resolvers>] extends [never]
  ? never
  : ResolverTasks<Resolvers> extends ResultTask<unknown, infer E, unknown>
    ? E
    : never
export type ResolverRequirements<Resolvers> = [ResolverTasks<Resolvers>] extends [never]
  ? never
  : ResolverTasks<Resolvers> extends ResultTask<unknown, unknown, infer R>
    ? R
    : never

export type EliminateProvidedServices<R, Services> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Services
    ? Services[R['identifier']] extends ServiceForTag<R>
      ? never
      : R
    : R
  : R

export type EliminateResolvedServices<R, Resolvers> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Resolvers
    ? Resolvers[R['identifier']] extends () => ResultTask<infer S, unknown, unknown>
      ? S extends ServiceForTag<R>
        ? never
        : R
      : R
    : R
  : R

export type IncompatibleProvidedServices<R, Services> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Services
    ? Services[R['identifier']] extends ServiceForTag<R>
      ? never
      : R['identifier']
    : never
  : never

export type IncompatibleResolvedServices<R, Resolvers> = R extends AnyServiceTag
  ? R['identifier'] extends keyof Resolvers
    ? Resolvers[R['identifier']] extends () => ResultTask<infer S, unknown, unknown>
      ? S extends ServiceForTag<R>
        ? never
        : R['identifier']
      : R['identifier']
    : never
  : never

export type RuntimeServiceResolver = (
  tag: AnyServiceTag,
) => ResultTask<unknown, unknown, unknown> | undefined

/** The object-shaped service environment required by a task. */
export type ResultTaskServices<R> = {
  readonly [Tag in Extract<R, AnyServiceTag> as Tag['identifier']]: ServiceForTag<Tag>
}

export type AnyServiceTag = Pick<ServiceTag<string, unknown>, '_tag' | 'identifier' | 'key'>
export type ServiceForTag<Tag> = Tag extends ServiceTag<string, infer Service> ? Service : never
export type WithoutServices<R> = Exclude<R, AnyServiceTag>
export type ResultTaskRuntimeServices = ReadonlyMap<symbol, unknown>

export interface ResultTaskCleanupScheduling {
  schedulerFailure: Exit<unknown, unknown>
}

export interface ResultTaskRuntimeContext {
  readonly namedServices: ReadonlyMap<string, unknown>
  readonly services: ResultTaskRuntimeServices
  readonly serviceResolver: RuntimeServiceResolver | undefined
  readonly signal: AbortSignal
  readonly scope: TaskScope
  readonly clock: TaskClock
  readonly scheduling: TaskScheduling
  readonly cleanup: ResultTaskCleanupScheduling | undefined
}

/** Supplies runtime defaults when an internal executor receives a context without time policies. */
export const normalizeRuntimeContext = (
  context: ResultTaskRuntimeContext,
): ResultTaskRuntimeContext => {
  if (context.clock !== undefined && context.scheduling !== undefined) return context
  const clock = context.clock ?? Clock.live
  return {
    namedServices: context.namedServices,
    services: context.services,
    serviceResolver: context.serviceResolver,
    signal: context.signal,
    scope: context.scope,
    clock,
    scheduling: context.scheduling ?? createScheduling(clock),
    cleanup: context.cleanup,
  }
}

export type ResultTaskExecutor = (
  context: ResultTaskRuntimeContext,
) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
export type ResultTaskNestedExecutor = (
  task: ResultTask<unknown, unknown, unknown>,
) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>

export interface ResultTaskCloseRuntime {
  readonly context: ResultTaskRuntimeContext
  readonly executeTask: ResultTaskNestedExecutor
}

export type ResultTaskExecutionOutcome = Exit<unknown, unknown> | { readonly error: unknown }

export interface ResultTaskServiceYield<out Tag extends AnyServiceTag> {
  readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
  readonly _tag: 'Service'
  readonly tag: Tag
}

class ServiceTagIterator<
  Tag extends AnyServiceTag,
  Service,
> implements ResultTaskServiceYield<Tag> {
  declare public readonly [ResultTaskYieldTypeId]: typeof ResultTaskYieldTypeId
  declare public readonly _tag: 'Service'
  public readonly tag: Tag
  public value: unknown
  public done = false
  private yielded = false

  public constructor(tag: Tag) {
    this.tag = tag
    this.value = this
  }

  public next(value: Service): IteratorResult<ResultTaskServiceYield<Tag>, Service> {
    if (!this.yielded) {
      this.yielded = true
      return this as unknown as IteratorResult<ResultTaskServiceYield<Tag>, Service>
    }
    this.done = true
    this.value = value
    return this as unknown as IteratorResult<ResultTaskServiceYield<Tag>, Service>
  }
}

Object.assign(ServiceTagIterator.prototype, {
  [ResultTaskYieldTypeId]: ResultTaskYieldTypeId,
  _tag: 'Service',
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

/** Returns true if a value is a nominal `ServiceTag`. */
export const isServiceTag = (value: unknown): value is ServiceTag<string, unknown> =>
  value instanceof ServiceTagValue ||
  (isObjectLike(value) &&
    (value as Record<symbol, unknown>)[ServiceTagTypeId] === ServiceTagTypeId &&
    (value as { readonly _tag?: unknown })._tag === 'ServiceTag' &&
    typeof (value as { readonly identifier?: unknown }).identifier === 'string' &&
    typeof (value as { readonly key?: unknown }).key === 'symbol' &&
    typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function')

export const isServiceYield = (value: unknown): value is ResultTaskServiceYield<AnyServiceTag> =>
  // Stryker disable next-line ConditionalExpression,LogicalOperator: instanceof fast-path is equivalent to the structural brand check below.
  value instanceof ServiceTagIterator ||
  (isObjectLike(value) &&
    (value as Record<symbol, unknown>)[ResultTaskYieldTypeId] === ResultTaskYieldTypeId &&
    (value as { readonly _tag?: unknown })._tag === 'Service' &&
    isServiceTag((value as { readonly tag?: unknown }).tag))

export type ServiceLookup =
  | { readonly _tag: 'Found'; readonly value: unknown }
  | { readonly _tag: 'Missing' }

export const lookupService = (
  tag: AnyServiceTag,
  context: ResultTaskRuntimeContext,
): ServiceLookup => {
  if (context.services.has(tag.key)) {
    return { _tag: 'Found', value: context.services.get(tag.key) }
  }

  if (context.namedServices.has(tag.identifier)) {
    return { _tag: 'Found', value: context.namedServices.get(tag.identifier) }
  }

  // Stryker disable next-line all: any non-Found lookup converges to MissingServiceError downstream; the tag string is not publicly observable.
  return { _tag: 'Missing' }
}

export type ServiceResolution =
  | { readonly _tag: 'Found'; readonly value: unknown }
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Failure'; readonly exit: Exit<unknown, unknown> }
  | { readonly _tag: 'Error'; readonly error: unknown }

export const executeTaskSafely = async (
  task: ResultTask<unknown, unknown, unknown>,
  executeTask: ResultTaskNestedExecutor,
): Promise<ResultTaskExecutionOutcome> => {
  try {
    return await executeTask(task)
  } catch (error) {
    return { error }
  }
}

export const resolveService = async (
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

export const withServices = (
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

export const withScope = (
  context: ResultTaskRuntimeContext,
  scope: TaskScope,
  signal: AbortSignal = context.signal,
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

export const withChildScope = (
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

export const withCleanupScope = (
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

export const withNamedServices = (
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

export const withServiceResolver = (
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

export const EMPTY_NAMED_SERVICES: ReadonlyMap<string, unknown> = new Map()
export const EMPTY_SERVICES: ReadonlyMap<symbol, unknown> = new Map()
