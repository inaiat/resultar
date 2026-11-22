import { deepEqual, equal, notStrictEqual, throws } from 'node:assert'
import v8 from 'node:v8'
import vm from 'node:vm'

import { describe, it } from 'vite-plus/test'

import { Cause, Clock, Deferred, err, Fiber, ok, Queue, Ref, ResultTask } from '../src/index.js'

describe('Ref, Deferred, and Queue concurrency primitives', () => {
  it('supports synchronous atomic operations on Ref', () => {
    const counter = Ref.make(10)

    const workflow = ResultTask.gen(function* () {
      yield* counter.update((n) => n + 5)
      const prev = yield* counter.getAndUpdate((n) => n * 2)
      const next = yield* counter.updateAndGet((n) => n + 1)
      const old = yield* counter.getAndSet(100)
      const computed = yield* counter.modify((n) => [`was-${n}`, n + 23] as const)
      const finalValue = yield* counter.get()
      return { prev, next, old, computed, finalValue }
    })

    deepEqual(
      workflow.runSync(),
      ok({ prev: 15, next: 31, old: 31, computed: 'was-100', finalValue: 123 }),
    )
  })

  it('coordinates fibers via Deferred with one-shot semantics and waiter cancellation', async () => {
    const clock = Clock.virtual(0)
    const gate = Deferred.make<string, 'GateFailed'>()

    deepEqual(gate.isDone().runSync(), ok(false))
    deepEqual(gate.poll().runSync(), ok(undefined))

    const program = ResultTask.gen(function* () {
      const w1 = yield* gate.await().forkChild()
      const w2 = yield* gate
        .await()
        .timeout(10, () => 'timed-out' as const)
        .forkChild()
      yield* ResultTask.sleep(20)
      const firstComplete = yield* gate.succeed('opened')
      const secondComplete = yield* gate.succeed('ignored')
      const r1 = yield* Fiber.join(w1)
      const r2 = yield* w2.await()
      return { firstComplete, secondComplete, r1, r2 }
    }).scoped()

    const exit = await clock.runToCompletion(program)
    deepEqual(exit, {
      _tag: 'Success',
      value: {
        firstComplete: true,
        secondComplete: false,
        r1: 'opened',
        r2: { _tag: 'Failure', cause: Cause.fail('timed-out') },
      },
    })
    deepEqual(gate.isDone().runSync(), ok(true))
    deepEqual(gate.await().runSync(), ok('opened'))

    const failedGate = Deferred.make<number, 'Bad'>()
    deepEqual(await failedGate.complete(ResultTask.err('Bad' as const)).runResult(), ok(true))
    deepEqual(failedGate.await().runSync(), err('Bad'))
  })

  it('enforces bounded FIFO backpressure and graceful shutdown drain on Queue', async () => {
    const queue = Queue.bounded<string>(2)
    equal(queue.capacity, 2)

    throws(() => Queue.bounded(0), RangeError)
    throws(() => queue.takeUpTo(-1), RangeError)

    const program = ResultTask.gen(function* () {
      const a = yield* queue.offer('one')
      const b = yield* queue.offer('two')
      const blockedProducer = yield* queue.offer('three').forkChild()
      const first = yield* queue.take()
      const thirdAccepted = yield* Fiber.join(blockedProducer)
      const remaining = yield* queue.takeAll()
      return { a, b, first, thirdAccepted, remaining }
    }).scoped()

    deepEqual(
      await program.runResult(),
      ok({ a: true, b: true, first: 'one', thirdAccepted: true, remaining: ['two', 'three'] }),
    )
  })

  it('drains buffered items after Queue.shutdown and interrupts empty takers', async () => {
    const queue = Queue.unbounded<number>()
    equal(queue.capacity, Infinity)

    deepEqual(await queue.offerAll([1, 2, 3]).runResult(), ok(true))
    deepEqual(queue.size().runSync(), ok(3))
    deepEqual(queue.takeUpTo(2).runSync(), ok([1, 2]))
    deepEqual(queue.shutdown().runSync(), ok(undefined))
    deepEqual(queue.isShutdown().runSync(), ok(true))
    deepEqual(queue.offer(4).runSync(), ok(false))
    // Buffered item 3 is still drained losslessly
    deepEqual(queue.take().runSync(), ok(3))
    // Once drained and shut down, take interrupts cleanly
    const afterEmpty = queue.take().runSyncExit()
    equal(afterEmpty._tag, 'Failure')
    if (afterEmpty._tag === 'Failure') {
      equal(Cause.isInterruptedOnly(afterEmpty.cause), true)
    }

    // Blocked taker on an empty queue is interrupted immediately on shutdown
    const emptyQueue = Queue.bounded<string>(1)
    const shutdownTest = ResultTask.gen(function* () {
      const taker = yield* emptyQueue.take().forkChild()
      yield* ResultTask.sleep(0)
      yield* emptyQueue.shutdown()
      return yield* taker.await()
    }).scoped()

    const takerExit = await shutdownTest.runPromise()
    equal(takerExit._tag, 'Failure')
    if (takerExit._tag === 'Failure') {
      equal(Cause.isInterruptedOnly(takerExit.cause), true)
    }
  })

  it('cancels blocked offer without losing items when aborted', async () => {
    const clock = Clock.virtual(0)
    const queue = Queue.bounded<string>(1)

    const program = ResultTask.gen(function* () {
      yield* queue.offer('first')
      const abortedOffer = yield* queue
        .offer('dropped')
        .timeout(10, () => 'offer-timeout' as const)
        .forkChild()
      yield* ResultTask.sleep(15)
      const offerOutcome = yield* abortedOffer.await()
      const first = yield* queue.poll()
      const second = yield* queue.poll()
      return { offerOutcome, first, second }
    }).scoped()

    const exit = await clock.runToCompletion(program)
    deepEqual(exit, {
      _tag: 'Success',
      value: {
        offerOutcome: { _tag: 'Failure', cause: Cause.fail('offer-timeout') },
        first: 'first',
        second: undefined,
      },
    })
  })

  it('assigns distinct shutdown interrupt causes and isolated span traces across queues and consumers', async () => {
    // 1. Two separate shut-down queues
    const q1 = Queue.bounded<string>(1)
    const q2 = Queue.bounded<string>(1)
    await q1.shutdown().runPromise()
    await q2.shutdown().runPromise()

    const alphaExit = await q1.take().withSpan('alpha', { queue: 'q1' }).runExit()
    const betaExit = await q2.take().withSpan('beta', { queue: 'q2' }).runExit()

    equal(alphaExit._tag, 'Failure')
    equal(betaExit._tag, 'Failure')
    if (alphaExit._tag === 'Failure' && betaExit._tag === 'Failure') {
      notStrictEqual(alphaExit.cause, betaExit.cause)
      deepEqual(alphaExit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(betaExit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(Cause.spans(betaExit.cause), [{ name: 'beta', attributes: { queue: 'q2' } }])
      // Re-read first trace AFTER second run to confirm no cross-contamination
      deepEqual(Cause.spans(alphaExit.cause), [{ name: 'alpha', attributes: { queue: 'q1' } }])
    }

    // 2. Two blocked consumers on the SAME queue woken by a single shutdown()
    const shared = Queue.bounded<string>(1)
    const both = await ResultTask.gen(function* () {
      const c1 = yield* shared.take().withSpan('consumer.one', { consumer: 1 }).forkChild()
      const c2 = yield* shared.take().withSpan('consumer.two', { consumer: 2 }).forkChild()
      yield* ResultTask.sleep(0)
      yield* shared.shutdown()
      return [yield* c1.await(), yield* c2.await()] as const
    })
      .scoped()
      .runPromise()

    const [firstConsumerExit, secondConsumerExit] = both
    equal(firstConsumerExit._tag, 'Failure')
    equal(secondConsumerExit._tag, 'Failure')
    if (firstConsumerExit._tag === 'Failure' && secondConsumerExit._tag === 'Failure') {
      notStrictEqual(firstConsumerExit.cause, secondConsumerExit.cause)
      deepEqual(firstConsumerExit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(secondConsumerExit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(Cause.spans(secondConsumerExit.cause), [
        { name: 'consumer.two', attributes: { consumer: 2 } },
      ])
      deepEqual(Cause.spans(firstConsumerExit.cause), [
        { name: 'consumer.one', attributes: { consumer: 1 } },
      ])
    }
  })

  it('preserves FIFO order and backpressure across interleaved active and cancelled offers', async () => {
    const queue = Queue.bounded<string>(1)
    await queue.offer('seed').runPromise()

    const cCancel1 = new AbortController()
    const cActive1 = new AbortController()
    const cCancel2 = new AbortController()
    const cActive2 = new AbortController()

    const oCancel1 = queue.offer('cancel-1').runExit({ signal: cCancel1.signal })
    const oActive1 = queue.offer('active-1').runExit({ signal: cActive1.signal })
    const oCancel2 = queue.offer('cancel-2').runExit({ signal: cCancel2.signal })
    const oActive2 = queue.offer('active-2').runExit({ signal: cActive2.signal })

    await Promise.resolve()
    cCancel1.abort('drop-1')
    cCancel2.abort('drop-2')

    equal((await oCancel1)._tag, 'Failure')
    equal((await oCancel2)._tag, 'Failure')
    deepEqual(queue.size().runSync(), ok(1))

    deepEqual(queue.take().runSync(), ok('seed'))
    deepEqual(await oActive1, { _tag: 'Success', value: true })
    deepEqual(queue.take().runSync(), ok('active-1'))
    deepEqual(await oActive2, { _tag: 'Success', value: true })
    deepEqual(queue.take().runSync(), ok('active-2'))
    deepEqual(queue.size().runSync(), ok(0))
  })

  it('preserves FIFO order across interleaved active and cancelled takers', async () => {
    const queue = Queue.bounded<string>(1)
    const tCancel1 = new AbortController()
    const tActive1 = new AbortController()
    const tCancel2 = new AbortController()
    const tActive2 = new AbortController()

    const pCancel1 = queue.take().runExit({ signal: tCancel1.signal })
    const pActive1 = queue.take().runExit({ signal: tActive1.signal })
    const pCancel2 = queue.take().runExit({ signal: tCancel2.signal })
    const pActive2 = queue.take().runExit({ signal: tActive2.signal })

    await Promise.resolve()
    tCancel1.abort('t-drop-1')
    tCancel2.abort('t-drop-2')

    equal((await pCancel1)._tag, 'Failure')
    equal((await pCancel2)._tag, 'Failure')

    deepEqual(queue.offer('msg-1').runSync(), ok(true))
    deepEqual(queue.offer('msg-2').runSync(), ok(true))

    deepEqual(await pActive1, { _tag: 'Success', value: 'msg-1' })
    deepEqual(await pActive2, { _tag: 'Success', value: 'msg-2' })
    deepEqual(queue.size().runSync(), ok(0))
  })

  it('releases cancelled offer payloads and cancelled taker references without draining or shutting down', async () => {
    v8.setFlagsFromString('--expose-gc')
    const runGc = vm.runInNewContext('gc') as () => void

    const forceGc = async (): Promise<void> => {
      for (let round = 0; round < 5; round += 1) {
        runGc()
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5)
        })
      }
    }

    // 1. Full queue: cancelled offer payload must be collectable while queue stays full and open
    const fullQueue = Queue.bounded<object>(1)
    await fullQueue.offer({ role: 'filler' }).runPromise()

    const offerRef = await (async (): Promise<WeakRef<object>> => {
      const payload = { marker: 'cancelled-offer-payload', data: new Uint8Array(4096) }
      const ref = new WeakRef(payload)
      const controller = new AbortController()
      const pending = fullQueue.offer(payload).runExit({ signal: controller.signal })
      await Promise.resolve()
      controller.abort('cancel-offer')
      const exit = await pending
      equal(exit._tag, 'Failure')
      return ref
    })()

    await forceGc()
    equal(offerRef.deref(), undefined)
    // Queue is still full and open (never drained or shut down)
    deepEqual(fullQueue.size().runSync(), ok(1))
    deepEqual(fullQueue.isShutdown().runSync(), ok(false))

    // 2. Empty queue: cancelled taker signal/closure must be collectable while queue stays empty and open
    const emptyQueue = Queue.bounded<string>(1)

    const takerRef = await (async (): Promise<WeakRef<AbortController>> => {
      const controller = new AbortController()
      const ref = new WeakRef(controller)
      const pending = emptyQueue.take().runExit({ signal: controller.signal })
      await Promise.resolve()
      controller.abort('cancel-taker')
      const exit = await pending
      equal(exit._tag, 'Failure')
      return ref
    })()

    await forceGc()
    equal(takerRef.deref(), undefined)
    deepEqual(emptyQueue.size().runSync(), ok(0))
    deepEqual(emptyQueue.isShutdown().runSync(), ok(false))
  })

  it('interrupts async waiters and pending map continuations when runSync or runSyncExit encounters async work', async () => {
    for (const mode of ['runSync', 'runSyncExit'] as const) {
      const queue = Queue.bounded<string>(2)
      let queueMapCalls = 0
      const takeAndMap = queue.take().map((value) => {
        queueMapCalls += 1
        return value.toUpperCase()
      })
      throws(
        () => (mode === 'runSync' ? takeAndMap.runSync() : takeAndMap.runSyncExit()),
        /cannot execute an asynchronous task/u,
      )
      deepEqual(queue.offer('kept').runSync(), ok(true))
      deepEqual(queue.poll().runSync(), ok('kept'))
      equal(queueMapCalls, 0)

      let promiseMapCalls = 0
      const asyncMapped = ResultTask.tryPromise({
        try: () =>
          new Promise<number>((resolve) => {
            setTimeout(() => {
              resolve(21)
            }, 10)
          }),
        catch: String,
      }).map((value) => {
        promiseMapCalls += 1
        return value * 2
      })
      throws(
        () => (mode === 'runSync' ? asyncMapped.runSync() : asyncMapped.runSyncExit()),
        /cannot execute an asynchronous task/u,
      )
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30)
      })
      equal(promiseMapCalls, 0)
    }
  })

  it('keeps Queue.bounded storage bounded across 310,000 non-empty cycles while preserving FIFO order', () => {
    const queue = Queue.bounded<number>(2)
    deepEqual(queue.offer(0).runSync(), ok(true))
    deepEqual(queue.offer(1).runSync(), ok(true))

    v8.setFlagsFromString('--expose-gc')
    const runGc = vm.runInNewContext('gc') as () => void
    runGc()
    const heapBefore = process.memoryUsage().heapUsed

    const cycles = 310_000
    for (let index = 0; index < cycles; index += 1) {
      deepEqual(queue.take().runSync(), ok(index))
      deepEqual(queue.offer(index + 2).runSync(), ok(true))
    }

    runGc()
    const heapAfter = process.memoryUsage().heapUsed
    deepEqual(queue.size().runSync(), ok(2))
    deepEqual(queue.takeAll().runSync(), ok([cycles, cycles + 1]))
    // Ring buffer stays at O(capacity); heap delta must remain small (well under 8 MB).
    equal(heapAfter - heapBefore < 8 * 1024 * 1024, true)
  })

  it('isolates Deferred failure span traces per observer while preserving origin traces', async () => {
    // 1. Failure recorded outside any span: independent observers under A and B get isolated traces
    const gate = Deferred.make<number, 'boom'>()
    await gate.fail('boom').runPromise()

    const exitA = await gate.await().withSpan('A').runExit()
    const exitB = await gate.await().withSpan('B').runExit()
    equal(exitA._tag, 'Failure')
    equal(exitB._tag, 'Failure')
    if (exitA._tag === 'Failure' && exitB._tag === 'Failure') {
      notStrictEqual(exitA.cause, exitB.cause)
      deepEqual(
        Cause.spans(exitB.cause).map((frame) => frame.name),
        ['B'],
      )
      // Re-read first trace after second observation
      deepEqual(
        Cause.spans(exitA.cause).map((frame) => frame.name),
        ['A'],
      )
    }

    // 2. Concurrent waiters woken by a single fail() outside any span also get isolated traces
    const liveGate = Deferred.make<number, 'boom'>()
    const bothExits = await ResultTask.gen(function* () {
      const f1 = yield* liveGate.await().withSpan('waiter-A').forkChild()
      const f2 = yield* liveGate.await().withSpan('waiter-B').forkChild()
      yield* ResultTask.sleep(0)
      yield* liveGate.fail('boom')
      return [yield* f1.await(), yield* f2.await()] as const
    })
      .scoped()
      .runPromise()

    const [w1, w2] = bothExits
    equal(w1._tag, 'Failure')
    equal(w2._tag, 'Failure')
    if (w1._tag === 'Failure' && w2._tag === 'Failure') {
      deepEqual(
        Cause.spans(w2.cause).map((frame) => frame.name),
        ['waiter-B'],
      )
      deepEqual(
        Cause.spans(w1.cause).map((frame) => frame.name),
        ['waiter-A'],
      )
    }

    // 3. Failure that already carries an origin span trace preserves that origin trace
    const tracedGate = Deferred.make<number, 'origin-fail'>()
    await tracedGate
      .complete(ResultTask.err('origin-fail' as const).withSpan('origin'))
      .runPromise()
    const obs1 = await tracedGate.await().withSpan('A').runExit()
    const obs2 = await tracedGate.await().withSpan('B').runExit()
    equal(obs1._tag, 'Failure')
    equal(obs2._tag, 'Failure')
    if (obs1._tag === 'Failure' && obs2._tag === 'Failure') {
      deepEqual(
        Cause.spans(obs1.cause).map((frame) => frame.name),
        ['origin'],
      )
      deepEqual(
        Cause.spans(obs2.cause).map((frame) => frame.name),
        ['origin'],
      )
    }
  })

  it('snapshots mutable arrays in raceAll and raceFirstAll at construction time', async () => {
    const tasksForAll = [ResultTask.ok(42)]
    const racedAll = ResultTask.raceAll(tasksForAll)
    tasksForAll.length = 0
    deepEqual(await racedAll.runExit(), { _tag: 'Success', value: 42 })

    const tasksForFirst = [ResultTask.ok(42)]
    const racedFirst = ResultTask.raceFirstAll(tasksForFirst)
    tasksForFirst.length = 0
    deepEqual(await racedFirst.runExit(), { _tag: 'Success', value: 42 })
  })

  it('interrupts blocked producers on Queue.shutdown while rejecting subsequent offers with false', async () => {
    const queue = Queue.bounded<string>(1)
    deepEqual(queue.offer('buffered').runSync(), ok(true))

    const producerExits = await ResultTask.gen(function* () {
      const p1 = yield* queue.offer('blocked-1').withSpan('producer-1').forkChild()
      const p2 = yield* queue.offer('blocked-2').withSpan('producer-2').forkChild()
      yield* ResultTask.sleep(0)
      yield* queue.shutdown()
      return [yield* p1.await(), yield* p2.await()] as const
    })
      .scoped()
      .runPromise()

    const [p1Exit, p2Exit] = producerExits
    equal(p1Exit._tag, 'Failure')
    equal(p2Exit._tag, 'Failure')
    if (p1Exit._tag === 'Failure' && p2Exit._tag === 'Failure') {
      notStrictEqual(p1Exit.cause, p2Exit.cause)
      equal(Cause.isInterruptedOnly(p1Exit.cause), true)
      equal(Cause.isInterruptedOnly(p2Exit.cause), true)
      deepEqual(p1Exit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(p2Exit.cause, { _tag: 'Interrupt', reason: 'Queue shut down' })
      deepEqual(
        Cause.spans(p2Exit.cause).map((frame) => frame.name),
        ['producer-2'],
      )
      deepEqual(
        Cause.spans(p1Exit.cause).map((frame) => frame.name),
        ['producer-1'],
      )
    }

    // Subsequent offers after shutdown resolve with Success(false)
    deepEqual(queue.offer('after-shutdown').runSync(), ok(false))
    deepEqual(await queue.offerAll(['after-1', 'after-2']).runResult(), ok(false))
    // Already buffered item remains drainable
    deepEqual(queue.take().runSync(), ok('buffered'))
  })
})
