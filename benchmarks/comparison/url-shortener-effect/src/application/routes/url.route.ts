import { HttpServerResponse } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { Effect } from 'effect'

import type { UrlError } from '../../domain/errors/url.errors.js'

import { UrlService } from '../../domain/usecase/url.usecase.js'
import { respondWithError, UrlApi } from '../url-api.js'

const urlErrorResponse = (error: UrlError) => {
  if (error.statusCode >= 500) {
    return Effect.as(
      Effect.logError('Request failed', error),
      respondWithError(error.statusCode, 'Internal Server Error'),
    )
  }
  return Effect.succeed(respondWithError(error.statusCode, error.message))
}

export const UrlRoutes = HttpApiBuilder.group(UrlApi, 'urls', (handlers) =>
  handlers
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const service = yield* UrlService
        const data = yield* service.createShortUrl(payload)
        return HttpServerResponse.jsonUnsafe({ success: true as const, data }, { status: 201 })
      }).pipe(Effect.catch(urlErrorResponse)),
    )
    .handle('stats', ({ query: { type = 'recent', limit = 10 } }) =>
      Effect.gen(function* () {
        const service = yield* UrlService
        const data = yield* service.listUrlStats(type, limit)
        return HttpServerResponse.jsonUnsafe({ success: true as const, data })
      }).pipe(Effect.catch(urlErrorResponse)),
    )
    .handle('redirect', ({ params: { shortCode } }) =>
      Effect.gen(function* () {
        const service = yield* UrlService
        const originalUrl = yield* service.getOriginalUrl(shortCode)
        return HttpServerResponse.redirect(originalUrl, { headers: { 'content-length': '0' } })
      }).pipe(Effect.catch(urlErrorResponse)),
    )
    .handle('delete', ({ params: { shortCode } }) =>
      Effect.gen(function* () {
        const service = yield* UrlService
        yield* service.deleteUrl(shortCode)
        return HttpServerResponse.jsonUnsafe({
          success: true as const,
          message: `URL '${shortCode}' deleted successfully`,
        })
      }).pipe(Effect.catch(urlErrorResponse)),
    ),
)
