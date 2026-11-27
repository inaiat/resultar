import type { Redis } from 'ioredis'

import { Effect, Layer } from 'effect'
import { EventEmitter } from 'node:events'

import { RedisClient } from '../../src/infrastructure/cache/redis-client.js'

// oxlint-disable-next-line unicorn/prefer-event-target -- Match ioredis's Node.js event API.
class MockRedis extends EventEmitter {
  private readonly store = new Map<string, { value: string; expiry?: number }>()
  private _status = 'ready'

  get status() {
    return this._status
  }

  // Add stub methods to prevent real connection attempts
  connect(): Promise<void> {
    this._status = 'ready'
    return Promise.resolve()
  }

  quit(): Promise<'OK'> {
    this._status = 'close'
    this.store.clear()
    this.emit('close')
    return Promise.resolve('OK')
  }

  disconnect() {
    this._status = 'close'
    this.store.clear()
    this.emit('close')
  }

  // Core Redis methods needed by the app
  set(key: string, value: string, ...[, ttl]: ['EX', number]): Promise<'OK'> {
    this.store.set(key, { value, expiry: Date.now() + ttl * 1000 })
    return Promise.resolve('OK')
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) {
      // eslint-disable-next-line unicorn/no-null
      return Promise.resolve(null)
    }
    if (entry.expiry !== undefined && Date.now() > entry.expiry) {
      this.store.delete(key)
      // eslint-disable-next-line unicorn/no-null
      return Promise.resolve(null)
    }
    return Promise.resolve(entry.value)
  }

  del(...keys: string[]): Promise<number> {
    let count = 0
    for (const key of keys) {
      if (this.store.delete(key)) {
        count += 1
      }
    }
    return Promise.resolve(count)
  }

  // Additional ioredis-compatible methods
  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    super.once(event, listener)
    return this
  }

  addListener(event: string, listener: (...args: unknown[]) => void): this {
    super.addListener(event, listener)
    return this
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    super.removeListener(event, listener)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    super.off(event, listener)
    return this
  }
}

export const MockRedisClientLive = Layer.effect(
  RedisClient,
  Effect.sync(() => {
    const mockRedis = new MockRedis()
    return {
      redis: mockRedis as unknown as Redis,
      disconnect: () =>
        Effect.sync(() => {
          mockRedis.disconnect()
        }),
    }
  }),
)
