import { deepEqual, equal, ok as isTrue } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type { Result as ResultType, TaggedEnum } from '../src/index.js'

import {
  AbortError,
  Result,
  ResultAsync,
  createTaggedError,
  err,
  errAsync,
  isAbortError,
  isRedacted,
  ok,
  okAsync,
  redact,
  revealRedacted,
  taggedEnum,
} from '../src/index.js'

const AiReason = taggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: Record<never, never>
}>()

type AiReason = TaggedEnum<{
  QuotaExceededError: { readonly limit: number }
  RateLimitError: { readonly retryAfterMs: number }
  SafetyBlockedError: Record<never, never>
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
  it('detects abort-shaped errors', () => {
    const abort = new AbortError('stop')

    isTrue(isAbortError(abort))
    isTrue(isAbortError({ name: 'AbortError' }))
    isTrue(isAbortError({ code: 'ABORT_ERR' }))
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
