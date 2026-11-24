import { deepEqual, equal, ok as assertOk } from 'node:assert'

import { describe, it } from 'vite-plus/test'

import { Cause, Clock, Fiber, ok, ResultTask, TaskLocal, Tracer } from '../src/index.js'

describe('TaskLocal and opt-in span tracing', () => {
  it('reads defaults, updates fiber state, and restores scoped locally bindings', () => {
    const RequestId = TaskLocal.make<string>('none', 'RequestId')

    const program = ResultTask.gen(function* () {
      const initial = yield* RequestId.get()
      yield* RequestId.set('root-1')
      const inside = yield* RequestId.locally(
        'scoped-2',
        ResultTask.gen(function* () {
          const seen = yield* RequestId.get()
          yield* RequestId.update((value) => `${value}!`)
          const updated = yield* RequestId.get()
          return { seen, updated }
        }),
      )
      const after = yield* RequestId.get()
      const transformed = yield* RequestId.get().pipe(
        RequestId.locallyWith((value) => `${value}:child`),
      )
      return { initial, inside, after, transformed }
    })

    deepEqual(
      program.runSync(),
      ok({
        initial: 'none',
        inside: { seen: 'scoped-2', updated: 'scoped-2!' },
        after: 'root-1',
        transformed: 'root-1:child',
      }),
    )

    // Subsequent runs must not see previous run's set values (idle context isolation).
    deepEqual(RequestId.get().runSync(), ok('none'))
  })

  it('inherits TaskLocal values across forkChild without leaking child mutations back', async () => {
    const Tenant = TaskLocal.make<string>('default')

    const program = ResultTask.gen(function* () {
      yield* Tenant.set('acme')
      const child = yield* ResultTask.gen(function* () {
        const inherited = yield* Tenant.get()
        yield* Tenant.set('child-only')
        const mutated = yield* Tenant.get()
        return { inherited, mutated }
      }).forkChild()
      yield* Tenant.set('parent-updated')
      const childResult = yield* Fiber.join(child)
      const parentAfter = yield* Tenant.get()
      return { childResult, parentAfter }
    }).scoped()

    deepEqual(
      await program.runResult(),
      ok({
        childResult: { inherited: 'acme', mutated: 'child-only' },
        parentAfter: 'parent-updated',
      }),
    )
  })

  it('isolates TaskLocal per item across ResultTask.all workers for concurrency 1 and 2', async () => {
    const Scope = TaskLocal.make<string>('root', 'Scope')
    const writeItem = (label: string, delayMs: number) =>
      ResultTask.gen(function* () {
        yield* Scope.set(label)
        yield* ResultTask.sleep(delayMs)
        return yield* Scope.get()
      })
    const readItem = () =>
      ResultTask.gen(function* () {
        yield* ResultTask.sleep(0)
        return yield* Scope.get()
      })

    for (const concurrency of [1, 2] as const) {
      const program = ResultTask.gen(function* () {
        const defaultValues = yield* ResultTask.all(
          [writeItem('A', 0), writeItem('B', 0), readItem(), readItem(), readItem()],
          { concurrency },
        )
        const parentDefault = yield* Scope.get()

        yield* Scope.set('parent')
        const inheritedValues = yield* ResultTask.all(
          [writeItem('X', 0), writeItem('Y', 0), readItem(), readItem()],
          { concurrency },
        )
        const parentAfter = yield* Scope.get()

        return { defaultValues, parentDefault, inheritedValues, parentAfter }
      })

      // eslint-disable-next-line no-await-in-loop
      deepEqual(
        await program.runResult(),
        ok({
          defaultValues: ['A', 'B', 'root', 'root', 'root'],
          parentDefault: 'root',
          inheritedValues: ['X', 'Y', 'parent', 'parent'],
          parentAfter: 'parent',
        }),
      )
    }
  })

  it('preserves worker scheduling budget during ResultTask.forEach when inheriting TaskLocal', async () => {
    const Scope = TaskLocal.make<string>('root', 'Scope')
    const items = Array.from({ length: 1000 }, (_value, index) => index)

    const runCollection = async (withInheritedLocal: boolean) => {
      const controller = new AbortController()
      let executed = 0
      let yields = 0
      const scheduler = {
        yield: () => {
          yields += 1
          controller.abort('scheduler-stop')
          return Promise.resolve()
        },
      }
      // eslint-disable-next-line unicorn/no-array-for-each -- ResultTask.forEach is not Array#forEach.
      const collection = ResultTask.forEach(
        items,
        (item) =>
          ResultTask.sync(() => {
            executed += 1
            return item
          }),
        { concurrency: 1 },
      )
      const program = withInheritedLocal ? Scope.locally('inherited', collection) : collection
      const exit = await ResultTask.runExit(program, {
        scheduler,
        yieldEvery: 16,
        signal: controller.signal,
      })
      return { exit, executed, yields }
    }

    const withoutLocal = await runCollection(false)
    const withLocal = await runCollection(true)

    deepEqual(withoutLocal.exit, {
      _tag: 'Failure',
      cause: { _tag: 'Interrupt', reason: 'scheduler-stop' },
    })
    deepEqual(withLocal.exit, withoutLocal.exit)
    equal(withoutLocal.yields, 1)
    equal(withLocal.yields, 1)
    equal(withoutLocal.executed, 15)
    equal(withLocal.executed, withoutLocal.executed)
  })

  it('records nested spans, attributes, parent links, and virtual-clock durations via Tracer.memory', async () => {
    const clock = Clock.virtual(100)
    const memory = Tracer.memory()

    const fetchUser = ResultTask.fn('users.fetch', function* (id: string) {
      yield* ResultTask.sleep(25)
      return { id, name: 'Ada' }
    })

    const handleRequest = ResultTask.fn(
      'http.getUser',
      function* (id: string) {
        const child = yield* fetchUser(id).withSpan('cache.miss', { userId: id }).forkChild()
        return yield* Fiber.join(child)
      },
      (task) => task.scoped(),
    )

    const running = handleRequest('u-1').runExit({ clock, tracer: memory.tracer })
    await clock.advanceBy(25)
    const exit = await running

    deepEqual(exit, { _tag: 'Success', value: { id: 'u-1', name: 'Ada' } })
    equal(memory.spans.length, 3)

    const [root, cacheMiss, fetch] = memory.spans
    equal(root?.name, 'http.getUser')
    equal(root?.parentName, undefined)
    equal(root?.durationMs, 25)
    equal(cacheMiss?.name, 'cache.miss')
    equal(cacheMiss?.parentName, 'http.getUser')
    deepEqual(cacheMiss?.attributes, { userId: 'u-1' })
    equal(fetch?.name, 'users.fetch')
    equal(fetch?.parentName, 'cache.miss')
    equal(fetch?.startTime, 100)
    equal(fetch?.endTime, 125)
  })

  it('attaches logical span traces to failures even without an active tracer', () => {
    const charge = ResultTask.fn('payments.charge', function* () {
      return yield* ResultTask.err('CardDeclined' as const)
    })
    const checkout = ResultTask.fn('checkout.submit', function* (orderId: string) {
      return yield* charge().withSpan('stripe.request', { orderId })
    })

    const exit = checkout('ord-9').runSyncExit()
    equal(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      const frames = Cause.spans(exit.cause)
      deepEqual(
        frames.map((frame) => frame.name),
        ['payments.charge', 'stripe.request', 'checkout.submit'],
      )
      const pretty = Cause.pretty(exit.cause)
      assertOk(pretty.includes('Fail: CardDeclined'))
      assertOk(pretty.includes('Span trace:'))
      assertOk(pretty.includes('at payments.charge'))
      assertOk(pretty.includes('at stripe.request (orderId="ord-9")'))
      assertOk(pretty.includes('at checkout.submit'))
    }
  })

  it('retains spans attached to intermediate composite causes on the traced branch', () => {
    const inner = ResultTask.err(Cause.sequential(Cause.fail('a'), Cause.fail('b')))
      .unsandbox()
      .withSpan('inner')
      .runSyncExit()
    assertOk(inner._tag === 'Failure')
    for (const tree of [
      Cause.parallel(inner.cause, Cause.fail('c')),
      Cause.parallel(Cause.fail('c'), inner.cause),
    ]) {
      const outer = ResultTask.err(tree).unsandbox().withSpan('outer').runSyncExit()
      assertOk(outer._tag === 'Failure')
      deepEqual(
        Cause.spans(outer.cause).map((frame) => frame.name),
        ['inner', 'outer'],
      )
    }
  })

  it('keeps failure spans through unmatched nested reason handlers and error mapping', () => {
    type Problem = { _tag: 'Outer'; reason: { _tag: 'Missing' } | { _tag: 'Other' } }
    const failure: Problem = { _tag: 'Outer', reason: { _tag: 'Missing' } }
    const task = ResultTask.err<Problem>(failure)
      .withSpan('inner')
      .mapErr((error) => error)
      .catchReason('Outer', 'Other', () => ok(1))
      .catchReasons('Outer', {})
      .tapCause(() => undefined)
      .withSpan('outer')
    const exit = task.runSyncExit()
    assertOk(exit._tag === 'Failure')
    deepEqual(
      Cause.spans(exit.cause).map((frame) => frame.name),
      ['inner', 'outer'],
    )
    deepEqual(task.catchCause(() => ok(3)).runSync(), ok(3))
  })

  it('isolates broken tracer hooks and supports Tracer.noop cleanly', () => {
    const brokenTracer = {
      startSpan: () => {
        throw new Error('exporter offline')
      },
    }
    const task = ResultTask.ok('safe').withSpan('op')
    deepEqual(task.runSync({ tracer: brokenTracer }), ok('safe'))
    deepEqual(task.runSync({ tracer: Tracer.noop }), ok('safe'))
  })
})

it('records the interrupted exit when a leaf aborts before the span ends', async () => {
  for (const asyncLeaf of [false, true]) {
    const controller = new AbortController()
    const memory = Tracer.memory()
    const read = () => {
      controller.abort('stop')
      return 1
    }
    const task = asyncLeaf
      ? ResultTask.fromPromise(() => Promise.resolve(read()))
      : ResultTask.sync(read)
    const exit = await task
      .withSpan('read')
      .runExit({ signal: controller.signal, tracer: memory.tracer })
    assertOk(exit._tag === 'Failure')
    deepEqual(exit.cause, Cause.interrupt('stop'))
    deepEqual(memory.spans[0]?.exit, exit)
    deepEqual(
      Cause.spans(exit.cause).map((span) => span.name),
      ['read'],
    )
  }
})

it('preserves traced errors when unwrapping a reason, including composite failures', () => {
  const problem = { _tag: 'Outer', reason: { _tag: 'Only' } } as const
  const failure = ResultTask.err(problem)
  const exit = failure
    .ensuring(() => failure)
    .withSpan('load')
    .unwrapReason('Outer')
    .runSyncExit()
  assertOk(exit._tag === 'Failure')
  deepEqual(Cause.failures(exit.cause), [problem.reason, problem.reason])
  deepEqual(
    Cause.spans(exit.cause).map((span) => span.name),
    ['load'],
  )
})

it('covers TaskLocal curried/data-first forms, validation errors, and Tracer.memory helpers', () => {
  const Local = TaskLocal.make<string>('default')

  // Curried locally and data-first locallyWith
  deepEqual(Local.locally('curried')(Local.get()).runSync(), ok('curried'))
  deepEqual(
    Local.locallyWith((current) => `${current}-next`, Local.get()).runSync(),
    ok('default-next'),
  )

  // Runtime validation when a non-ResultTask is passed
  let threw = 0
  for (const call of [
    () => (Local.locally('x') as unknown as (t: unknown) => unknown)('bad'),
    () => (Local.locally as unknown as (v: string, t: unknown) => unknown)('x', 'bad'),
    () => (Local.locallyWith((v) => v) as unknown as (t: unknown) => unknown)('bad'),
    () =>
      (Local.locallyWith as unknown as (fn: (v: string) => string, t: unknown) => unknown)(
        (v) => v,
        'bad',
      ),
  ]) {
    try {
      call()
    } catch (error) {
      if (error instanceof TypeError) threw += 1
    }
  }
  equal(threw, 4)

  // Tracer.memory setAttribute, end without endTime, undefined attributes, and clear
  const memory = Tracer.memory()
  const span = memory.startSpan('manual', {
    startTime: 10,
    attributes: { kept: 'yes', dropped: undefined },
  })
  span.setAttribute?.('dynamic', 123)
  span.end({ _tag: 'Success', value: 'ok' })
  equal(memory.spans.length, 1)
  deepEqual(memory.spans[0]?.attributes, { kept: 'yes', dynamic: 123 })
  equal(memory.spans[0]?.endTime, undefined)
  equal(memory.spans[0]?.durationMs, undefined)
  memory.clear()
  equal(memory.spans.length, 0)
})

it('handles TaskLocal.set and TaskLocal.update safely when context.locals is undefined', async () => {
  const { NEVER_ABORTED_SIGNAL } = await import('../src/task/exit.js')
  const { TaskScope } = await import('../src/task/scope.js')
  const { runRuntimeTask } = await import('../src/task/task-runtime-bridge.js')
  const { createScheduling } = await import('../src/task/task-scheduler.js')
  const Local = TaskLocal.make<string>('fallback')
  const minimalContext = {
    clock: Clock.live,
    scheduling: createScheduling(Clock.live),
    scope: new TaskScope(),
    services: new Map(),
    namedServices: new Map<string, unknown>(),
    serviceResolver: undefined,
    cleanup: undefined,
    signal: NEVER_ABORTED_SIGNAL,
    locals: undefined,
  }
  deepEqual(runRuntimeTask(ResultTask, Local.set('ignored'), minimalContext), {
    _tag: 'Success',
    value: undefined,
  })
  deepEqual(
    runRuntimeTask(
      ResultTask,
      Local.update((v) => `${v}!`),
      minimalContext,
    ),
    { _tag: 'Success', value: undefined },
  )
})
