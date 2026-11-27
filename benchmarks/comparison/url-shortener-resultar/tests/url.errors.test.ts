import { describe, expect, it } from 'vite-plus/test'

import {
  CacheError,
  CustomAliasExistsError,
  DatabaseError,
  InvalidCustomAliasError,
  InvalidUrlError,
  UrlCreationError,
  UrlExpiredError,
  UrlNotFoundError,
} from '../src/domain/errors/url.errors.js'

describe('URL errors', () => {
  it('formats domain error messages and tags', () => {
    const notFound = new UrlNotFoundError({ shortCode: 'abc' })
    const expired = new UrlExpiredError({ shortCode: 'abc' })
    const alias = new CustomAliasExistsError({ alias: 'custom' })
    const invalidAlias = new InvalidCustomAliasError({ alias: 'stats' })
    const invalid = new InvalidUrlError({ url: 'bad' })
    const creation = new UrlCreationError({ detail: 'boom' })
    const cache = new CacheError({ detail: 'redis' })

    expect(notFound).toMatchObject({ _tag: 'UrlNotFoundError', message: 'URL not found: abc' })
    expect(expired).toMatchObject({ _tag: 'UrlExpiredError', message: 'URL has expired: abc' })
    expect(alias).toMatchObject({
      _tag: 'CustomAliasExistsError',
      message: 'Custom alias already exists: custom',
    })
    expect(invalidAlias).toMatchObject({
      _tag: 'InvalidCustomAliasError',
      message: 'Invalid custom alias: stats',
    })
    expect(invalid).toMatchObject({ _tag: 'InvalidUrlError', message: 'Invalid URL: bad' })
    expect(creation.message).toBe('boom')
    expect(cache.message).toBe('Cache error: redis')
  })

  it('maps database failures by neutral operation', () => {
    const queryCause = new Error('query failed')
    const insertCause = new Error('insert failed')
    const updateCause = new Error('update failed')

    expect(DatabaseError.query(queryCause)).toMatchObject({
      operation: 'query',
      message: 'Database query failed: query failed',
      cause: queryCause,
    })
    expect(DatabaseError.insert(insertCause)).toMatchObject({
      operation: 'insert',
      message: 'Database insert failed: insert failed',
      cause: insertCause,
    })
    expect(DatabaseError.update(updateCause)).toMatchObject({
      operation: 'update',
      message: 'Database update failed: update failed',
      cause: updateCause,
    })
  })

  it('uses operation fallback messages for unknown errors', () => {
    expect(DatabaseError.query('query failed').message).toBe(
      'Database query failed: Error on execute query',
    )
    expect(DatabaseError.insert('insert failed').message).toBe(
      'Database insert failed: Error on insert operation',
    )
    expect(DatabaseError.update('update failed').message).toBe(
      'Database update failed: Error on update operation',
    )
  })

  it('detects only explicit DatabaseError constraints', () => {
    const constraint = DatabaseError.constraint('Duplicate entry')
    const insert = DatabaseError.insert(new Error('insert failed'))

    expect(constraint.message).toBe('Database constraint failed: Duplicate entry')
    expect(DatabaseError.isConstraint(constraint)).toBe(true)
    expect(DatabaseError.isConstraint(insert)).toBe(false)
    expect(DatabaseError.isConstraint({ operation: 'constraint' })).toBe(false)
  })
})
