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
      return yield* ResultTask.fail('CardDeclined' as const)
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
