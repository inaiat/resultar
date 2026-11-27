import { Layer } from 'effect'

import { UrlService } from '../domain/usecase/url.usecase.js'
import { RedisClient } from './cache/redis-client.js'
import { UrlCacheService } from './cache/url-cache.service.js'
import { MongoClientService } from './database/mongo-client.js'
import { MongoDatabaseService } from './database/mongo-database.js'
import { PaprInstance } from './papr/papr-instance.js'
import { UrlCollectionService } from './papr/url.schema.js'
import { UrlQueueLive } from './queue/url-queue.service.js'
import { UrlRepositoryLive } from './repository/url.repository.js'
import { AppConfigLive } from './app-config.js'

const databaseLayer = MongoDatabaseService.Default.pipe(Layer.provide(MongoClientService.Default))
const paprLayer = PaprInstance.Default.pipe(Layer.provide(databaseLayer))
const repositoryLayer = Layer.provide(
  UrlRepositoryLive,
  Layer.provide(UrlCollectionService.Default, paprLayer),
)

const cacheLayer = Layer.provide(UrlCacheService.Default, RedisClient.Default)

const queueLayer = Layer.provide(UrlQueueLive, repositoryLayer)

export const UrlAppLive = Layer.provide(
  UrlService.Default,
  Layer.mergeAll(repositoryLayer, cacheLayer, queueLayer),
).pipe(Layer.provide(AppConfigLive))
