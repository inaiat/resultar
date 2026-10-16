/**
 * Application Lifecycle & Scoped Finalizers (`ResultTask.scoped`, `ResultTask.scope`, `acquireRelease`)
 *
 * This module demonstrates LIFO resource acquisition and teardown across a multi-service
 * server boot/shutdown sequence. If any startup step fails (or when shutdown completes),
 * acquired resources are released in reverse acquisition order:
 * HTTP server -> session store -> database connection.
 */
import { ResultTask, createTaggedError } from 'resultar'

export class DatabaseLifecycleError extends createTaggedError({
  name: 'DatabaseLifecycleError',
  message: 'Database $operation failed',
}) {}

export class SessionLifecycleError extends createTaggedError({
  name: 'SessionLifecycleError',
  message: 'Session $operation failed',
}) {}

export class HttpLifecycleError extends createTaggedError({
  name: 'HttpLifecycleError',
  message: 'HTTP $operation failed',
}) {}

export interface DatabaseConnection {
  readonly ensureSchema: () => ResultTask<void, DatabaseLifecycleError>
  readonly close: () => ResultTask<void, DatabaseLifecycleError>
}

export interface SessionConnection {
  readonly close: () => ResultTask<void, SessionLifecycleError>
}

export interface HttpServer {
  // Stop accepting connections, end SSE, and drain requests before this resolves.
  readonly stopAndDrain: () => ResultTask<void, HttpLifecycleError>
}

export interface ApplicationFactories {
  readonly connectDatabase: () => ResultTask<DatabaseConnection, DatabaseLifecycleError>
  readonly connectSession: (
    database: DatabaseConnection,
  ) => ResultTask<SessionConnection, SessionLifecycleError>
  readonly serve: (services: {
    readonly database: DatabaseConnection
    readonly session: SessionConnection
  }) => ResultTask<HttpServer, HttpLifecycleError>
  readonly waitForShutdown: () => ResultTask<void, HttpLifecycleError>
}

/**
 * `ResultTask.scoped` owns the entire server lifetime:
 * - Resources registered via `ResultTask.acquireRelease` are closed in reverse (LIFO) order.
 * - If `ensureSchema()` or `connectSession()` fails during boot, already-opened resources
 *   are rolled back automatically before the error is returned.
 */
export const applicationLifecycle = (factories: ApplicationFactories) =>
  ResultTask.scoped(
    ResultTask.gen(function* () {
      const database = yield* ResultTask.acquireRelease({
        acquire: factories.connectDatabase(),
        release: (connection) => connection.close(),
      })
      yield* database.ensureSchema()
      const session = yield* ResultTask.acquireRelease({
        acquire: factories.connectSession(database),
        release: (connection) => connection.close(),
      })
      yield* ResultTask.acquireRelease({
        acquire: factories.serve({ database, session }),
        release: (server) => server.stopAndDrain(),
      })
      yield* factories.waitForShutdown()
    }),
  )

/**
 * `ResultTask.makeScope()` creates an explicit `ResultTaskScopeOwner` (`use`, `addFinalizer`, `close`)
 * for scenarios where resource lifetimes span multiple separate `ResultTask` executions
 * (such as test fixtures or manually managed plugin containers).
 */
export const runManualScopeOwnerExample = async () => {
  const events: string[] = []
  const owner = ResultTask.makeScope()

  owner.addFinalizer((exit) =>
    ResultTask.sync(() => {
      events.push(`finalizer-1:${exit._tag}`)
    }),
  )

  const value = await ResultTask.runPromise(
    owner.use(
      ResultTask.gen(function* () {
        // Closed explicitly by owner.close() below.
        // resultar-check-disable-next-line no-unscoped-acquire-release
        const resource = yield* ResultTask.acquireRelease({
          acquire: ResultTask.sync(() => {
            events.push('acquire:worker')
            return 'worker-ready' as const
          }),
          release: (name) =>
            ResultTask.sync(() => {
              events.push(`release:${name}`)
            }),
        })
        return resource
      }),
    ),
  )

  await ResultTask.runPromise(owner.close())

  return {
    events,
    value,
  }
}
