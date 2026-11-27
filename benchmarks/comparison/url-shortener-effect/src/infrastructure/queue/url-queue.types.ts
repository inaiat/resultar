import type { Effect as EffectType } from 'effect/Effect'

import type { IntegrationError } from '../../domain/errors/integration.errors.js'

export const URL_QUEUE = 'url-shortener-effect-jobs'

export type AccessCountUpdateJob = {
  type: 'update-access-count'
  urlId: string
  shortCode: string
  source: 'cached' | 'alias' | 'database'
  customAlias?: string
}

export type SoftDeleteExpiredJob = {
  type: 'soft-delete-expired'
  urlId: string
  shortCode: string
  expiresAt?: string
}

export type UrlJobData = AccessCountUpdateJob | SoftDeleteExpiredJob

export type UrlJobResult = { success: boolean }

export type UrlQueueServiceState = {
  readonly enqueueAccessCountUpdate: (
    params: Omit<AccessCountUpdateJob, 'type'>,
  ) => EffectType<void, IntegrationError>
  readonly enqueueSoftDelete: (
    params: Omit<SoftDeleteExpiredJob, 'type'>,
  ) => EffectType<void, IntegrationError>
  readonly close: () => EffectType<void>
}
