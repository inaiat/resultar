import { Effect } from 'effect'

import type { UrlQueueServiceState } from './url-queue.types.js'

import { IntegrationError } from '../../domain/errors/integration.errors.js'

const unavailableError = (jobName: string, initError: IntegrationError) =>
  IntegrationError.queue(
    'enqueue',
    `Failed to enqueue ${jobName}: queue unavailable (${initError.message})`,
  )

export const createUnavailableQueueService = (
  initError: IntegrationError,
): UrlQueueServiceState => ({
  enqueueAccessCountUpdate: () => Effect.fail(unavailableError('update-access-count', initError)),
  enqueueSoftDelete: () => Effect.fail(unavailableError('soft-delete-expired', initError)),
  close: () => Effect.void,
})
