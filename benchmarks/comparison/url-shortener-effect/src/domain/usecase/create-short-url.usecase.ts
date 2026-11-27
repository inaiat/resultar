import type { Effect as EffectType } from 'effect/Effect'

import { Effect } from 'effect'
import { customAlphabet } from 'nanoid'

import type { CreateUrlRequest, UrlResponse } from '../model/url.model.js'
import type { UrlUsecaseDependencies } from './url.usecase.js'

import {
  CustomAliasExistsError,
  type DatabaseError,
  InvalidUrlError,
  type UrlCreationError,
} from '../errors/url.errors.js'
import { documentToCached, documentToResponse, validateUrl } from './url.mapper.js'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const generateShortCode = customAlphabet(ALPHABET, 7)

const ensureAliasAvailable = ({
  customAlias,
  repository,
}: {
  readonly customAlias?: string
  readonly repository: UrlUsecaseDependencies['repository']
}) =>
  Effect.gen(function* () {
    if (customAlias === undefined) {
      return
    }

    const existingByAlias = yield* repository.findActiveByIdentifier(customAlias)
    if (existingByAlias) {
      yield* Effect.fail(new CustomAliasExistsError({ alias: customAlias }))
    }
  })

const findAvailableShortCode = ({ customAlias }: { readonly customAlias?: string }) =>
  Effect.sync(() => {
    if (customAlias !== undefined) {
      return customAlias
    }

    return generateShortCode()
  })

export const makeCreateShortUrlUsecase =
  ({ cache, repository }: Pick<UrlUsecaseDependencies, 'cache' | 'repository'>) =>
  (
    request: CreateUrlRequest,
  ): EffectType<
    UrlResponse,
    CustomAliasExistsError | DatabaseError | InvalidUrlError | UrlCreationError
  > =>
    Effect.gen(function* () {
      yield* validateUrl(request.originalUrl).pipe(
        Effect.mapError(() => new InvalidUrlError({ url: request.originalUrl })),
      )

      yield* ensureAliasAvailable({ customAlias: request.customAlias, repository })

      const shortCode = yield* findAvailableShortCode({ customAlias: request.customAlias })

      const urlDoc = yield* repository.create({
        shortCode,
        originalUrl: request.originalUrl,
        customAlias: request.customAlias,
        accessCount: 0,
        expiresAt: request.expiresAt === undefined ? undefined : new Date(request.expiresAt),
        isActive: true,
      })

      yield* cache
        .cacheUrl(shortCode, documentToCached(urlDoc))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Cache error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )

      return documentToResponse(urlDoc)
    })
