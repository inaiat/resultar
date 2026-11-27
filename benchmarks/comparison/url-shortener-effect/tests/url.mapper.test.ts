import type { ObjectId } from 'mongodb'

import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  documentToCached,
  documentToResponse,
  validateUrl,
} from '../src/domain/usecase/url.mapper.js'

describe('url.mapper', () => {
  it('validates a URL', async () => {
    const result = await Effect.runPromise(validateUrl('https://example.com'))
    expect(result.href).toBe('https://example.com/')
  })

  it('fails for invalid URLs', async () => {
    const exit = await Effect.runPromiseExit(validateUrl('not-a-url'))
    expect(exit._tag).toBe('Failure')
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
