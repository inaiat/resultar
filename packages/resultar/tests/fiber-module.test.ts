import { equal } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Fiber } from '../src/task/fiber.js'
import type { Fiber as FiberHandle } from '../src/task/fiber.js'
import { Fiber as PublicFiber } from '../src/index.js'
import type { Fiber as PublicFiberHandle } from '../src/index.js'
import { Fiber as TaskFiber } from '../src/task/result-task.js'
import type { Fiber as TaskFiberHandle } from '../src/task/result-task.js'

describe('Fiber module', () => {
  it('exports the same namespace and types through each existing entrypoint', () => {
    equal(Fiber, TaskFiber)
    equal(Fiber, PublicFiber)
    equal(Object.isFrozen(Fiber), true)
    expectTypeOf<FiberHandle<number, 'failure'>>().toEqualTypeOf<
      TaskFiberHandle<number, 'failure'>
    >()
    expectTypeOf<FiberHandle<number, 'failure'>>().toEqualTypeOf<
      PublicFiberHandle<number, 'failure'>
    >()
  })

  it('initializes correctly when the Fiber module is imported first', () => {
    const fiberUrl = new URL('../src/task/fiber.ts', import.meta.url).href
    const taskUrl = new URL('../src/task/result-task.ts', import.meta.url).href
    const indexUrl = new URL('../src/index.ts', import.meta.url).href
    const script = `
      import { deepEqual, equal } from 'node:assert/strict';
      const { Fiber } = await import(${JSON.stringify(fiberUrl)});
      const { Fiber: TaskFiber, ResultTask } = await import(${JSON.stringify(taskUrl)});
      const { Fiber: PublicFiber } = await import(${JSON.stringify(indexUrl)});
      equal(Fiber, TaskFiber);
      equal(Fiber, PublicFiber);
      const program = ResultTask.gen(function* () {
        const fiber = yield* ResultTask.forkChild(ResultTask.err('child-failure'));
        return yield* Fiber.await(fiber);
      });
      deepEqual(await ResultTask.runPromise(program), {
        _tag: 'Failure',
        cause: { _tag: 'Fail', error: 'child-failure' },
      });
    `
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type', 'module', '--eval', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 },
    )
    equal(output, '')
  })
})
