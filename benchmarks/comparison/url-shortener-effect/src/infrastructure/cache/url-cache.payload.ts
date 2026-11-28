import type { CachedUrl } from '../../domain/model/url.model.js'

import { CacheError } from '../../domain/errors/url.errors.js'

const objectIdPattern = /^[0-9a-fA-F]{24}$/u
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export const isCachedUrl = (value: unknown): value is CachedUrl => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('shortCode' in value) ||
    !('originalUrl' in value)
  ) {
    return false
  }
  if (
    typeof value.id !== 'string' ||
    !objectIdPattern.test(value.id) ||
    typeof value.shortCode !== 'string' ||
    typeof value.originalUrl !== 'string'
  ) {
    return false
  }
  if ('expiresAt' in value && value.expiresAt !== undefined) {
    return typeof value.expiresAt === 'string' && isoDateTimePattern.test(value.expiresAt)
  }
  return true
}

export const parseCachedUrl = (data: string): CachedUrl => {
  const parsed: unknown = JSON.parse(data)
  if (!isCachedUrl(parsed)) {
    throw new CacheError({ detail: 'Invalid cached URL payload' })
  }

  return parsed
}
