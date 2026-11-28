import type { Effect as EffectType } from 'effect/Effect'

import { Effect } from 'effect'
import { customAlphabet } from 'nanoid'

import type { CreateUrlRequest, UrlDocument, UrlResponse } from '../model/url.model.js'
import type { UrlUsecaseDependencies } from './url.usecase.js'

import {
  CustomAliasExistsError,
  DatabaseError,
  type InvalidCustomAliasError,
  type InvalidUrlError,
  UrlCreationError,
} from '../errors/url.errors.js'
import {
  documentToCached,
  documentToResponse,
  validateCustomAlias,
  validateUrl,
} from './url.mapper.js'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const generateShortCode = customAlphabet(ALPHABET, 7)
const maxShortCodeGenerationAttempts = 10

export const makeCreateShortUrlUsecase =
  ({ cache, repository }: Pick<UrlUsecaseDependencies, 'cache' | 'repository'>) =>
  (
    request: CreateUrlRequest,
  ): EffectType<
    UrlResponse,
    | CustomAliasExistsError
    | DatabaseError
    | InvalidCustomAliasError
    | InvalidUrlError
    | UrlCreationError
  > =>
    Effect.gen(function* () {
      yield* validateUrl(request.originalUrl)
      yield* validateCustomAlias(request.customAlias)

      const expiresAt = request.expiresAt === undefined ? undefined : new Date(request.expiresAt)

      const attemptInsert = (
        attempt: number,
      ): EffectType<UrlDocument, CustomAliasExistsError | DatabaseError | UrlCreationError> => {
        if (attempt >= maxShortCodeGenerationAttempts) {
          return Effect.fail(
            new UrlCreationError({ detail: 'Failed to generate unique short code' }),
          )
        }

        const shortCode = request.customAlias ?? generateShortCode()
        return repository
          .create({
            shortCode,
            originalUrl: request.originalUrl,
            customAlias: request.customAlias,
            accessCount: 0,
            expiresAt,
            isActive: true,
          })
          .pipe(
            Effect.catch((error) => {
              if (!DatabaseError.isConstraint(error)) {
                return Effect.fail(error)
              }

              if (request.customAlias !== undefined) {
                return Effect.fail(new CustomAliasExistsError({ alias: request.customAlias }))
              }

              return attemptInsert(attempt + 1)
            }),
          )
      }

      const urlDoc = yield* attemptInsert(0)

      yield* cache
        .cacheUrl(urlDoc.shortCode, documentToCached(urlDoc))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Cache error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )

      return documentToResponse(urlDoc)
    })
