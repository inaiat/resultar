import { ByteSize, Cause, Effect, Layer } from 'effect'
import { HttpIncomingMessage, HttpRouter, HttpServerError, HttpServerRequest } from 'effect/http'
import { HttpApiBuilder, HttpApiError } from 'effect/http-api'

import { HealthRoutes } from './application/routes/health.route.js'
import { UrlRoutes } from './application/routes/url.route.js'
import { respondWithError, UrlApi } from './application/url-api.js'

const maxBodySize = 1024 * 1024

const errorMiddleware = HttpRouter.middleware(
  (app) =>
    Effect.catchCause(
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
        if (request.method === 'POST' && Number(request.headers['content-length']) > maxBodySize) {
          return Effect.succeed(respondWithError(413, 'Request body is too large'))
        }

        return Effect.provideService(
          app,
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(maxBodySize),
        )
      }),
      (cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause)
        }

        const error = Cause.squash(cause)
        if (HttpApiError.HttpApiPayloadTooLarge.is(error)) {
          return Effect.succeed(respondWithError(413, 'Request body is too large'))
        }
        if (HttpApiError.HttpApiSchemaError.is(error) && !error.kind.startsWith('Response')) {
          return Effect.succeed(respondWithError(400, 'Invalid request'))
        }
        if (error instanceof HttpServerError.HttpServerError) {
          const { reason } = error
          if (reason instanceof HttpServerError.RouteNotFound) {
            return Effect.succeed(respondWithError(404, reason.message))
          }
          if (reason instanceof HttpServerError.RequestParseError) {
            return Effect.succeed(
              reason.reason === 'BodyTooLarge'
                ? respondWithError(413, 'Request body is too large')
                : respondWithError(400, 'Invalid request'),
            )
          }
        }
        return Effect.as(
          Effect.logError(cause),
          respondWithError(500, 'Unexpected system error occurred'),
        )
      },
    ),
  { global: true },
)

const api = HttpApiBuilder.layer(UrlApi).pipe(Layer.provide([HealthRoutes, UrlRoutes]))

export const HttpAppLive = Layer.mergeAll(api, errorMiddleware)
