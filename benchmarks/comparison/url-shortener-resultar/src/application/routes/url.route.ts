import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { Type } from 'typebox'

import type { UrlError } from '../../domain/errors/url.errors.js'
import {
  CreateUrlResponse,
  CreateUrlRequest,
  DeleteUrlResponse,
  UrlStatsResponse,
  requestToCreateUrlInput,
  urlErrorStatusByTag,
  urlToResponse,
  urlsToResponses,
} from './url.schemas.js'

const errorResponse = Type.Object({ error: Type.String() })
const redirectResponse = Type.String({
  description: 'Redirect response',
  headers: { Location: Type.String({ format: 'uri' }) },
})
const shortCodeParams = Type.Object({ shortCode: Type.String() })
const statsType = Type.Enum(['recent', 'popular'])
const statsLimit = Type.Number({ minimum: 1, maximum: 100, multipleOf: 1 })
const noRequestScope = { resultar: { requestScope: false } } as const

const createUrlSchema = {
  body: CreateUrlRequest,
  response: { 201: CreateUrlResponse, 400: errorResponse, 409: errorResponse, 500: errorResponse },
  tags: ['URL'],
  description: 'Create a new short URL',
}

const redirectUrlSchema = {
  params: shortCodeParams,
  response: { 302: redirectResponse, 404: errorResponse, 410: errorResponse, 500: errorResponse },
  tags: ['URL'],
  description: 'Redirect to the original URL',
}

const deleteUrlSchema = {
  params: shortCodeParams,
  response: { 200: DeleteUrlResponse, 404: errorResponse, 500: errorResponse },
  tags: ['URL'],
  description: 'Soft delete a URL',
}

const urlStatsSchema = {
  querystring: Type.Object({ type: Type.Optional(statsType), limit: Type.Optional(statsLimit) }),
  response: { 200: UrlStatsResponse, 400: errorResponse, 500: errorResponse },
  tags: ['URL'],
  description: 'Get URL statistics',
}

const sendUrlError = (request: FastifyRequest, reply: FastifyReply, error: UrlError) => {
  const status = urlErrorStatusByTag[error._tag]
  if (status >= 500) {
    request.log.error({ err: error }, 'Request failed')
    return reply.code(status).send({ error: 'Internal Server Error' })
  }
  return reply.code(status).send({ error: error.message })
}

const urlRoute: FastifyPluginCallbackTypebox = (fastify, _options, done) => {
  const { urlUseCase } = fastify.services

  /**
   * Create short URL
   */
  fastify.post(
    '/api/v1',
    { config: noRequestScope, schema: createUrlSchema },
    async (request, reply) => {
      const urlData = requestToCreateUrlInput(request.body)

      const result = await urlUseCase.createShortUrl(urlData, request.log).runResult()
      if (result.isErr()) {
        return sendUrlError(request, reply, result.error)
      }
      return reply.code(201).send({ success: true, data: urlToResponse(result.value) })
    },
  )

  /**
   * Redirect to original URL
   */
  fastify.get(
    '/api/v1/:shortCode',
    { config: noRequestScope, schema: redirectUrlSchema },
    async (request, reply) => {
      const { shortCode } = request.params

      const result = await urlUseCase.getOriginalUrl(shortCode, request.log).runResult()
      if (result.isErr()) {
        return sendUrlError(request, reply, result.error)
      }
      return reply.redirect(result.value)
    },
  )

  /**
   * Soft delete URL
   */
  fastify.post(
    '/api/v1/:shortCode/delete',
    { config: noRequestScope, schema: deleteUrlSchema },
    async (request, reply) => {
      const { shortCode } = request.params

      const result = await urlUseCase.deleteUrl(shortCode, request.log).runResult()
      if (result.isErr()) {
        return sendUrlError(request, reply, result.error)
      }
      return reply.send({ success: true, message: `URL '${shortCode}' deleted successfully` })
    },
  )

  /**
   * Get URL statistics (recent or popular)
   */
  fastify.get(
    '/api/v1/stats',
    { config: noRequestScope, schema: urlStatsSchema, serializerCompiler: () => JSON.stringify },
    async (request, reply) => {
      const { type = 'recent', limit = 10 } = request.query

      const result = await (
        type === 'popular' ? urlUseCase.getPopularUrls(limit) : urlUseCase.getRecentUrls(limit)
      ).runResult()
      if (result.isErr()) {
        return sendUrlError(request, reply, result.error)
      }
      return reply.send({ success: true, data: urlsToResponses(result.value) })
    },
  )

  done()
}

export default urlRoute
