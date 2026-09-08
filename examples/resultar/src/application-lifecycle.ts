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

/** The scope owns the entire server lifetime, including boot rollback and request draining. */
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
