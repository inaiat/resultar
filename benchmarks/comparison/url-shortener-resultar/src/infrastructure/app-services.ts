import type { FastifyBaseLogger as Logger, FastifyInstance } from 'fastify'
import type { FastifyServicesOptions } from 'resultar-fastify'
import { ResultTask, type ResultTaskServices } from 'resultar'
import type { Static, TObject } from 'typebox'
import type { UrlAccessRecorder, UrlRepository } from '../domain/repository/url.repository.js'
import type { UrlCacheService } from '../domain/cache/url-cache.service.js'
import { createModule, service } from 'resultar-di'
import { UrlUseCase } from '../domain/usecase/url.usecase.js'
import type { appConfigProperties } from './app-config.js'
import {
  createMongoPaprModule,
  type MongoPaprProvisioningService,
} from './database/mongo-database.js'
import { createRedisModule } from './cache/redis-client.js'
import { RedisUrlCacheService } from './cache/url-cache.service.js'
import { createUrlAccessQueueModule, startUrlAccessWorker } from './queue/url-access.service.js'
import { PaprUrlRepository } from './repository/url.repository.js'

export type AppConfig = Static<TObject<typeof appConfigProperties>>
export type ServiceOverrides = {
  mongoPaprProvisioningService: MongoPaprProvisioningService
  urlRepository: UrlRepository
  urlCacheService: UrlCacheService
  urlAccessRecorder: UrlAccessRecorder
}
const createServices = (
  config: AppConfig,
  fastify: FastifyInstance,
  overrides?: ServiceOverrides,
) => {
  const logger = fastify.log
  const services = createModule()
    .value('appConfig', config)
    .merge(
      createMongoPaprModule({
        databaseName: config.DB_NAME,
        startupTimeoutMs: config.DB_HEALTH_TIMEOUT_MS,
        url: config.DB_URL,
      }),
    )
    .merge(createRedisModule({ logger, url: config.REDIS_URL }))
    .singleton(PaprUrlRepository)
    .merge(
      createUrlAccessQueueModule(
        { url: config.REDIS_URL, concurrency: config.URL_ACCESS_WORKER_CONCURRENCY },
        logger,
        (urlId, accessedAt) => fastify.services.urlRepository.recordAccess(urlId, accessedAt),
      ),
    )
    .singleton(RedisUrlCacheService)
    .singleton(UrlUseCase)

  if (overrides) {
    return services
      .override('mongoPaprProvisioningService', overrides.mongoPaprProvisioningService)
      .override('urlCacheService', overrides.urlCacheService)
      .override('urlRepository', overrides.urlRepository)
      .override('urlAccessRecorder', overrides.urlAccessRecorder)
  }
  return services
}

const Provisioning = service.require<MongoPaprProvisioningService>()('mongoPaprProvisioningService')

const initializeServices = (config: AppConfig, logger: Logger, overrides?: ServiceOverrides) =>
  ResultTask.gen(function* () {
    if (config.STARTUP_READINESS) {
      const provisioning = yield* Provisioning
      yield* provisioning.provision()
    }
    // An external access recorder owns its worker lifecycle.
    if (!overrides) {
      yield* startUrlAccessWorker(logger)
    }
  })

export const createAppServices = (config: AppConfig, overrides?: ServiceOverrides) =>
  ({
    services: (fastify: FastifyInstance) => createServices(config, fastify, overrides),
    appBindings: ['urlRepository', 'urlCacheService', 'urlAccessRecorder', 'urlUseCase'] as const,
    bindings: [] as const,
    startup: (fastify: FastifyInstance) => initializeServices(config, fastify.log, overrides),
  }) satisfies FastifyServicesOptions

declare module 'fastify' {
  interface FastifyInstance {
    services: Omit<ServiceOverrides, 'mongoPaprProvisioningService'> &
      ResultTaskServices<typeof UrlUseCase>
  }
}
