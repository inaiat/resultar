import type { FastifyBaseLogger as Logger } from 'fastify'

import { customAlphabet } from 'nanoid'
import { ResultTask, type StrictResultTask } from 'resultar'

import type { UrlCacheService } from '../cache/url-cache.service.js'
import type { CreateUrlInput, Url } from '../model/url.model.js'
import type { UrlRepository } from '../repository/url.repository.js'

import {
  CustomAliasExistsError,
  DatabaseError,
  type InvalidCustomAliasError,
  type InvalidUrlError,
  UrlCreationError,
} from '../errors/url.errors.js'
import { bestEffortFailureMessage } from './url.helpers.js'
import { urlToCached, validateCustomAlias, validateUrl } from './url.mapper.js'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
const generateShortCode = customAlphabet(ALPHABET, 7)
const maxShortCodeGenerationAttempts = 10

type UrlCreationFlowError =
  | CustomAliasExistsError
  | DatabaseError
  | InvalidCustomAliasError
  | InvalidUrlError
  | UrlCreationError
type UrlCreationFlowResult<T> = StrictResultTask<T, UrlCreationFlowError>

type UrlCreationDependencies = {
  readonly logger: Logger
  readonly urlCacheService: UrlCacheService
  readonly urlRepository: UrlRepository
}

export const createAvailableUrl = (
  request: CreateUrlInput,
  { logger, urlCacheService, urlRepository }: UrlCreationDependencies,
): UrlCreationFlowResult<Url> => {
  const urlValidation = validateUrl(request.originalUrl)
  if (urlValidation.isErr()) {
    return ResultTask.err(urlValidation.error)
  }
  const aliasValidation = validateCustomAlias(request.customAlias)
  if (aliasValidation.isErr()) {
    return ResultTask.err(aliasValidation.error)
  }

  const attemptInsert = (attempt: number): UrlCreationFlowResult<Url> => {
    if (attempt >= maxShortCodeGenerationAttempts) {
      return UrlCreationError.taskErr({ detail: 'Failed to generate unique short code' })
    }
    const shortCode = request.customAlias ?? generateShortCode()
    return urlRepository
      .insert({
        shortCode,
        originalUrl: request.originalUrl,
        customAlias: request.customAlias,
        accessCount: 0,
        expiresAt: request.expiresAt,
        isActive: true,
      })
      .orElse((error): UrlCreationFlowResult<Url | undefined> => {
        if (!DatabaseError.isConstraint(error)) {
          return ResultTask.err(error)
        }
        if (request.customAlias !== undefined) {
          return CustomAliasExistsError.taskErr({ alias: request.customAlias })
        }
        return ResultTask.ok(undefined)
      })
      .andThen((inserted): UrlCreationFlowResult<Url> => {
        if (inserted === undefined) {
          return attemptInsert(attempt + 1)
        }
        return urlCacheService
          .cacheUrl(inserted.shortCode, urlToCached(inserted))
          .orElseSucceed((err) => {
            logger.warn(
              { operation: 'cacheCreatedUrl', shortCode: inserted.shortCode, err },
              bestEffortFailureMessage,
            )
            return undefined
          })
          .as(inserted)
      })
  }

  return attemptInsert(0)
}
