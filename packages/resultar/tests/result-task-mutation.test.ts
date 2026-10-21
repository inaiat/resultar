import { describe, expect, it } from 'vite-plus/test'

import { err, ok, ResultTask } from '../src/index.js'
import type { Exit, Result } from '../src/index.js'
import type { ResultTaskRuntimeContext } from '../src/task/task-service.js'

// Internal fixtures exercise interpreter inputs that public factories normalize before execution.
const InternalPromiseTask = ResultTask as unknown as new <A, E>(
  promise: Promise<Result<A, E>>,
) => ResultTask<A, E>

const InternalCustomTask = ResultTask as unknown as new <A, E>(instruction: {
  readonly _tag: 'Custom'
  readonly execute: (context: ResultTaskRuntimeContext) => Exit<A, E> | Promise<Exit<A, E>>
}) => ResultTask<A, E>

describe('ResultTask mutation regressions', () => {
  it('interprets successful and failed Promise constructor inputs', async () => {
    const successTask = new InternalPromiseTask(Promise.resolve(ok(42)))
    const failureTask = new InternalPromiseTask(Promise.resolve(err('not-found')))

    expect(await ResultTask.runExit(successTask)).toEqual({ _tag: 'Success', value: 42 })
    expect(await ResultTask.runExit(failureTask)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'not-found' },
    })
  })

  it('preserves Promise constructor rejections as defects', async () => {
    const defect = new Error('raw promise rejection')
    const task = new InternalPromiseTask(Promise.reject<Result<never, never>>(defect))

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Die', defect },
    })
  })

  it('interrupts a Promise constructor input aborted before its result resolves', async () => {
    const controller = new AbortController()
    const task = new InternalPromiseTask(
      new Promise<Result<number, string>>((resolve) => {
        setImmediate(() => {
          controller.abort('promise-interrupted')
          resolve(err('superseded'))
        })
      }),
    )

    expect(await ResultTask.runExit(task, { signal: controller.signal })).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'promise-interrupted' },
    })
  })

  it('applies continuations to synchronous Custom instruction results', async () => {
    let executions = 0
    const task = new InternalCustomTask<number, never>({
      _tag: 'Custom',
      execute: () => {
        executions += 1
        return { _tag: 'Success', value: 21 }
      },
    })

    expect(await ResultTask.runExit(task.map((value) => value * 2))).toEqual({
      _tag: 'Success',
      value: 42,
    })
    expect(executions).toBe(1)
  })

  it('applies continuations to asynchronous Custom instruction results', async () => {
    const task = new InternalCustomTask<number, string>({
      _tag: 'Custom',
      execute: () => Promise.resolve({ _tag: 'Failure', cause: { _tag: 'Fail', error: 'raw' } }),
    })

    expect(await ResultTask.runExit(task.mapErr((error) => `mapped:${error}`))).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'mapped:raw' },
    })
  })

  it('collects only actual validation errors when earlier items succeeded', async () => {
    const task = ResultTask.validateAll([0, 1, 2, 3], (value) =>
      value % 2 === 0 ? ResultTask.ok(value) : ResultTask.err(`invalid:${value}`),
    )

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: ['invalid:1', 'invalid:3'] },
    })
  })

  it('logs the original success and error in separate callback arguments', async () => {
    const calls: [number | undefined, string | undefined][] = []
    const log = (value: number | undefined, error: string | undefined): void => {
      calls.push([value, error])
    }
    const successTask = ResultTask.ok<number, string>(42).log(log)
    const failureTask = ResultTask.err<number, string>('missing').log(log)

    expect(calls).toEqual([])
    expect(await ResultTask.runExit(successTask)).toEqual({ _tag: 'Success', value: 42 })
    expect(await ResultTask.runExit(failureTask)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'missing' },
    })
    expect(calls).toEqual([
      [42, undefined],
      [undefined, 'missing'],
    ])
  })

  it('selects only the matching fluent if branch when executed', async () => {
    const calls: string[] = []
    const branch = (value: number) =>
      ResultTask.ok(value)
        .if((current) => {
          calls.push(`predicate:${current}`)
          return current > 0
        })
        .true((current) => {
          calls.push(`true:${current}`)
          return ok(current + 10)
        })
        .false((current) => {
          calls.push(`false:${current}`)
          return ResultTask.err(`negative:${current}`)
        })
    const positive = branch(2)
    const negative = branch(-2)

    expect(calls).toEqual([])
    expect(await ResultTask.runExit(positive)).toEqual({ _tag: 'Success', value: 12 })
    expect(await ResultTask.runExit(negative)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'negative:-2' },
    })
    expect(calls).toEqual(['predicate:2', 'true:2', 'predicate:-2', 'false:-2'])
  })

  it('preserves upstream failures without invoking fluent if callbacks', async () => {
    let calls = 0
    const task = ResultTask.err<number, string>('upstream')
      .if(() => {
        calls += 1
        return true
      })
      .true(() => {
        calls += 1
        return ok(1)
      })
      .false(() => {
        calls += 1
        return ok(2)
      })

    expect(await ResultTask.runExit(task)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'upstream' },
    })
    expect(calls).toBe(0)
  })

  it('maps errors through direct and curried static mapErr', async () => {
    const task = ResultTask.err('missing')
    const direct = ResultTask.mapErr(task, (error) => error.length)
    const curried = task.pipe(ResultTask.mapErr((error: string) => `mapped:${error}`))

    expect(await ResultTask.runExit(direct)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 7 },
    })
    expect(await ResultTask.runExit(curried)).toEqual({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: 'mapped:missing' },
    })
  })

  it('executes uninterruptible synchronous retries in the synchronous retry loop', async () => {
    let attempts = 0
    const task = ResultTask.ok(0)
      .flatMap(() => {
        attempts += 1
        return attempts < 3 ? ResultTask.err('retry') : ResultTask.ok(attempts)
      })
      .retry({ times: 2 })

    const pending = ResultTask.runExit(task)
    expect(attempts).toBe(3)
    expect(await pending).toEqual({ _tag: 'Success', value: 3 })
  })
})
