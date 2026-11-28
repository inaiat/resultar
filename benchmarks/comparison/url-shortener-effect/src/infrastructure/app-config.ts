import { Config, Context, Layer, Schema } from 'effect'

const positiveInt = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const port = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 65_535 }),
)

const appConfig = Config.all({
  PORT: Config.withDefault(Config.schema(port, 'PORT'), 3000),
  HOST: Config.withDefault(Config.String('HOST'), '0.0.0.0'),
  DB_URL: Config.withDefault(Config.String('DB_URL'), 'mongodb://localhost:27017'),
  DB_NAME: Config.withDefault(Config.String('DB_NAME'), 'url_shortener_effect'),
  DB_HEALTH_TIMEOUT_MS: Config.withDefault(
    Config.schema(positiveInt, 'DB_HEALTH_TIMEOUT_MS'),
    2000,
  ),
  REDIS_URL: Config.withDefault(Config.String('REDIS_URL'), 'redis://localhost:6379'),
  URL_ACCESS_WORKER_CONCURRENCY: Config.withDefault(
    Config.schema(positiveInt, 'URL_ACCESS_WORKER_CONCURRENCY'),
    4,
  ),
  REDIS_TTL_SECONDS: Config.withDefault(Config.schema(positiveInt, 'REDIS_TTL_SECONDS'), 3600),
  URL_CACHE_PREFIX: Config.withDefault(Config.String('URL_CACHE_PREFIX'), 'url-shortener-effect:'),
})

export type AppConfig = Config.Success<typeof appConfig>

export class AppConfigTag extends Context.Service<AppConfigTag, AppConfig>()('AppConfig') {}

export const AppConfigLive = Layer.effect(AppConfigTag, appConfig)
