import { describe, expect, it } from 'vite-plus/test'

import {
  CacheError,
  CustomAliasExistsError,
  DatabaseError,
  InvalidUrlError,
  UrlCreationError,
  UrlExpiredError,
  UrlNotFoundError,
} from '../src/domain/errors/url.errors.js'

describe('URL errors', () => {
  it('formats error messages and status codes', () => {
    const notFound = new UrlNotFoundError({ shortCode: 'abc' })
    const expired = new UrlExpiredError({ shortCode: 'abc' })
    const alias = new CustomAliasExistsError({ alias: 'custom' })
    const invalid = new InvalidUrlError({ url: 'bad' })
    const creation = new UrlCreationError({ detail: 'boom' })
    const cache = new CacheError({ detail: 'redis' })

    expect(notFound.statusCode).toBe(404)
    expect(notFound.message).toBe('URL not found: abc')
    expect(expired.statusCode).toBe(410)
    expect(alias.statusCode).toBe(409)
    expect(invalid.statusCode).toBe(400)
    expect(creation.message).toBe('boom')
    expect(cache.message).toBe('Cache error: redis')
  })

  it('maps database errors by operation', () => {
    const query = DatabaseError.query(new Error('query failed'))
    const insert = DatabaseError.insert(new Error('insert failed'))
    const update = DatabaseError.update(new Error('update failed'))
    const duplicate = DatabaseError.create(new Error('E11000 duplicate key error'))

    expect(query.operation).toBe('query')
    expect(insert.operation).toBe('insert')
    expect(update.operation).toBe('update')
    expect(duplicate.operation).toBe('constraint')
    expect(duplicate.message).toBe('Database constraint failed: Duplicate entry')
  })
})
