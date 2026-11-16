import { deepEqual, equal, ok } from 'node:assert/strict'
import { get } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ResultTask } from 'resultar'
import { nodeApplication, runNodeApplication, type NodeApplication } from '../src/node-lifecycle.js'
import { DatabaseLifecycleError, SessionLifecycleError } from '../src/application-lifecycle.js'

const fixture = (failure = false) => {
  const events: string[] = []
  const ready = Promise.withResolvers<number>()
  const options: NodeApplication = {
    drainMs: 25,
    ready: ready.resolve,
    handler: (request, response) => {
      if (request.url === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write('data: ready\n\n')
        response.once('close', () => events.push('close stream'))
      } else response.end('ready')
    },
    connections: {
      connectDatabase: () =>
        ResultTask.sync(() => {
          events.push('database')
          return {
            ensureSchema: () => ResultTask.ok(undefined),
            close: () =>
              ResultTask.sync(() => {
                events.push('close database')
              }).andThen(() =>
                failure
                  ? DatabaseLifecycleError.taskErr({ operation: 'close' })
                  : ResultTask.ok(undefined),
              ),
          }
        }),
      connectSession: () =>
        ResultTask.sync(() => {
          events.push('session')
          return {
            close: () =>
              ResultTask.sync(() => {
                events.push('close session')
              }),
          }
        }),
    },
  }
  return { events, ready, options }
}

if (process.argv.includes('--child')) {
  const app = fixture()
  const run = runNodeApplication({ ...app.options, ready: () => process.stdout.write('ready\n') })
  const exit = await run.done
  equal(exit._tag, 'Failure')
  equal(process.listenerCount('SIGTERM'), 0)
  equal(process.listenerCount('SIGINT'), 0)
  deepEqual(app.events, ['database', 'session', 'close session', 'close database'])
  process.stdout.write('closed\n')
} else {
  const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]
  const app = fixture(true)
  void nodeApplication(app.options)
  deepEqual(app.events, [])
  deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before)
  const run = runNodeApplication(app.options)
  const port = await app.ready.promise
  equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ready')
  const stream = await new Promise<import('node:http').IncomingMessage>((resolve) => {
    get(`http://127.0.0.1:${port}/events`, resolve)
  })
  const closed = new Promise<void>((resolve) => {
    stream.on('error', () => {})
    stream.once('close', resolve)
    stream.resume()
  })
  const stopping = run.shutdown()
  equal(run.shutdown(), stopping)
  const exit = await stopping
  await closed
  ok(exit._tag === 'Failure' && exit.cause._tag === 'Sequential')
  deepEqual(
    app.events.filter((event) => event !== 'close stream'),
    ['database', 'session', 'close session', 'close database'],
  )
  deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before)

  // Second composition: startup can wait for an external connection and be cancelled.
  const late = fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const connection = await late.options.connections.connectDatabase().runPromise()
  late.events.length = 0
  const pending = runNodeApplication({
    ...late.options,
    connections: {
      ...late.options.connections,
      connectDatabase: () =>
        ResultTask.fromPromise(async () => {
          entered.resolve()
          await gate.promise
          return connection
        }),
    },
  })
  await entered.promise
  const pendingClose = pending.shutdown()
  gate.resolve()
  await pendingClose
  deepEqual(late.events, ['close database'])

  const rollback = fixture()
  let ready = false
  const failed = runNodeApplication({
    ...rollback.options,
    ready: () => {
      ready = true
    },
    connections: {
      ...rollback.options.connections,
      connectSession: () => SessionLifecycleError.taskErr({ operation: 'startup' }),
    },
  })
  equal((await failed.done)._tag, 'Failure')
  equal(ready, false)
  deepEqual(rollback.events, ['database', 'close database'])
  deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before)

  // Actual OS signals are confined to a child, leaving the test runner untouched.
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, '--child'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let output = ''
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('ready\n')) resolve()
    })
    child.once('exit', (code) => {
      if (!output.includes('ready\n')) reject(new Error(`Child exited ${code}: ${errors}`))
    })
  })
  child.kill('SIGTERM')
  child.kill('SIGINT')
  const [code] = await exited
  equal(code, 0, errors)
  ok(output.includes('closed\n'))
  process.stdout.write('Node lifecycle smoke passed.\n')
}
