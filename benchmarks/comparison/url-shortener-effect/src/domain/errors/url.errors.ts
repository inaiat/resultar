import { Data } from 'effect'

/**
 * URL Service Errors
 */
export class UrlNotFoundError extends Data.TaggedError('UrlNotFoundError')<{ shortCode: string }> {
  readonly statusCode = 404

  get message(): string {
    return `URL not found: ${this.shortCode}`
  }
}

export class UrlExpiredError extends Data.TaggedError('UrlExpiredError')<{ shortCode: string }> {
  readonly statusCode = 410

  get message(): string {
    return `URL has expired: ${this.shortCode}`
  }
}

export class CustomAliasExistsError extends Data.TaggedError('CustomAliasExistsError')<{
  alias: string
}> {
  readonly statusCode = 409

  get message(): string {
    return `Custom alias already exists: ${this.alias}`
  }
}

export class InvalidUrlError extends Data.TaggedError('InvalidUrlError')<{ url: string }> {
  readonly statusCode = 400

  get message(): string {
    return `Invalid URL: ${this.url}`
  }
}

export class UrlCreationError extends Data.TaggedError('UrlCreationError')<{ detail: string }> {
  readonly statusCode = 500

  get message(): string {
    return this.detail
  }
}

export class CacheError extends Data.TaggedError('CacheError')<{ readonly detail: string }> {
  readonly statusCode = 500

  get message(): string {
    return `Cache error: ${this.detail}`
  }
}

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly operation: string
  readonly detail: string
  readonly cause?: unknown
}> {
  readonly statusCode = 500

  get message(): string {
    return `Database ${this.operation} failed: ${this.detail}`
  }

  getDisplayMessage(): string {
    return this.message
  }

  static query(error: unknown): DatabaseError {
    return new DatabaseError({
      operation: 'query',
      detail: error instanceof Error ? error.message : 'Error on execute query',
      cause: error,
    })
  }

  static create(error: unknown): DatabaseError {
    const errorMessage = error instanceof Error ? error.message : 'Error on create operation'

    if (errorMessage.includes('duplicate') || errorMessage.includes('E11000')) {
      return DatabaseError.constraint('Duplicate entry', error)
    }

    return new DatabaseError({ operation: 'insert', detail: errorMessage, cause: error })
  }

  static insert(error: unknown): DatabaseError {
    return DatabaseError.create(error)
  }

  static update(error: unknown): DatabaseError {
    const errorMessage = error instanceof Error ? error.message : 'Error on update operation'

    if (errorMessage.includes('duplicate') || errorMessage.includes('E11000')) {
      return DatabaseError.constraint('Duplicate entry', error)
    }

    return new DatabaseError({ operation: 'update', detail: errorMessage, cause: error })
  }

  static delete(error: unknown): DatabaseError {
    return new DatabaseError({
      operation: 'delete',
      detail: error instanceof Error ? error.message : 'Error on delete operation',
      cause: error,
    })
  }

  static constraint(detail: string, cause?: unknown): DatabaseError {
    return new DatabaseError({ operation: 'constraint', detail, cause })
  }

  // Keep backward compatibility methods
  static connection(detail: string, cause?: unknown): DatabaseError {
    return new DatabaseError({ operation: 'connection', detail, cause })
  }

  static transaction(detail: string, cause?: unknown): DatabaseError {
    return new DatabaseError({ operation: 'transaction', detail, cause })
  }

  static timeout(detail: string, cause?: unknown): DatabaseError {
    return new DatabaseError({ operation: 'timeout', detail, cause })
  }
}

/**
 * Union type of all URL errors
 */
export type UrlError =
  | UrlNotFoundError
  | UrlExpiredError
  | CustomAliasExistsError
  | InvalidUrlError
  | UrlCreationError
  | CacheError
  | DatabaseError
