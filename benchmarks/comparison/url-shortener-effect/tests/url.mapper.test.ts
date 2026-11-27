import type { ObjectId } from 'mongodb'

import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  documentToCached,
  documentToResponse,
  validateCustomAlias,
  validateUrl,
} from '../src/domain/usecase/url.mapper.js'

describe('url.mapper', () => {
  it('validates HTTP and HTTPS URLs and rejects unsupported protocols', async () => {
    const result = await Effect.runPromise(validateUrl('https://example.com'))
    expect(result.href).toBe('https://example.com/')

    for (const invalid of [
      'not-a-url',
      'ftp://files.example/archive',
      ['javascript', 'alert(1)'].join(':'),
    ]) {
      const exit = await Effect.runPromiseExit(validateUrl(invalid))
      expect(exit._tag).toBe('Failure')
    }
  })

  it('rejects reserved and invalid custom aliases', async () => {
    expect((await Effect.runPromiseExit(validateCustomAlias(undefined)))._tag).toBe('Success')
    expect((await Effect.runPromiseExit(validateCustomAlias('valid_alias-1')))._tag).toBe('Success')
    for (const invalid of ['stats', 'STATS', '', 'has space']) {
      expect((await Effect.runPromiseExit(validateCustomAlias(invalid)))._tag).toBe('Failure')
    }
  })

  it('maps document to response without optional fields', () => {
    const doc = {
      _id: { toString: () => '1' } as ObjectId, // eslint-disable-line @typescript-eslint/no-explicit-any
      shortCode: 'abc',
      originalUrl: 'https://example.com',
      accessCount: 0,
      isActive: true,
    }

    const response = documentToResponse(doc)
    expect(response.id).toBe('1')
    expect(Object.hasOwn(response, 'lastAccessedAt')).toBe(false)
    expect(Object.hasOwn(response, 'expiresAt')).toBe(false)
  })

  it('maps document to cached payload', () => {
    const doc = {
      _id: { toString: () => '507f1f77bcf86cd799439011' } as ObjectId, // eslint-disable-line @typescript-eslint/no-explicit-any
      shortCode: 'xyz',
      originalUrl: 'https://example.com',
      accessCount: 2,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      isActive: true,
    }

    const cached = documentToCached(doc)
    expect(cached).toEqual({
      id: '507f1f77bcf86cd799439011',
      shortCode: 'xyz',
      originalUrl: 'https://example.com',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
  })
})
