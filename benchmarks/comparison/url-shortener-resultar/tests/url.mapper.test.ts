import { describe, expect, it } from 'vite-plus/test'

import { InvalidCustomAliasError, InvalidUrlError } from '../src/domain/errors/url.errors.js'
import { urlToCached, validateCustomAlias, validateUrl } from '../src/domain/usecase/url.mapper.js'
import { createUrl } from './helpers/url-usecase-fixtures.js'

const javaScriptUrl = ['javascript', 'alert(1)'].join(':')

describe('domain URL mapping', () => {
  it.each(['https://example.com', 'http://example.com/path'])('accepts web URL %s', (url) => {
    const result = validateUrl(url)

    expect(result.isOk()).toBe(true)
    if (result.isOk()) {
      expect(result.value.href).toBe(new URL(url).href)
    }
  })

  it.each(['not-a-url', javaScriptUrl, 'ftp://files.example/archive'])(
    'rejects unsupported URL %s',
    (url) => {
      const result = validateUrl(url)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(InvalidUrlError)
        expect(result.error).toMatchObject({
          _tag: 'InvalidUrlError',
          message: `Invalid URL: ${url}`,
        })
      }
    },
  )

  it.each([undefined, 'flash-url', 'valid_alias'])('accepts custom alias %s', (alias) => {
    expect(validateCustomAlias(alias).isOk()).toBe(true)
  })

  it.each(['stats', 'STATS', 'invalid alias', '', 'a'.repeat(51)])(
    'rejects custom alias %s',
    (alias) => {
      const result = validateCustomAlias(alias)

      expect(result.isErr()).toBe(true)
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(InvalidCustomAliasError)
        expect(result.error.message).toBe(`Invalid custom alias: ${alias}`)
      }
    },
  )

  it('maps only redirect data into the cache payload', () => {
    const url = createUrl({
      id: '507f1f77bcf86cd799439011',
      shortCode: 'cached',
      originalUrl: 'https://cached.example',
      customAlias: 'not-a-second-cache-key',
      accessCount: 42,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    })

    expect(urlToCached(url)).toEqual({
      id: '507f1f77bcf86cd799439011',
      shortCode: 'cached',
      originalUrl: 'https://cached.example',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
  })

  it('omits expiration when the URL does not expire', () => {
    expect(urlToCached(createUrl())).toMatchObject({ expiresAt: undefined })
  })
})
