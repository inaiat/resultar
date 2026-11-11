# Executable contract recipes

These examples are the published source of the bundled agent recipes. They use
only core Resultar and Node.js, without network access. `vp run test:docs` verifies
this page matches the source, compiles the published recipes, and tests their
observable behavior. Partial snippets elsewhere in the manuals require the
surrounding application types; this page is a complete module.

The recipes distinguish external Promise driver inputs (`lazyLoad` uses
`tryPromise`) from existing typed Async adapters (`bridgeExistingLoad` uses
`fromResultAsync`). Both return Tasks without `async`. `runDefectInspection`
is an explicit runner boundary returning a native Promise, not a repository method.
See [Promise boundaries](../DOCUMENTATION.md#promise-boundaries-and-application-contracts).

They also demonstrate numeric retry policies,
synchronous Result steps in Tasks, scope release and native disposal, semaphores,
callback cancellation/cleanup, tagged enums, matching, redaction, fallbacks,
first-success versus first-completion racing, and defect inspection via Exit.
See the [workflow example](../skills/resultar/examples/workflow.mts) for service
requirements supplied at the runner. Framework and schema integrations are
exercised by [example projects](../README.md#runnable-examples) and agent evaluation cases.

Source: [contracts.mts](../skills/resultar/examples/contracts.mts).

```ts
import { EventEmitter } from 'node:events'
import {
  Cause, Clock, createTaggedError, Match, ok, redact, Result, ResultAsync,
  ResultTask, Retry, taggedEnum,
} from 'resultar'

export class LoadError extends createTaggedError({
  name: 'LoadError', message: 'Load failed: $operation',
}).withProps<{ readonly operation: string; readonly retryable: boolean }>() {}

// External driver contract: Promise is an input boundary, not the application output.
// This function is not async: construction stays lazy and returns a typed Task.
export const lazyLoad = (
  load: (signal: AbortSignal) => Promise<number>,
): ResultTask<number, LoadError> =>
  ResultTask.tryPromise({
    try: load,
    catch: cause => new LoadError({ operation: 'load', retryable: true, cause }),
  })

// Use this bridge only when an existing adapter already returns a typed ResultAsync.
// Calling the supplied factory on each run preserves laziness and repeatability.
export const bridgeExistingLoad = (
  load: (signal: AbortSignal) => ResultAsync<number, LoadError>,
): ResultTask<number, LoadError> => ResultTask.fromResultAsync(load)

export const retryLoad = (
  load: (signal: AbortSignal) => Promise<number>,
): ResultTask<number, LoadError> =>
  lazyLoad(load).retry(Retry.policy<LoadError>({
    times: 2, delayMs: 10, backoff: 2, jittered: 0,
    while: error => error.retryable,
  }))

// Synchronous Results are valid generator steps; modern generators return values.
export const normalize = (value: number) => ResultTask.gen(function* () {
  const positive = yield* Result.liftPredicate(
    value, value => value > 0,
    () => new LoadError({ operation: 'validate', retryable: false }),
  )
  return positive * 2
})

// Native disposal is registered by acquireDisposable(acquireTask).
export const scopedRead = (events: string[], failRelease = false) => ResultTask.scoped(
  ResultTask.acquireRelease({
    acquire: ResultTask.sync(() => { events.push('acquire'); return 7 }),
    release: () => ResultTask.try({
      try: () => { events.push('release'); if (failRelease) throw new Error('close') },
      catch: cause => new LoadError({ operation: 'release', retryable: false, cause }),
    }),
  }).andThen(value => ResultTask.sync(() => { events.push('read'); return value })),
)

export const disposableRead = (events: string[]) => ResultTask.scoped(
  ResultTask.acquireDisposable(ResultTask.sync(() => ({
    value: 9,
    [Symbol.dispose]() { events.push('dispose') },
  }))).map(resource => resource.value),
)

export const limited = (values: number[]) => {
  const semaphore = ResultTask.makeSemaphore(2)
  return ResultTask.forEach(values, value => semaphore.withPermit(normalize(value)), {
    concurrency: 4,
  })
}

// Legacy callback bridge: options object, explicit cleanup, AbortError in E.
export const waitForReady = (emitter: EventEmitter, signal?: AbortSignal) =>
  ResultAsync.fromCallback<number, LoadError>({
    signal,
    catch: cause => new LoadError({ operation: 'ready', retryable: false, cause }),
    subscribe: ({ resolve, reject }) => {
      emitter.once('ready', resolve)
      emitter.once('error', reject)
      return () => { emitter.off('ready', resolve); emitter.off('error', reject) }
    },
  })

type StateMembers = { Idle: {}; Ready: { readonly value: number } }
export const State = taggedEnum<StateMembers>()
export const stateValue = (state: import('resultar').TaggedEnum<StateMembers>) =>
  State.$is('Ready', state) ? state.value : 0

export const status = (value: ReturnType<typeof normalize>) => value.map(result =>
  Match.valueTags(State.Ready({ value: result }), { Ready: item => item.value }),
)

export const redactedToken = () => String(redact('secret', 'token'))
export const syncFallback = () => Result.firstSuccessOf([
  () => LoadError.err({ operation: 'primary', retryable: false }),
  () => ok(42),
])

// Race is first-success; raceFirst is first-completion. Both await loser cleanup.
export const raceSuccess = () => ResultTask.race(ResultTask.err('early'), ResultTask.ok(42))
export const raceCompletion = () => ResultTask.raceFirst(ResultTask.err('early'), ResultTask.ok(42))

export const virtualClock = () => Clock.virtual()
// Executable boundary: starts work and returns a native Promise to its caller.
// Reusable repository/use-case methods return the Task before this runExit call.
export const runDefectInspection = async (): Promise<boolean> => {
  const exit = await ResultTask.sync(() => { throw new Error('defect') }).runExit()
  return exit._tag === 'Failure' && Cause.hasDies(exit.cause)
}
```
