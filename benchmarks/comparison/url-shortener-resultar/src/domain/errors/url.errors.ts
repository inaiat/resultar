import { createTaggedError } from 'resultar'

const errorDetail = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

export class UrlNotFoundError extends createTaggedError({
  name: 'UrlNotFoundError',
  message: 'URL not found: $shortCode',
  captureStackTrace: false,
}) {}

export class UrlExpiredError extends createTaggedError({
  name: 'UrlExpiredError',
  message: 'URL has expired: $shortCode',
  captureStackTrace: false,
}) {}

export class CustomAliasExistsError extends createTaggedError({
  name: 'CustomAliasExistsError',
  message: 'Custom alias already exists: $alias',
  captureStackTrace: false,
}) {}

export class InvalidCustomAliasError extends createTaggedError({
  name: 'InvalidCustomAliasError',
  message: 'Invalid custom alias: $alias',
  captureStackTrace: false,
}) {}

export class InvalidUrlError extends createTaggedError({
  name: 'InvalidUrlError',
  message: 'Invalid URL: $url',
  captureStackTrace: false,
}) {}

export class UrlCreationError extends createTaggedError({
  name: 'UrlCreationError',
  message: '$detail',
}) {}

export class CacheError extends createTaggedError({
  name: 'CacheError',
  message: 'Cache error: $detail',
}) {}

export class DatabaseError extends createTaggedError({
  name: 'DatabaseError',
  message: 'Database $operation failed: $detail',
}) {
  static isConstraint(error: unknown): error is DatabaseError {
    return error instanceof DatabaseError && error.operation === 'constraint'
  }

  static query(error: unknown): DatabaseError {
    return new DatabaseError({
      operation: 'query',
      detail: error instanceof Error ? error.message : 'Error on execute query',
      cause: error,
    })
  }

  static insert(error: unknown): DatabaseError {
    return new DatabaseError({
      operation: 'insert',
      detail: errorDetail(error, 'Error on insert operation'),
      cause: error,
    })
  }

  static update(error: unknown): DatabaseError {
    return new DatabaseError({
      operation: 'update',
      detail: errorDetail(error, 'Error on update operation'),
      cause: error,
    })
  }

  static constraint(detail: string, cause?: unknown): DatabaseError {
    return new DatabaseError({ operation: 'constraint', detail, cause })
  }
}

/**
 * Union type of all URL errors
 */
export type UrlError =
  | UrlNotFoundError
  | UrlExpiredError
  | CustomAliasExistsError
  | InvalidCustomAliasError
  | InvalidUrlError
  | UrlCreationError
  | DatabaseError
