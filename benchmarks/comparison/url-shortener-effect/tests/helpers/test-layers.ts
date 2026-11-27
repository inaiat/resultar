import { Effect, Layer } from 'effect'

import type { CreateUrlRequest, UrlResponse } from '../../src/domain/model/url.model.js'

import { UrlService, type UrlUsecaseDependencies } from '../../src/domain/usecase/url.usecase.js'
import { UrlCacheService } from '../../src/infrastructure/cache/url-cache.service.js'
import { type AppConfig, AppConfigTag } from '../../src/infrastructure/app-config.js'
import { UrlQueueService } from '../../src/infrastructure/queue/url-queue.service.js'
import { MockRedisClientLive } from './mock-redis.js'
import { createMockUrlRepository, MockUrlRepository } from './mock-url-repository.js'

export const createTestAppConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  PORT: 3000,
  HOST: '127.0.0.1',
  DB_URL: 'mongodb://localhost:27017',
  DB_NAME: 'test-urlshortener',
  DB_HEALTH_TIMEOUT_MS: 2000,
  REDIS_URL: 'redis://localhost:6379',
  URL_ACCESS_WORKER_CONCURRENCY: 4,
  REDIS_TTL_SECONDS: 3600,
  URL_CACHE_PREFIX: 'url:',
  ...overrides,
})

export const TestAppConfigLive = (config?: Partial<AppConfig>) =>
  Layer.succeed(AppConfigTag, createTestAppConfig(config))

const mockQueueService = {
  enqueueAccessCountUpdate: () => Effect.void,
  enqueueSoftDelete: () => Effect.void,
}

const MockUrlQueueServiceLayer = Layer.succeed(UrlQueueService, {
  ...mockQueueService,
  close: () => Effect.void,
})

export const createTestUrlDependencies = (): UrlUsecaseDependencies => ({
  cache: {
    cacheUrl: () => Effect.void,
    getUrl: () => Effect.succeed(undefined),
    invalidate: () => Effect.void,
  },
  queueService: mockQueueService,
  repository: createMockUrlRepository(),
})

export const createTestAppLayer = () => {
  const cacheLayer = Layer.provide(UrlCacheService.Default, [
    MockRedisClientLive,
    TestAppConfigLive(),
  ])
  return Layer.provide(
    UrlService.Default,
    Layer.mergeAll(MockUrlRepository, cacheLayer, MockUrlQueueServiceLayer),
  )
}

// Common test URLs
export const testUrls = {
  example: {
    id: '1',
    shortCode: 'example1',
    originalUrl: 'https://www.example.com',
    customAlias: undefined,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastAccessedAt: undefined,
    accessCount: 0,
    isActive: true,
  } as UrlResponse,

  github: {
    id: '2',
    shortCode: 'github1',
    originalUrl: 'https://www.github.com',
    customAlias: undefined,
    createdAt: '2024-01-02T00:00:00.000Z',
    lastAccessedAt: '2024-01-02T12:00:00.000Z',
    accessCount: 5,
    isActive: true,
  } as UrlResponse,

  inactive: {
    id: '3',
    shortCode: 'inactive1',
    originalUrl: 'https://www.inactive.com',
    customAlias: undefined,
    createdAt: '2024-01-03T00:00:00.000Z',
    lastAccessedAt: undefined,
    accessCount: 0,
    isActive: false,
  } as UrlResponse,
}

// Common test data
export const testCreateUrlRequests = {
  valid: { originalUrl: 'https://www.test.com' } as CreateUrlRequest,

  withCustomAlias: {
    originalUrl: 'https://www.custom.com',
    customAlias: 'mycustom',
  } as CreateUrlRequest,

  invalid: { originalUrl: 'invalid-url' } as CreateUrlRequest,
}
