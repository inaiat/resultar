import { deepEqual, equal, throws } from 'node:assert'

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
    deepEqual(await failedGate.complete(ResultTask.fail('Bad' as const)).runResult(), ok(true))
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
})
