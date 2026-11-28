import type { FastifyBaseLogger } from 'fastify'
import pino from 'pino'

import { ResultTask } from 'resultar'
import { vi } from 'vite-plus/test'

import type { UrlCacheService } from '../../src/domain/cache/url-cache.service.js'
import type { CacheError, DatabaseError } from '../../src/domain/errors/url.errors.js'
import type { CachedUrl, Url } from '../../src/domain/model/url.model.js'
import type { UrlRepository } from '../../src/domain/repository/url.repository.js'

export const createUrl = (overrides: Partial<Url> = {}): Url => ({
  id: 'url-1',
  shortCode: 'short-code',
  originalUrl: 'https://example.com',
  accessCount: 0,
  isActive: true,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
})

export const createCachedUrl = (overrides: Partial<CachedUrl> = {}): CachedUrl => ({
  id: 'url-1',
  shortCode: 'short-code',
  originalUrl: 'https://example.com',
  ...overrides,
})

export const createRepository = (overrides: Partial<UrlRepository> = {}): UrlRepository => ({
  findActiveByIdentifier: vi.fn(() => ResultTask.ok<Url | undefined, DatabaseError>(undefined)),
  findPopular: vi.fn(() => ResultTask.ok<Url[], DatabaseError>([])),
  findRecent: vi.fn(() => ResultTask.ok<Url[], DatabaseError>([])),
  insert: vi.fn(),
  markInactive: vi.fn(() => ResultTask.ok<undefined, DatabaseError>(undefined)),
  recordAccess: vi.fn(() => ResultTask.ok<undefined, DatabaseError>(undefined)),
  ...overrides,
})

export const createCacheService = (overrides: Partial<UrlCacheService> = {}): UrlCacheService => ({
  cacheUrl: vi.fn(() => ResultTask.ok<undefined, CacheError>(undefined)),
  getUrl: vi.fn(() => ResultTask.ok<undefined, CacheError>(undefined)),
  invalidate: vi.fn(() => ResultTask.ok<undefined, CacheError>(undefined)),
  ...overrides,
})

export const createBestEffortLogger = () => {
  const logger: FastifyBaseLogger = pino({ enabled: false })
  const warn = vi.spyOn(logger, 'warn')

  return { logger, warn }
}
