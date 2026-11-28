import { describe, expect, it } from 'vite-plus/test'

import {
  UrlNotFoundError,
  UrlExpiredError,
  CustomAliasExistsError,
  InvalidUrlError,
  UrlCreationError,
  CacheError,
  DatabaseError,
} from '../../../src/domain/errors/url.errors.js'

describe('url.errors', () => {
  it('UrlNotFoundError has correct message and statusCode', () => {
    const error = new UrlNotFoundError({ shortCode: 'abc' })
    expect(error.message).toBe('URL not found: abc')
    expect(error.statusCode).toBe(404)
  })

  it('UrlExpiredError has correct message and statusCode', () => {
    const error = new UrlExpiredError({ shortCode: 'abc' })
    expect(error.message).toBe('URL has expired: abc')
    expect(error.statusCode).toBe(410)
  })

  it('CustomAliasExistsError has correct message and statusCode', () => {
    const error = new CustomAliasExistsError({ alias: 'abc' })
    expect(error.message).toBe('Custom alias already exists: abc')
    expect(error.statusCode).toBe(409)
  })

  it('InvalidUrlError has correct message and statusCode', () => {
    const error = new InvalidUrlError({ url: 'not-a-url' })
    expect(error.message).toBe('Invalid URL: not-a-url')
    expect(error.statusCode).toBe(400)
  })

  it('UrlCreationError has correct message and statusCode', () => {
    const error = new UrlCreationError({ detail: 'fail' })
    expect(error.message).toBe('fail')
    expect(error.statusCode).toBe(500)
  })

  it('CacheError has correct message and statusCode', () => {
    const error = new CacheError({ detail: 'fail' })
    expect(error.message).toBe('Cache error: fail')
    expect(error.statusCode).toBe(500)
  })

  describe('DatabaseError', () => {
    it('has correct message and statusCode', () => {
      const error = new DatabaseError({ operation: 'insert', detail: 'fail' })
      expect(error.message).toBe('Database insert failed: fail')
      expect(error.getDisplayMessage()).toBe('Database insert failed: fail')
      expect(error.statusCode).toBe(500)
    })

    it('creates query error', () => {
      const error = DatabaseError.query(new Error('fail'))
      expect(error.operation).toBe('query')
      expect(error.detail).toBe('fail')
      const stringError = DatabaseError.query('fail')
      expect(stringError.detail).toBe('Error on execute query')
    })

    it('creates insert/create error and handles duplicates', () => {
      const error = DatabaseError.create(new Error('fail'))
      expect(error.operation).toBe('insert')
      expect(error.detail).toBe('fail')

      const dupError = DatabaseError.create(new Error('E11000 duplicate'))
      expect(dupError.operation).toBe('constraint')
      expect(dupError.detail).toBe('Duplicate entry')

      const insertError = DatabaseError.insert(new Error('fail'))
      expect(insertError.operation).toBe('insert')
    })

    it('creates update error and handles duplicates', () => {
      const error = DatabaseError.update(new Error('fail'))
      expect(error.operation).toBe('update')
      expect(error.detail).toBe('fail')

      const dupError = DatabaseError.update(new Error('duplicate key'))
      expect(dupError.operation).toBe('constraint')
      expect(dupError.detail).toBe('Duplicate entry')
    })

    it('creates delete error', () => {
      const error = DatabaseError.delete(new Error('fail'))
      expect(error.operation).toBe('delete')
      expect(error.detail).toBe('fail')
    })

    it('creates backward compatibility errors', () => {
      expect(DatabaseError.connection('fail').operation).toBe('connection')
      expect(DatabaseError.transaction('fail').operation).toBe('transaction')
      expect(DatabaseError.timeout('fail').operation).toBe('timeout')
    })
  })
})
