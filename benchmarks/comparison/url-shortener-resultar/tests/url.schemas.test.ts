import { describe, expect, it } from 'vite-plus/test'

import { requestToCreateUrlInput, urlToResponse } from '../src/application/routes/url.schemas.js'
import { createUrl } from './helpers/url-usecase-fixtures.js'

describe('URL transport mapping', () => {
  it('maps request dates at the HTTP boundary', () => {
    expect(
      requestToCreateUrlInput({
        originalUrl: 'https://example.com',
        customAlias: 'example',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      originalUrl: 'https://example.com',
      customAlias: 'example',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    })
  })

  it('preserves an absent request expiration', () => {
    expect(requestToCreateUrlInput({ originalUrl: 'https://example.com' })).toEqual({
      originalUrl: 'https://example.com',
      expiresAt: undefined,
    })
  })

  it('serializes domain dates for the response', () => {
    const response = urlToResponse(
      createUrl({
        id: 'url-2',
        shortCode: 'with-dates',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        lastAccessedAt: new Date('2025-01-02T00:00:00.000Z'),
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        accessCount: 3,
      }),
    )

    expect(response).toMatchObject({
      id: 'url-2',
      shortCode: 'with-dates',
      createdAt: '2025-01-01T00:00:00.000Z',
      lastAccessedAt: '2025-01-02T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      accessCount: 3,
    })
  })

  it('preserves absent optional response fields', () => {
    expect(urlToResponse(createUrl())).toMatchObject({
      customAlias: undefined,
      lastAccessedAt: undefined,
      expiresAt: undefined,
    })
  })
})
