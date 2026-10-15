import { equal, strictEqual } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  type Result,
  type ResultAsync,
  ResultTask,
  err,
  errAsync,
  ok,
  okAsync,
} from '../src/index.js'
import type { ExcludeReasonTag } from '../src/tagged/tagged-types.js'

type Missing = { readonly _tag: 'Missing' }
type Offline = { readonly _tag: 'Offline' }
type Audit = { readonly _tag: 'Audit' }
type Errors = Missing | Offline
const missing: Missing = { _tag: 'Missing' }
const offline: Offline = { _tag: 'Offline' }

describe('optional tagged recovery', () => {
  it('retains an absent optional Result handler and its possible recovery errors', () => {
    const handlers: { readonly Missing?: () => Result<string, Audit> } = {}
    const recovered = err<number, Errors>(missing).catchTags(handlers)

    expectTypeOf(recovered).toEqualTypeOf<Result<number | string, Errors | Audit>>()
    strictEqual(recovered._unsafeUnwrapErr(), missing)
  })

  it('retains absent optional ResultAsync and ResultTask handlers', async () => {
    const asyncHandlers: { readonly Missing?: () => ResultAsync<string, Audit> } = {}
    const taskHandlers: { readonly Missing?: () => ResultTask<string, Audit> } = {}
    const async = errAsync<number, Errors>(missing).catchTags(asyncHandlers)
    const task = ResultTask.err<Errors>(missing).catchTags(taskHandlers)

    expectTypeOf(async).toEqualTypeOf<ResultAsync<number | string, Errors | Audit>>()
    expectTypeOf(task).toEqualTypeOf<ResultTask<string, Errors | Audit>>()
    strictEqual((await async)._unsafeUnwrapErr(), missing)
    strictEqual((await ResultTask.runResult(task))._unsafeUnwrapErr(), missing)
  })

  it('retains optional Task handlers through static and pipe composition', async () => {
    const handlers: { readonly Missing?: () => ResultTask<string, Audit> } = {}
    const source = ResultTask.err<Errors>(missing)
    const direct = ResultTask.catchTags(source, handlers)
    const piped = source.pipe(ResultTask.catchTags(handlers))

    expectTypeOf(direct).toEqualTypeOf<ResultTask<string, Errors | Audit>>()
    expectTypeOf(piped).toEqualTypeOf<ResultTask<string, Errors | Audit>>()
    strictEqual((await ResultTask.runResult(direct))._unsafeUnwrapErr(), missing)
    strictEqual((await ResultTask.runResult(piped))._unsafeUnwrapErr(), missing)
  })
})

type SyncTable =
  | { readonly Missing: () => Result<string, Audit> }
  | { readonly Offline: () => Result<boolean, Audit> }
const syncTable = (which: 'missing' | 'offline'): SyncTable =>
  which === 'missing' ? { Missing: () => ok('recovered') } : { Offline: () => ok(true) }

type AsyncTable =
  | { readonly Missing: () => ResultAsync<string, Audit> }
  | { readonly Offline: () => ResultAsync<boolean, Audit> }
const asyncTable = (which: 'missing' | 'offline'): AsyncTable =>
  which === 'missing' ? { Missing: () => okAsync('recovered') } : { Offline: () => okAsync(true) }

type TaskTable =
  | { readonly Missing: () => ResultTask<string, Audit> }
  | { readonly Offline: () => ResultTask<boolean, Audit> }
const taskTable = (which: 'missing' | 'offline'): TaskTable =>
  which === 'missing'
    ? { Missing: () => ResultTask.ok('recovered') }
    : { Offline: () => ResultTask.ok(true) }

describe('union tagged recovery tables', () => {
  it('includes recovery outputs from every Result table branch without erasing unhandled tags', () => {
    const recovered = err<number, Errors>(missing).catchTags(syncTable('missing'))
    const untouched = err<number, Errors>(missing).catchTags(syncTable('offline'))

    expectTypeOf(recovered).toEqualTypeOf<Result<number | string | boolean, Errors | Audit>>()
    expectTypeOf(untouched).toEqualTypeOf<Result<number | string | boolean, Errors | Audit>>()
    equal(recovered._unsafeUnwrap(), 'recovered')
    strictEqual(untouched._unsafeUnwrapErr(), missing)
  })

  it('preserves branch outputs and errors for ResultAsync and ResultTask', async () => {
    const async = errAsync<number, Errors>(offline).catchTags(asyncTable('offline'))
    const task = ResultTask.err<Errors>(offline).catchTags(taskTable('offline'))

    expectTypeOf(async).toEqualTypeOf<ResultAsync<number | string | boolean, Errors | Audit>>()
    expectTypeOf(task).toEqualTypeOf<ResultTask<string | boolean, Errors | Audit>>()
    equal((await async)._unsafeUnwrap(), true)
    equal((await ResultTask.runResult(task))._unsafeUnwrap(), true)
  })

  it('excludes only handlers guaranteed to be functions in every table branch', () => {
    type Table =
      | {
          readonly Missing?: () => Result<string, Audit>
          readonly Offline: () => Result<boolean, Audit>
        }
      | {
          readonly Missing: () => Result<string, Audit>
          readonly Offline: () => Result<boolean, Audit>
        }
    const makeTable = (): Table => ({ Offline: () => ok(true) })
    const recovered = err<number, Errors>(missing).catchTags(makeTable())

    expectTypeOf(recovered).toEqualTypeOf<Result<number | string | boolean, Missing | Audit>>()
    strictEqual(recovered._unsafeUnwrapErr(), missing)
  })
})

type EmptyReason = { readonly _tag: 'Empty' }
type FormatReason = { readonly _tag: 'Format' }
type Invalid = { readonly _tag: 'Invalid'; readonly reason: EmptyReason | FormatReason }
type ReasonErrors = Invalid | Offline
const invalid: Invalid = { _tag: 'Invalid', reason: { _tag: 'Empty' } }

describe('optional and union reason recovery', () => {
  it('retains an absent optional reason handler', async () => {
    const handlers: { readonly Empty?: () => Result<string, Audit> } = {}
    const sync = err<number, ReasonErrors>(invalid).catchReasons('Invalid', handlers)
    const async = errAsync<number, ReasonErrors>(invalid).catchReasons('Invalid', handlers)

    expectTypeOf(sync).toEqualTypeOf<
      Result<number | string, ExcludeReasonTag<ReasonErrors, 'Invalid', never> | Audit>
    >()
    expectTypeOf(async).toEqualTypeOf<
      ResultAsync<number | string, ExcludeReasonTag<ReasonErrors, 'Invalid', never> | Audit>
    >()
    strictEqual(sync._unsafeUnwrapErr(), invalid)
    strictEqual((await async)._unsafeUnwrapErr(), invalid)
  })

  it('includes outputs from every reason-table branch', async () => {
    type Table =
      | { readonly Empty: () => Result<string, Audit> }
      | { readonly Format: () => Result<boolean, Audit> }
    const makeTable = (): Table => ({ Empty: () => ok('reason recovery') })
    const sync = err<number, ReasonErrors>(invalid).catchReasons('Invalid', makeTable())
    const async = errAsync<number, ReasonErrors>(invalid).catchReasons('Invalid', makeTable())

    expectTypeOf(sync).toEqualTypeOf<
      Result<number | string | boolean, ExcludeReasonTag<ReasonErrors, 'Invalid', never> | Audit>
    >()
    expectTypeOf(async).toEqualTypeOf<
      ResultAsync<
        number | string | boolean,
        ExcludeReasonTag<ReasonErrors, 'Invalid', never> | Audit
      >
    >()
    equal(sync._unsafeUnwrap(), 'reason recovery')
    equal((await async)._unsafeUnwrap(), 'reason recovery')
  })
})

describe('handler-table requirements and remaining errors', () => {
  it('retains requirements of possible optional Task recovery branches', async () => {
    const Prefix = ResultTask.service<string>()('prefix')
    const handlers: { readonly Missing?: () => ResultTask<string, Audit, typeof Prefix> } = {}
    const recovered = ResultTask.err<Errors>(missing).catchTags(handlers)

    expectTypeOf(recovered).toEqualTypeOf<ResultTask<string, Errors | Audit, typeof Prefix>>()
    const result = await ResultTask.runResult(recovered, { services: { prefix: '>' } })
    strictEqual(result._unsafeUnwrapErr(), missing)
  })

  it('keeps a partial-match fallback when Error is optional in one table branch', () => {
    type Table =
      | { readonly Error?: (error: string) => string }
      | { readonly Error: (error: string) => string }
    const makeTable = (): Table => ({})
    const output = err<number, string>('unhandled').matchTagsPartial(
      String,
      makeTable(),
      (error) => {
        expectTypeOf(error).toEqualTypeOf<string>()
        return error
      },
    )

    equal(output, 'unhandled')
  })
})
