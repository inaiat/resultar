/** Node execution boundary: HTTP drains before subscriptions and external connections. */
import { createServer, type RequestListener, type Server } from 'node:http'
import { ResultTask } from 'resultar'
import {
  applicationLifecycle,
  type ApplicationFactories,
  HttpLifecycleError,
} from './application-lifecycle.js'

export interface NodeApplication {
  readonly connections: Pick<ApplicationFactories, 'connectDatabase' | 'connectSession'>
  readonly handler: RequestListener
  readonly port?: number
  readonly drainMs: number
  readonly ready: (port: number) => void
}

// HTTP deadline only: other finalizers remain awaited without detaching them.
const drain = (server: Server, drainMs: number) =>
  ResultTask.fromPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), drainMs)
        server.close((error) => {
          clearTimeout(deadline)
          if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING'))
            reject(error)
          else resolve()
        })
      }),
  )

export const nodeApplication = (options: NodeApplication) =>
  applicationLifecycle({
    ...options.connections,
    serve: () =>
      ResultTask.gen(function* () {
        if (!Number.isFinite(options.drainMs) || options.drainMs < 0)
          return yield* HttpLifecycleError.taskErr({ operation: 'validate drain deadline' })
        // Register ownership before listen: a bind error still closes the server.
        const server = yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            const server = createServer(options.handler)
            // This recipe supports HTTP/SSE, not WebSocket or other upgrades.
            server.on('upgrade', (_request, socket) => socket.destroy())
            return server
          }),
          release: (server) => drain(server, options.drainMs),
        })
        yield* ResultTask.fromPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              const failed = (error: Error) => {
                server.off('listening', listening)
                reject(error)
              }
              const listening = () => {
                server.off('error', failed)
                resolve()
              }
              server.once('error', failed)
              server.once('listening', listening)
              server.listen(options.port ?? 0, '127.0.0.1')
            }),
        )
        const address = server.address()
        if (!address || typeof address === 'string')
          return yield* HttpLifecycleError.taskErr({ operation: 'read listening address' })
        options.ready(address.port)
        // The enclosing scope owns the real server finalizer registered above.
        return { stopAndDrain: () => ResultTask.ok(undefined) }
      }),
    waitForShutdown: () => ResultTask.never(),
  })

/** Explicit executable boundary; signals cancel one run and repeated requests join it. */
export const runNodeApplication = (options: NodeApplication) => {
  const program = nodeApplication(options)
  const controller = new AbortController()
  const shutdown = () => controller.abort('process shutdown')
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  const done = program.runExit({ signal: controller.signal }).finally(() => {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
  })
  return {
    done,
    shutdown: () => {
      shutdown()
      return done
    },
  }
}
