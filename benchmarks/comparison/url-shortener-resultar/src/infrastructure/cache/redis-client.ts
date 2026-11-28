import type { FastifyBaseLogger as Logger } from 'fastify'
import { Redis } from 'ioredis'
import { ResultTask, createTaggedError, type StrictResultTask } from 'resultar'
import { createModule, service } from 'resultar-di'

export class RedisCommandError extends createTaggedError({
  name: 'RedisCommandError',
  message: 'Redis $operation failed',
}).withProps<{ operation: string }>() {}
export type RedisClient = {
  get: (key: string) => StrictResultTask<string | null, RedisCommandError>
  set: (
    key: string,
    value: string,
    options: { ttlSeconds: number },
  ) => StrictResultTask<void, RedisCommandError>
  del: (key: string) => StrictResultTask<number, RedisCommandError>
}
export const RedisClientService = service.require<RedisClient>()('redisClient')
export const createRedisModule = ({ url, logger }: { url: string; logger: Logger }) =>
  createModule()
    .resource('redisConnection', [], {
      acquire: () =>
        ResultTask.sync(() => {
          const redis = new Redis(url, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 1000,
          })
          redis.on('error', (err) => {
            logger.warn({ err }, 'Redis unavailable; using MongoDB')
          })
          return redis
        }),
      release: (redis) =>
        ResultTask.sync(() => {
          redis.disconnect()
        }),
      lifetime: 'singleton',
    })
    .singleton('redisClient', ['redisConnection'], ({ redisConnection }): RedisClient => {
      const command = <T>(operation: string, run: () => Promise<T>) =>
        ResultTask.tryPromise({
          // oxlint-disable-next-line typescript/promise-function-async -- Avoid redundant async Promise wrapper on hot Redis boundary; ResultTask.tryPromise catches sync throws.
          try: () =>
            redisConnection.status === 'wait' ? redisConnection.connect().then(run) : run(),
          catch: (cause) => new RedisCommandError({ cause, operation }),
        })
      return {
        // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per command.
        get: (key) => command('get', () => redisConnection.get(key)),
        set: (key, value, { ttlSeconds }) =>
          // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per command.
          command('set', () => redisConnection.set(key, value, 'EX', ttlSeconds)).asVoid(),
        // oxlint-disable-next-line typescript/promise-function-async -- Return driver Promise directly to avoid extra microtask per command.
        del: (key) => command('del', () => redisConnection.del(key)),
      }
    })
