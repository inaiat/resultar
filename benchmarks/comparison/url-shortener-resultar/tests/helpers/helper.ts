import type { MongoPaprProvisioningService } from '../../src/infrastructure/database/mongo-database.js'
import { defineAppConfig } from 'resultar-config'
import { ResultTask } from 'resultar'

import { createApp } from '../../src/app.js'
import { appConfigProperties } from '../../src/infrastructure/app-config.js'
import { type CacheReadMode, createInMemoryUrlCacheService } from './in-memory-url-cache-service.js'
import { createMockUrlRepository } from './mock-url-repository.js'

export const createTestAppConfig = (enforceStartupProvisioning: boolean, port: number) =>
  defineAppConfig({
    source: {
      PORT: String(port),
      HOST: '127.0.0.1',
      STARTUP_READINESS: String(enforceStartupProvisioning),
    },
    properties: appConfigProperties,
  })

const provisionedDatabase: MongoPaprProvisioningService = {
  provision: () => ResultTask.ok(undefined),
}

const createTestServices = ({
  cacheReadMode,
  mongoPaprProvisioningService,
}: {
  readonly cacheReadMode: CacheReadMode
  readonly mongoPaprProvisioningService: MongoPaprProvisioningService
}) => {
  const repository = createMockUrlRepository()
  return {
    mongoPaprProvisioningService,
    urlCacheService: createInMemoryUrlCacheService(cacheReadMode),
    urlRepository: repository,
    urlAccessRecorder: repository,
  }
}

export const build = async ({
  cacheReadMode = 'memory',
  port = 0,
  enforceStartupProvisioning = false,
  mongoPaprProvisioningService = provisionedDatabase,
}: {
  cacheReadMode?: CacheReadMode
  port?: number
  enforceStartupProvisioning?: boolean
  mongoPaprProvisioningService?: MongoPaprProvisioningService
} = {}) => {
  const services = createTestServices({ cacheReadMode, mongoPaprProvisioningService })
  const settings = await createTestAppConfig(enforceStartupProvisioning, port).load().runPromise()
  const app = createApp(settings, { overrides: services, server: { logger: false } })
  try {
    await app.ready()
  } catch (error) {
    await app.close()
    throw error
  }
  return app
}
