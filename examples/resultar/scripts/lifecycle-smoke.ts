import { deepEqual, equal, fail } from 'node:assert/strict'
import { ResultTask } from 'resultar'

import {
  applicationLifecycle,
  DatabaseLifecycleError,
  HttpLifecycleError,
  type ApplicationFactories,
} from '../src/application-lifecycle.js'

const fixture = (failSchema = false, failDatabaseClose = false) => {
  const events: string[] = []
  const stop = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const factories: ApplicationFactories = {
    connectDatabase: () =>
      ResultTask.sync(() => {
        events.push('connect database')
        return {
          ensureSchema: () =>
            ResultTask.gen(function* () {
              events.push('schema')
              if (failSchema)
                yield* ResultTask.fail(new DatabaseLifecycleError({ operation: 'schema' }))
            }),
          close: () =>
            ResultTask.gen(function* () {
              events.push('close database')
              if (failDatabaseClose)
                yield* ResultTask.fail(new DatabaseLifecycleError({ operation: 'close' }))
            }),
        }
      }),
    connectWhatsApp: () =>
      ResultTask.sync(() => {
        events.push('connect WhatsApp')
        return {
          close: () =>
            ResultTask.sync(() => {
              events.push('close WhatsApp')
            }),
        }
      }),
    serve: () =>
      ResultTask.sync(() => {
        events.push('serve')
        return {
          stopAndDrain: () =>
            ResultTask.sync(() => {
              events.push('drain HTTP')
            }),
        }
      }),
    // Promise is confined to the external event adapter, not the application contract.
    waitForShutdown: () =>
      ResultTask.tryPromise({
        try: () => {
          ready.resolve()
          return stop.promise
        },
        catch: (cause) => new HttpLifecycleError({ operation: 'wait for shutdown', cause }),
      }),
  }
  return { events, factories, stop, ready }
}

const live = fixture()
const task = applicationLifecycle(live.factories)
deepEqual(live.events, [])
const running = ResultTask.runExit(task)
await live.ready.promise
deepEqual(live.events, ['connect database', 'schema', 'connect WhatsApp', 'serve'])
live.stop.resolve()
deepEqual(await running, { _tag: 'Success', value: undefined })
deepEqual(live.events, [
  'connect database',
  'schema',
  'connect WhatsApp',
  'serve',
  'drain HTTP',
  'close WhatsApp',
  'close database',
])

const rollback = fixture(true, true)
const exit = await ResultTask.runExit(applicationLifecycle(rollback.factories))
deepEqual(rollback.events, ['connect database', 'schema', 'close database'])
if (exit._tag !== 'Failure' || exit.cause._tag !== 'Sequential') {
  fail('Expected boot and rollback failures')
}
equal(exit.cause.left._tag, 'Fail')
equal(exit.cause.right._tag, 'Fail')
process.stdout.write('ResultTask application lifecycle smoke passed.\n')
