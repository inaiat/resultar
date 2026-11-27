import { Effect } from 'effect'
import { ObjectId } from 'mongodb'

import type { UrlRepositoryService } from '../../domain/repository/url.repository.js'
import type {
  AccessCountUpdateJob,
  SoftDeleteExpiredJob,
  UrlJobData,
  UrlJobResult,
} from './url-queue.types.js'

const jobSucceeded: UrlJobResult = { success: true }
const jobIgnored: UrlJobResult = { success: false }

const processAccessCountJob = ({
  data,
  repository,
}: {
  readonly data: AccessCountUpdateJob
  readonly repository: UrlRepositoryService
}) => repository.recordAccess(new ObjectId(data.urlId), new Date()).pipe(Effect.as(jobSucceeded))

const processSoftDeleteJob = ({
  data,
  repository,
}: {
  readonly data: SoftDeleteExpiredJob
  readonly repository: UrlRepositoryService
}) => repository.markInactive(new ObjectId(data.urlId), new Date()).pipe(Effect.as(jobSucceeded))

export const processUrlJob = ({
  data,
  repository,
}: {
  readonly data: UrlJobData
  readonly repository: UrlRepositoryService
}) => {
  if (data.type === 'update-access-count') {
    return processAccessCountJob({ data, repository })
  }

  if (data.type === 'soft-delete-expired') {
    return processSoftDeleteJob({ data, repository })
  }

  return Effect.succeed(jobIgnored)
}
