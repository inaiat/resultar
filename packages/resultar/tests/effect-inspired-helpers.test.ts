/* eslint-disable unicorn/throw-new-error */

import { deepEqual, equal, ok as isTrue } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Result as ResultType, TaggedEnum } from '../src/index.js'

import {
  AbortError,
  Result,
  ResultAsync,
  ResultTask,
  createTaggedError,
  err,
  errAsync,
  isAbortError,
  isRedacted,
  ok,
  okAsync,
  pipe,
  redact,
  revealRedacted,
  taggedEnum,
} from '../src/index.js'

const AiReason = taggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: object
}>()

type AiReason = TaggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: object
}>

class AiError extends createTaggedError({ message: 'AI request failed', name: 'AiError' }) {
  public readonly reason: AiReason

  public constructor(props: { readonly cause?: unknown; readonly reason: AiReason }) {
    super({ cause: props.cause })
    this.reason = props.reason
  }
}

class PermissionError extends createTaggedError({
  message: 'Missing permission $permission',
  name: 'PermissionError',
}) {}

class SecretError extends createTaggedError({
  message: 'Token $token failed',
  name: 'SecretError',
}) {}

describe('tagged enum runtime helpers', () => {
  it('creates plain tagged values and matches them exhaustively', () => {
    const rateLimit = AiReason.RateLimitError({ retryAfterMs: 250 })
    const blocked = AiReason.SafetyBlockedError()

    deepEqual(rateLimit, { _tag: 'RateLimitError', retryAfterMs: 250 })
    deepEqual(blocked, { _tag: 'SafetyBlockedError' })
    equal(Object.isFrozen(rateLimit), true)
    equal(AiReason.$is('RateLimitError', rateLimit), true)
    equal(AiReason.$is('QuotaExceededError', rateLimit), false)

    const message = AiReason.$match(rateLimit, {
      QuotaExceededError: (reason) => `quota:${reason.limit}`,
      RateLimitError: (reason) => `retry:${reason.retryAfterMs}`,
      SafetyBlockedError: () => 'blocked',
    })

    equal(message, 'retry:250')
    expectTypeOf(rateLimit._tag).toEqualTypeOf<'RateLimitError'>()

    const unknownValue: unknown = rateLimit
    if (AiReason.$is('RateLimitError', unknownValue)) {
      expectTypeOf(unknownValue.retryAfterMs).toEqualTypeOf<number>()
    }
  })
})

describe('reason-aware tagged errors', () => {
  it('recovers from a matching sync reason', () => {
    const error = new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 500 }) })
    const result = err<number, AiError | PermissionError>(error).catchReason(
      'AiError',
      'RateLimitError',
      (reason, parent) => {
        expectTypeOf(reason.retryAfterMs).toEqualTypeOf<number>()
        equal(parent.reason, reason)
        return ok(`retry:${reason.retryAfterMs}`)
      },
    )

    isTrue(result.isOk())
    equal(result.value, 'retry:500')
  })

  it('recovers from multiple sync reasons', () => {
    const result = err<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.QuotaExceededError({ limit: 10 }) }),
    ).catchReasons('AiError', {
      QuotaExceededError: (reason) => ok(`quota:${reason.limit}`),
      RateLimitError: (reason) => ok(`retry:${reason.retryAfterMs}`),
    })

    isTrue(result.isOk())
    equal(result.value, 'quota:10')
  })

  it('unwraps a parent tagged error into its reason', () => {
    const reason = AiReason.SafetyBlockedError()
    const result = err<number, AiError | PermissionError>(new AiError({ reason })).unwrapReason(
      'AiError',
    )

    isTrue(result.isErr())
    equal(result.error, reason)
    expectTypeOf(result).toExtend<ResultType<number, AiReason | PermissionError>>()
  })

  it('recovers from a matching async reason', async () => {
    const result = errAsync<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 100 }) }),
    ).catchReason('AiError', 'RateLimitError', (reason) => okAsync(`retry:${reason.retryAfterMs}`))

    const resolved = await result

    isTrue(resolved.isOk())
    equal(resolved.value, 'retry:100')
    expectTypeOf(result).toExtend<ResultAsync<number | string, unknown>>()
  })
})

describe('record and iterable aggregation', () => {
  interface User {
    readonly id: string
  }

  interface Org {
    readonly id: string
  }

  it('combines sync record results by key', () => {
    const result = Result.combine({
      org: ok<Org, 'org-error'>({ id: 'o1' }),
      user: ok<User, 'user-error'>({ id: 'u1' }),
    })

    isTrue(result.isOk())
    deepEqual(result.value, { org: { id: 'o1' }, user: { id: 'u1' } })
    expectTypeOf(result).toExtend<
      ResultType<{ readonly org: Org; readonly user: User }, 'org-error' | 'user-error'>
    >()
  })

  it('collects sync record errors', () => {
    const result = Result.combineWithAllErrors({
      org: err<Org, 'org-error'>('org-error'),
      user: err<User, 'user-error'>('user-error'),
    })

    isTrue(result.isErr())
    deepEqual(result.error, ['org-error', 'user-error'])
  })

  it('combines sync iterable results into readonly arrays', () => {
    const result = Result.combine(new Set([ok<number, string>(1), ok<number, string>(2)]))

    isTrue(result.isOk())
    deepEqual(result.value, [1, 2])
    expectTypeOf(result).toExtend<ResultType<readonly number[], string>>()
  })

  it('combines async record results by key', async () => {
    const result = ResultAsync.combine({
      org: okAsync<Org, 'org-error'>({ id: 'o1' }),
      user: okAsync<User, 'user-error'>({ id: 'u1' }),
    })

    const resolved = await result

    isTrue(resolved.isOk())
    deepEqual(resolved.value, { org: { id: 'o1' }, user: { id: 'u1' } })
    expectTypeOf(result).toExtend<
      ResultAsync<{ readonly org: Org; readonly user: User }, 'org-error' | 'user-error'>
    >()
  })
})

describe('abort, causes, and redaction', () => {
  it('creates AbortError instances with default message, name, and cause', () => {
    const defaultAbort = new AbortError()
    const cause = new Error('network closed')
    const causedAbort = new AbortError('stopped', { cause })

    equal(defaultAbort.name, 'AbortError')
    equal(defaultAbort.message, 'Operation aborted')
    isTrue(defaultAbort instanceof Error)
    isTrue(defaultAbort instanceof AbortError)
    equal(causedAbort.name, 'AbortError')
    equal(causedAbort.message, 'stopped')
    equal(causedAbort.cause, cause)
  })

  it('detects abort-shaped errors', () => {
    const abort = new AbortError('stop')

    isTrue(isAbortError(abort))
    isTrue(isAbortError({ name: 'AbortError' }))
    isTrue(isAbortError({ code: 'ABORT_ERR' }))
  })

  it('rejects non-abort-shaped values', () => {
    const nonAbortValues: readonly unknown[] = [
      undefined,
      null,
      false,
      0,
      'AbortError',
      {},
      { code: 'OTHER' },
      { code: undefined },
      { name: 'OtherError' },
      { name: undefined },
    ]

    for (const value of nonAbortValues) {
      equal(isAbortError(value), false)
    }
  })

  it('redacts tagged error props in messages and JSON', () => {
    const token = redact('super-secret', 'api-token')
    const error = new SecretError({ token })
    const json = error.toJSON() as { readonly token: unknown }

    equal(error.message, 'Token <redacted:api-token> failed')
    isTrue(isRedacted(error.token))
    equal(revealRedacted(error.token), 'super-secret')
    equal(json.token, '<redacted:api-token>')
  })

  it('tracks redacted values without treating ordinary values as redacted', () => {
    const secret = { token: 'super-secret' }
    const redacted = redact(secret)

    equal((redacted as { readonly __resultarRedacted: unknown }).__resultarRedacted, true)
    equal(redacted.label, undefined)
    equal(redacted.toString(), '<redacted>')
    equal(redacted.toJSON(), '<redacted>')
    isTrue(isRedacted(redacted))
    equal(revealRedacted(redacted), secret)

    const nonRedactedValues: readonly unknown[] = [
      null,
      {},
      { __resultarRedacted: true },
      { label: undefined },
      'plain',
    ]

    for (const value of nonRedactedValues) {
      equal(isRedacted(value), false)
    }
  })

  it('serializes nested circular causes safely', () => {
    const root = new Error('root')
    const wrapped = new Error('wrapped', { cause: root })

    Object.defineProperty(root, 'cause', { configurable: true, value: wrapped })

    const error = new AiError({ cause: wrapped, reason: AiReason.SafetyBlockedError() })
    const json = error.toJSON() as {
      readonly cause: {
        readonly cause: {
          readonly cause: { readonly cause: unknown; readonly message: string }
          readonly message: string
        }
        readonly message: string
      }
    }

    equal(json.cause.message, 'wrapped')
    equal(json.cause.cause.message, 'root')
    equal(json.cause.cause.cause.message, 'wrapped')
    equal(json.cause.cause.cause.cause, '[Circular]')
  })
})

describe('static and ResultTask reason helpers', () => {
  it('supports static and curried Result.catchReason, catchReasons, and unwrapReason', () => {
    const failed = err<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 300 }) }),
    )

    const directRecovered = Result.catchReason(failed, 'AiError', 'RateLimitError', (reason) =>
      ok(`direct:${reason.retryAfterMs}`),
    )
    const pipedRecovered = pipe(
      failed,
      Result.catchReason('AiError', 'RateLimitError', (reason) =>
        ok(`pipe:${reason.retryAfterMs}`),
      ),
    )

    isTrue(directRecovered.isOk())
    equal(directRecovered.value, 'direct:300')
    isTrue(pipedRecovered.isOk())
    equal(pipedRecovered.value, 'pipe:300')

    const quotaFailed = err<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.QuotaExceededError({ limit: 42 }) }),
    )
    const directReasons = Result.catchReasons(quotaFailed, 'AiError', {
      QuotaExceededError: (reason) => ok(`quota:${reason.limit}`),
      RateLimitError: (reason) => ok(`retry:${reason.retryAfterMs}`),
    })
    const pipedReasons = pipe(
      quotaFailed,
      Result.catchReasons('AiError', {
        QuotaExceededError: (reason) => ok(`pipe-quota:${reason.limit}`),
      }),
    )

    isTrue(directReasons.isOk())
    equal(directReasons.value, 'quota:42')
    isTrue(pipedReasons.isOk())
    equal(pipedReasons.value, 'pipe-quota:42')

    const blockedReason = AiReason.SafetyBlockedError()
    const blockedFailed = err<number, AiError | PermissionError>(
      new AiError({ reason: blockedReason }),
    )
    const directUnwrapped = Result.unwrapReason(blockedFailed, 'AiError')
    const pipedUnwrapped = pipe(blockedFailed, Result.unwrapReason('AiError'))

    isTrue(directUnwrapped.isErr())
    equal(directUnwrapped.error, blockedReason)
    isTrue(pipedUnwrapped.isErr())
    equal(pipedUnwrapped.error, blockedReason)
    expectTypeOf(pipedUnwrapped).toExtend<ResultType<number, AiReason | PermissionError>>()
  })

  it('supports static and curried ResultAsync.catchReason, catchReasons, and unwrapReason', async () => {
    const failed = errAsync<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 150 }) }),
    )

    const directRecovered = await ResultAsync.catchReason(
      failed,
      'AiError',
      'RateLimitError',
      (reason) => ok(`direct:${reason.retryAfterMs}`),
    )
    const pipedRecovered = await pipe(
      failed,
      ResultAsync.catchReason('AiError', 'RateLimitError', (reason) =>
        okAsync(`pipe:${reason.retryAfterMs}`),
      ),
    )

    isTrue(directRecovered.isOk())
    equal(directRecovered.value, 'direct:150')
    isTrue(pipedRecovered.isOk())
    equal(pipedRecovered.value, 'pipe:150')

    const quotaFailed = errAsync<number, AiError | PermissionError>(
      new AiError({ reason: AiReason.QuotaExceededError({ limit: 99 }) }),
    )
    const pipedReasons = await pipe(
      quotaFailed,
      ResultAsync.catchReasons('AiError', {
        QuotaExceededError: (reason) => ok(`quota:${reason.limit}`),
      }),
    )

    isTrue(pipedReasons.isOk())
    equal(pipedReasons.value, 'quota:99')

    const blockedReason = AiReason.SafetyBlockedError()
    const blockedFailed = errAsync<number, AiError | PermissionError>(
      new AiError({ reason: blockedReason }),
    )
    const pipedUnwrapped = await pipe(blockedFailed, ResultAsync.unwrapReason('AiError'))

    isTrue(pipedUnwrapped.isErr())
    equal(pipedUnwrapped.error, blockedReason)
  })

  it('supports instance, static, and curried ResultTask.catchReason, catchReasons, and unwrapReason', async () => {
    const RetryService = ResultTask.service<{ readonly prefix: string }>()('RetryService')

    const task = ResultTask.err<AiError | PermissionError>(
      new AiError({ reason: AiReason.RateLimitError({ retryAfterMs: 200 }) }),
    ) as ResultTask<number, AiError | PermissionError>

    const instanceRecovered = task.catchReason('AiError', 'RateLimitError', (reason, parent) =>
      ResultTask.gen(function* () {
        const svc = yield* RetryService
        return `${svc.prefix}:${parent._tag}:${reason.retryAfterMs}`
      }),
    )

    const resolvedInstance = await ResultTask.runResult(
      instanceRecovered.provideService(RetryService, { prefix: 'instance' }),
    )
    isTrue(resolvedInstance.isOk())
    equal(resolvedInstance.value, 'instance:AiError:200')

    const pipedReasons = pipe(
      ResultTask.err<AiError | PermissionError>(
        new AiError({ reason: AiReason.QuotaExceededError({ limit: 7 }) }),
      ) as ResultTask<number, AiError | PermissionError>,
      ResultTask.catchReasons('AiError', {
        QuotaExceededError: (reason) => ResultTask.ok(`quota:${reason.limit}`),
        RateLimitError: (reason) => ResultTask.ok(`retry:${reason.retryAfterMs}`),
      }),
    )

    const resolvedReasons = await ResultTask.runResult(pipedReasons)
    isTrue(resolvedReasons.isOk())
    equal(resolvedReasons.value, 'quota:7')

    const blockedReason = AiReason.SafetyBlockedError()
    const unwrappedTask = pipe(
      ResultTask.err<AiError | PermissionError>(
        new AiError({ reason: blockedReason }),
      ) as ResultTask<number, AiError | PermissionError>,
      ResultTask.unwrapReason('AiError'),
    )
    expectTypeOf(unwrappedTask).toExtend<ResultTask<number, AiReason | PermissionError, never>>()

    const resolvedUnwrapped = await ResultTask.runResult(unwrappedTask)
    isTrue(resolvedUnwrapped.isErr())
    equal(resolvedUnwrapped.error, blockedReason)
  })
})

describe('orElseSucceed and unwrapOr helpers', () => {
  it('recovers with plain values via orElseSucceed and unwrapOr on Result', () => {
    const failed = PermissionError.err({ permission: 'write' }) as ResultType<
      number,
      PermissionError
    >
    const succeeded = ok<number, PermissionError>(42)

    const fromInstance = failed.orElseSucceed((error) => `missing:${error.permission}`)
    const fromStatic = Result.orElseSucceed(failed, (error) => `static:${error.permission}`)
    const fromPipe = pipe(
      failed,
      Result.orElseSucceed((error) => `pipe:${error.permission}`),
    )
    const keptOk = succeeded.orElseSucceed(() => 'fallback')

    expectTypeOf(fromInstance).toEqualTypeOf<ResultType<number | string, never>>()
    expectTypeOf(fromPipe).toEqualTypeOf<ResultType<number | string, never>>()

    isTrue(fromInstance.isOk())
    equal(fromInstance.value, 'missing:write')
    isTrue(fromStatic.isOk())
    equal(fromStatic.value, 'static:write')
    isTrue(fromPipe.isOk())
    equal(fromPipe.value, 'pipe:write')
    isTrue(keptOk.isOk())
    equal(keptOk.value, 42)

    equal(Result.unwrapOr(failed, 0), 0)
    equal(pipe(failed, Result.unwrapOr(99)), 99)
    equal(pipe(succeeded, Result.unwrapOr(99)), 42)
  })

  it('recovers with plain values via orElseSucceed and unwrapOr on ResultAsync', async () => {
    const failed = PermissionError.errAsync({ permission: 'admin' }) as ResultAsync<
      number,
      PermissionError
    >
    const succeeded = okAsync<number, PermissionError>(10)

    const fromInstance = failed.orElseSucceed((error) => `missing:${error.permission}`)
    const fromPipe = pipe(
      failed,
      ResultAsync.orElseSucceed((error) => `pipe:${error.permission}`),
    )
    const keptOk = succeeded.orElseSucceed(() => 'fallback')

    expectTypeOf(fromInstance).toEqualTypeOf<ResultAsync<number | string, never>>()

    const resolvedInstance = await fromInstance
    const resolvedPipe = await fromPipe
    const resolvedKept = await keptOk

    isTrue(resolvedInstance.isOk())
    equal(resolvedInstance.value, 'missing:admin')
    isTrue(resolvedPipe.isOk())
    equal(resolvedPipe.value, 'pipe:admin')
    isTrue(resolvedKept.isOk())
    equal(resolvedKept.value, 10)

    deepEqual(await ResultAsync.unwrapOr(failed, 0), ok(0))
    deepEqual(await pipe(failed, ResultAsync.unwrapOr(77)), ok(77))
    deepEqual(await pipe(succeeded, ResultAsync.unwrapOr(77)), ok(10))
  })

  it('recovers with plain values via orElseSucceed and unwrapOr on ResultTask', async () => {
    const failed = PermissionError.taskErr({ permission: 'delete' }) as ResultTask<
      number,
      PermissionError
    >
    const succeeded = ResultTask.ok(21) as ResultTask<number, PermissionError>

    const fromInstance = failed.orElseSucceed((error) => `missing:${error.permission}`)
    const fromPipe = pipe(
      failed,
      ResultTask.orElseSucceed((error) => `pipe:${error.permission}`),
    )
    const unwrappedInstance = failed.unwrapOr(0)
    const unwrappedPipe = pipe(failed, ResultTask.unwrapOr(100))
    const unwrappedOk = pipe(succeeded, ResultTask.unwrapOr(100))

    expectTypeOf(fromInstance).toEqualTypeOf<ResultTask<number | string, never, never>>()
    expectTypeOf(unwrappedInstance).toEqualTypeOf<ResultTask<number, never, never>>()

    const resolvedInstance = await ResultTask.runResult(fromInstance)
    const resolvedPipe = await ResultTask.runResult(fromPipe)
    const resolvedUnwrapped = await ResultTask.runResult(unwrappedInstance)
    const resolvedUnwrappedPipe = await ResultTask.runResult(unwrappedPipe)
    const resolvedUnwrappedOk = await ResultTask.runResult(unwrappedOk)

    isTrue(resolvedInstance.isOk())
    equal(resolvedInstance.value, 'missing:delete')
    isTrue(resolvedPipe.isOk())
    equal(resolvedPipe.value, 'pipe:delete')
    isTrue(resolvedUnwrapped.isOk())
    equal(resolvedUnwrapped.value, 0)
    isTrue(resolvedUnwrappedPipe.isOk())
    equal(resolvedUnwrappedPipe.value, 100)
    isTrue(resolvedUnwrappedOk.isOk())
    equal(resolvedUnwrappedOk.value, 21)
  })
})

describe('ResultTask.tapBoth', () => {
  it('runs effectful ok or err side-effect tasks and merges error and requirement channels', async () => {
    const AuditService = ResultTask.service<{ readonly log: (entry: string) => void }>()(
      'AuditService',
    )
    const events: string[] = []

    const okTask = (ResultTask.ok(42) as ResultTask<number, PermissionError>).tapBoth({
      err: (error) =>
        ResultTask.gen(function* () {
          const svc = yield* AuditService
          svc.log(`err:${error.permission}`)
        }),
      ok: (value) =>
        ResultTask.gen(function* () {
          const svc = yield* AuditService
          svc.log(`ok:${value}`)
        }),
    })

    const okResult = await ResultTask.runResult(
      okTask.provideService(AuditService, { log: (entry) => events.push(entry) }),
    )
    isTrue(okResult.isOk())
    equal(okResult.value, 42)
    deepEqual(events, ['ok:42'])

    const errTask = pipe(
      PermissionError.taskErr({ permission: 'read' }) as ResultTask<number, PermissionError>,
      ResultTask.tapBoth(
        (value) => {
          events.push(`unexpected-ok:${value}`)
        },
        (error) =>
          ResultTask.gen(function* () {
            const svc = yield* AuditService
            svc.log(`err:${error.permission}`)
          }),
      ),
    )

    const errResult = await ResultTask.runResult(
      errTask.provideService(AuditService, { log: (entry) => events.push(entry) }),
    )
    isTrue(errResult.isErr())
    equal(errResult.error.permission, 'read')
    deepEqual(events, ['ok:42', 'err:read'])
  })

  it('does not execute the error callback when the ok callback fails', async () => {
    const events: string[] = []
    const task = (ResultTask.ok(10) as ResultTask<number, PermissionError>).tapBoth(
      () => {
        events.push('onOk')
        return SecretError.taskErr({ token: 'expired' })
      },
      (error) => {
        events.push(`onErr:${error._tag}`)
      },
    )

    expectTypeOf(task).toEqualTypeOf<ResultTask<number, PermissionError | SecretError, never>>()

    const result = await ResultTask.runResult(task)
    isTrue(result.isErr())
    equal(result.error._tag, 'SecretError')
    deepEqual(events, ['onOk'])
  })
})

describe('asVoid across Result, ResultAsync, and ResultTask', () => {
  it('replaces the Ok value with void while preserving Err on Result', () => {
    const succeeded = ok<number, 'boom'>(42)
    const failed = err<number, 'boom'>('boom')

    const fromInstance = succeeded.asVoid()
    const fromStatic = Result.asVoid(succeeded)
    const fromPipeZeroArg = pipe(succeeded, Result.asVoid())
    const fromPipePointFree = pipe(succeeded, Result.asVoid)
    const fromErr = failed.asVoid()

    expectTypeOf(fromInstance).toEqualTypeOf<ResultType<void, 'boom'>>()
    expectTypeOf(fromStatic).toEqualTypeOf<ResultType<void, 'boom'>>()
    expectTypeOf(fromPipeZeroArg).toEqualTypeOf<ResultType<void, 'boom'>>()
    expectTypeOf(fromPipePointFree).toEqualTypeOf<ResultType<void, 'boom'>>()

    isTrue(fromInstance.isOk())
    equal(fromInstance.value, undefined)
    isTrue(fromStatic.isOk())
    equal(fromStatic.value, undefined)
    isTrue(fromPipeZeroArg.isOk())
    equal(fromPipeZeroArg.value, undefined)
    isTrue(fromPipePointFree.isOk())
    equal(fromPipePointFree.value, undefined)
    isTrue(fromErr.isErr())
    equal(fromErr.error, 'boom')
  })

  it('replaces the Ok value with void while preserving Err on ResultAsync', async () => {
    const succeeded = okAsync<number, 'boom'>(42)
    const failed = errAsync<number, 'boom'>('boom')

    const fromInstance = succeeded.asVoid()
    const fromStatic = ResultAsync.asVoid(succeeded)
    const fromPipeZeroArg = pipe(succeeded, ResultAsync.asVoid())
    const fromPipePointFree = pipe(succeeded, ResultAsync.asVoid)
    const fromErr = failed.asVoid()

    expectTypeOf(fromInstance).toEqualTypeOf<ResultAsync<void, 'boom'>>()
    expectTypeOf(fromStatic).toEqualTypeOf<ResultAsync<void, 'boom'>>()
    expectTypeOf(fromPipeZeroArg).toEqualTypeOf<ResultAsync<void, 'boom'>>()
    expectTypeOf(fromPipePointFree).toEqualTypeOf<ResultAsync<void, 'boom'>>()

    const r1 = await fromInstance
    const r2 = await fromStatic
    const r3 = await fromPipeZeroArg
    const r4 = await fromPipePointFree
    const rErr = await fromErr

    isTrue(r1.isOk())
    equal(r1.value, undefined)
    isTrue(r2.isOk())
    equal(r2.value, undefined)
    isTrue(r3.isOk())
    equal(r3.value, undefined)
    isTrue(r4.isOk())
    equal(r4.value, undefined)
    isTrue(rErr.isErr())
    equal(rErr.error, 'boom')
  })

  it('replaces the Ok value with void while preserving Err and requirements on ResultTask', async () => {
    const Logger = ResultTask.service<{ readonly log: (msg: string) => void }>()('Logger')
    const succeeded = ResultTask.gen(function* () {
      const logger = yield* Logger
      logger.log('hello')
      return 42
    }) as ResultTask<number, 'boom', typeof Logger>
    const failed = ResultTask.err<'boom'>('boom') as ResultTask<number, 'boom'>

    const fromInstance = succeeded.asVoid()
    const fromStatic = ResultTask.asVoid(succeeded)
    const fromPipeZeroArg = pipe(succeeded, ResultTask.asVoid())
    const fromPipePointFree = pipe(succeeded, ResultTask.asVoid)
    const fromErr = failed.asVoid()

    expectTypeOf(fromInstance).toEqualTypeOf<ResultTask<void, 'boom', typeof Logger>>()
    expectTypeOf(fromStatic).toEqualTypeOf<ResultTask<void, 'boom', typeof Logger>>()
    expectTypeOf(fromPipeZeroArg).toEqualTypeOf<ResultTask<void, 'boom', typeof Logger>>()
    expectTypeOf(fromPipePointFree).toEqualTypeOf<ResultTask<void, 'boom', typeof Logger>>()

    const env = { Logger: { log: () => undefined } }
    const r1 = await ResultTask.runResult(fromInstance, { services: env })
    const r2 = await ResultTask.runResult(fromStatic, { services: env })
    const r3 = await ResultTask.runResult(fromPipeZeroArg, { services: env })
    const r4 = await ResultTask.runResult(fromPipePointFree, { services: env })
    const rErr = await ResultTask.runResult(fromErr)

    isTrue(r1.isOk())
    equal(r1.value, undefined)
    isTrue(r2.isOk())
    equal(r2.value, undefined)
    isTrue(r3.isOk())
    equal(r3.value, undefined)
    isTrue(r4.isOk())
    equal(r4.value, undefined)
    isTrue(rErr.isErr())
    equal(rErr.error, 'boom')
  })
})
