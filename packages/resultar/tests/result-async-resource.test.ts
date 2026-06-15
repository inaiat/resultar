import { deepEqual, equal, ok as isTrue, rejects } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import type {
  AbortError,
  ResultAsync as ResultAsyncType,
  ResultAsyncResourceAcquire,
  ResultAsyncResourceReleaseContext,
  ResultAsyncWithResourceOptions,
} from '../src/index.js'

import { ResultAsync, isAbortError } from '../src/index.js'

describe('ResultAsync resource helpers', () => {
  it('acquires, uses, and releases a resource after success', async () => {
    const events: string[] = []

    const result = await ResultAsync.withResource({
      acquire: () => {
        events.push('acquire')
        return ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' })
      },
      release: (resource, context) => {
        events.push(`release:${resource.id}:${context.result?.isOk() ? 'ok' : 'err'}`)
      },
      use: (resource) => {
        events.push(`use:${resource.id}`)
        return ResultAsync.okAsync<string, 'use'>('done')
      },
    })

    isTrue(result.isOk())
    equal(result.value, 'done')
    deepEqual(events, ['acquire', 'use:resource-1', 'release:resource-1:ok'])
  })

  it('releases a resource after the use step returns an error', async () => {
    const releaseStates: string[] = []

    const result = await ResultAsync.withResource({
      acquire: () => ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' }),
      release: (_resource, context) => {
        releaseStates.push(context.result?.isErr() ? String(context.result.error) : 'ok')
      },
      use: () => ResultAsync.errAsync<string, 'use'>('use'),
    })

    isTrue(result.isErr())
    equal(result.error, 'use')
    deepEqual(releaseStates, ['use'])
  })

  it('does not release when acquisition fails', async () => {
    let used = false
    let released = false

    const result = await ResultAsync.withResource({
      acquire: () => ResultAsync.errAsync<{ readonly id: string }, 'acquire'>('acquire'),
      release: () => {
        released = true
      },
      use: () => {
        used = true
        return ResultAsync.okAsync<string, 'use'>('done')
      },
    })

    isTrue(result.isErr())
    equal(result.error, 'acquire')
    equal(used, false)
    equal(released, false)
  })

  it('returns AbortError without acquiring when the incoming signal is already aborted', async () => {
    const controller = new AbortController()
    let acquired = false

    controller.abort(new Error('already stopped'))

    const result = await ResultAsync.withResource({
      acquire: () => {
        acquired = true
        return ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' })
      },
      release: () => undefined,
      signal: controller.signal,
      use: () => ResultAsync.okAsync<string, 'use'>('done'),
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    equal(acquired, false)
  })

  it('releases after acquisition if the signal is aborted before use starts', async () => {
    const controller = new AbortController()
    const events: string[] = []

    const result = await ResultAsync.withResource({
      acquire: () => {
        events.push('acquire')
        controller.abort(new Error('stop'))
        return ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' })
      },
      release: (_resource, context) => {
        events.push(
          context.result?.isErr() && isAbortError(context.result.error)
            ? 'release:abort'
            : 'release',
        )
      },
      signal: controller.signal,
      use: () => {
        events.push('use')
        return ResultAsync.okAsync<string, 'use'>('done')
      },
    })

    isTrue(result.isErr())
    isTrue(isAbortError(result.error))
    deepEqual(events, ['acquire', 'release:abort'])
  })

  it('ignores release failures and release ResultAsync errors', async () => {
    const thrownReleaseResult = await ResultAsync.withResource({
      acquire: () => ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' }),
      release: () => {
        throw new Error('cleanup failed')
      },
      use: () => ResultAsync.okAsync<string, 'use'>('done'),
    })
    const errReleaseResult = await ResultAsync.withResource({
      acquire: () => ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-2' }),
      release: () => ResultAsync.errAsync<void, 'cleanup'>('cleanup'),
      use: () => ResultAsync.okAsync<string, 'use'>('done'),
    })

    isTrue(thrownReleaseResult.isOk())
    equal(thrownReleaseResult.value, 'done')
    isTrue(errReleaseResult.isOk())
    equal(errReleaseResult.value, 'done')
  })

  it('releases and preserves rejection when the use callback throws', async () => {
    const contexts: ResultAsyncResourceReleaseContext[] = []

    await rejects(
      async () =>
        await ResultAsync.withResource({
          acquire: () =>
            ResultAsync.okAsync<{ readonly id: string }, 'acquire'>({ id: 'resource-1' }),
          release: (_resource, context) => {
            contexts.push(context)
          },
          use: () => {
            throw new Error('use callback failed')
          },
        }),
      /use callback failed/u,
    )

    equal(contexts.length, 1)
    equal(contexts[0]?.result, undefined)
  })

  it('exports resource helper types and infers success and error unions', () => {
    const acquire: ResultAsyncResourceAcquire<{ readonly id: string }, 'acquire'> = () =>
      ResultAsync.okAsync({ id: 'resource-1' })
    const options: ResultAsyncWithResourceOptions<
      { readonly id: string },
      'acquire',
      string,
      'use'
    > = { acquire, release: () => undefined, use: () => ResultAsync.errAsync('use') }
    const result = ResultAsync.withResource(options)

    expectTypeOf(result).toExtend<ResultAsyncType<string, 'acquire' | 'use' | AbortError>>()
  })
})
