import { equal, ok as isTrue } from 'node:assert/strict'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Cause, ResultTask, redact } from '../src/index.js'
import type { Result } from '../src/index.js'

describe('Cause inspection', () => {
  it('distinguishes each leaf kind without depending on payload truthiness', () => {
    const fail: Cause<undefined> = { _tag: 'Fail', error: undefined }
    const die: Cause<never> = { _tag: 'Die', defect: false }
    const interrupt: Cause<never> = { _tag: 'Interrupt', reason: null }

    equal(Cause.hasFails(fail), true)
    equal(Cause.hasDies(fail), false)
    equal(Cause.hasInterrupts(fail), false)
    equal(Cause.hasFails(die), false)
    equal(Cause.hasDies(die), true)
    equal(Cause.hasInterrupts(die), false)
    equal(Cause.hasFails(interrupt), false)
    equal(Cause.hasDies(interrupt), false)
    equal(Cause.hasInterrupts(interrupt), true)
    equal(Cause.findError(fail)._unsafeUnwrap(), undefined)
  })

  it('inspects nested causes and returns the first typed error from left to right', () => {
    const first = new Error('first')
    const cause: Cause<Error> = {
      _tag: 'Sequential',
      left: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect: 'defect' },
        right: { _tag: 'Fail', error: first },
      },
      right: {
        _tag: 'Sequential',
        left: { _tag: 'Interrupt', reason: 'cancelled' },
        right: { _tag: 'Fail', error: new Error('second') },
      },
    }

    equal(Cause.hasFails(cause), true)
    equal(Cause.hasDies(cause), true)
    equal(Cause.hasInterrupts(cause), true)
    equal(Cause.findError(cause)._unsafeUnwrap(), first)
  })

  it('preserves the original cause when no typed failure exists', () => {
    const cause: Cause<string> = {
      _tag: 'Sequential',
      left: { _tag: 'Die', defect: new Error('defect') },
      right: { _tag: 'Interrupt', reason: 'shutdown' },
    }
    const result = Cause.findError(cause)

    expectTypeOf(result).toEqualTypeOf<Result<string, Cause<never>>>()
    equal(result._unsafeUnwrapErr(), cause)
  })

  it('traverses mixed parallel and sequential branches in stable left-to-right order', () => {
    const cause: Cause<string> = {
      _tag: 'Parallel',
      left: { _tag: 'Fail', error: 'first' },
      right: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect: 'cleanup' },
        right: { _tag: 'Interrupt', reason: 'stop' },
      },
    }
    equal(Cause.findError(cause)._unsafeUnwrap(), 'first')
    equal(Cause.hasFails(cause), true)
    equal(Cause.hasDies(cause), true)
    equal(Cause.hasInterrupts(cause), true)
    equal(Cause.pretty(cause), 'Fail: first\nDie: cleanup\nInterrupt: stop')
  })

  it('handles deeply nested trees without recursion and preserves repeated leaves', () => {
    const leaf: Cause<never> = { _tag: 'Interrupt', reason: 'stop' }
    let cause: Cause<never> = leaf
    for (let index = 0; index < 20_000; index += 1) {
      cause = { _tag: index % 2 === 0 ? 'Sequential' : 'Parallel', left: cause, right: leaf }
    }

    equal(Cause.hasFails(cause), false)
    equal(Cause.hasDies(cause), false)
    equal(Cause.hasInterrupts(cause), true)
    equal(Cause.findError(cause)._unsafeUnwrapErr(), cause)
    equal(Cause.pretty(cause).split('\n').length, 20_001)
  })

  it('inspects actual body and release failures without changing the runner outcome', async () => {
    const program = ResultTask.gen(function* () {
      yield* ResultTask.acquireRelease({
        acquire: ResultTask.ok('resource'),
        release: () => ResultTask.err('release-error'),
      })
      return yield* ResultTask.err('body-error')
    })
    const exit = await ResultTask.runExit(program)
    isTrue(exit._tag === 'Failure')
    equal(exit.cause._tag, 'Sequential')
    equal(Cause.findError(exit.cause)._unsafeUnwrap(), 'body-error')
    equal(Cause.pretty(exit.cause), 'Fail: body-error\nFail: release-error')
  })
})

describe('Cause.pretty', () => {
  it('renders all leaf kinds in order', () => {
    const cause: Cause<string> = {
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: 'query failed' },
      right: {
        _tag: 'Sequential',
        left: { _tag: 'Die', defect: 'close failed' },
        right: { _tag: 'Interrupt', reason: 'shutdown' },
      },
    }
    equal(Cause.pretty(cause), 'Fail: query failed\nDie: close failed\nInterrupt: shutdown')
  })

  it('retains Error stacks and indents multiline values', () => {
    const error = new TypeError('invalid value')
    error.stack = 'TypeError: invalid value\n    at adapter.ts:1:1'
    equal(
      Cause.pretty({ _tag: 'Die', defect: error }),
      'Die: TypeError: invalid value\n      at adapter.ts:1:1',
    )
    equal(Cause.pretty({ _tag: 'Fail', error: 'first\nsecond' }), 'Fail: first\n  second')
    const withoutStack = new Error('no stack')
    delete withoutStack.stack
    equal(Cause.pretty({ _tag: 'Fail', error: withoutStack }), 'Fail: Error: no stack')
  })

  it('formats arbitrary primitive and structured payloads', () => {
    equal(Cause.pretty({ _tag: 'Fail', error: undefined }), 'Fail: undefined')
    equal(Cause.pretty({ _tag: 'Die', defect: null }), 'Die: null')
    equal(Cause.pretty({ _tag: 'Interrupt', reason: false }), 'Interrupt: false')
    equal(Cause.pretty({ _tag: 'Fail', error: 0 }), 'Fail: 0')
    equal(Cause.pretty({ _tag: 'Die', defect: 12n }), 'Die: "12n"')
    equal(Cause.pretty({ _tag: 'Die', defect: Symbol.for('defect') }), 'Die: "Symbol(defect)"')
    equal(
      Cause.pretty({ _tag: 'Fail', error: { _tag: 'Missing', id: '1' } }),
      'Fail: {"_tag":"Missing","id":"1"}',
    )
  })

  it('handles circular payloads and respects redaction', () => {
    const payload: { code: string; self?: unknown } = { code: 'circular' }
    payload.self = payload
    equal(
      Cause.pretty({ _tag: 'Die', defect: payload }),
      'Die: {"code":"circular","self":"[Circular]"}',
    )
    equal(
      Cause.pretty({ _tag: 'Fail', error: { token: redact('secret-token') } }),
      'Fail: {"token":"<redacted>"}',
    )
  })

  it('keeps diagnostic formatting usable when serialization throws', () => {
    const payload = {
      toJSON(): never {
        throw new Error('cannot serialize')
      },
    }
    equal(Cause.pretty({ _tag: 'Die', defect: payload }), 'Die: [Unserializable value]')
  })
})
