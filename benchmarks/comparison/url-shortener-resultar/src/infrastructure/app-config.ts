import { defineAppConfig } from 'resultar-config'
import { Type } from 'typebox'

export const appConfigProperties = {
  PORT: Type.Integer({ default: 3000, minimum: 0, maximum: 65_535 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  DB_URL: Type.String({ default: 'mongodb://localhost:27017' }),
  DB_NAME: Type.String({ default: 'url_shortener_resultar' }),
  DB_HEALTH_TIMEOUT_MS: Type.Integer({ default: 2000, minimum: 1 }),
  STARTUP_READINESS: Type.Boolean({ default: true }),
  REDIS_URL: Type.String({ default: 'redis://localhost:6379' }),
  URL_ACCESS_WORKER_CONCURRENCY: Type.Integer({ default: 4, minimum: 1 }),
  REDIS_TTL_SECONDS: Type.Integer({ default: 3600, minimum: 1 }),
  URL_CACHE_PREFIX: Type.String({ default: 'url-shortener-resultar:' }),
}

export const appConfig = defineAppConfig({ properties: appConfigProperties })
