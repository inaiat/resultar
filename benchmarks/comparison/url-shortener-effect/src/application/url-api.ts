import { Schema } from 'effect'
import { HttpServerResponse } from 'effect/http'
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from 'effect/http-api'

const expirationTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
  Schema.makeFilter(
    (value) => {
      const dateTime = value.slice(0, 19)
      const local = new Date(`${dateTime}Z`)
      return (
        Number.isFinite(Date.parse(value)) &&
        Number.isFinite(local.getTime()) &&
        local.toISOString().startsWith(dateTime)
      )
    },
    {
      expected: 'a valid date-time with a timezone',
      toJsonSchema: () => ({ format: 'date-time' }),
    },
  ),
)

const customAlias = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u),
)

const createUrl = Schema.Struct({
  originalUrl: Schema.NonEmptyString,
  customAlias: Schema.optional(customAlias),
  expiresAt: Schema.optional(expirationTimestamp),
})

const shortCodePath = Schema.Struct({ shortCode: Schema.String })
const url = Schema.Struct({
  id: Schema.String,
  shortCode: Schema.String,
  originalUrl: Schema.String,
  customAlias: Schema.optional(Schema.String),
  createdAt: Schema.String,
  lastAccessedAt: Schema.optional(Schema.NullOr(Schema.String)),
  accessCount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  isActive: Schema.Boolean,
})

const statsLimit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
)

const statsQuery = Schema.Struct({
  type: Schema.optional(Schema.Literals(['recent', 'popular'])),
  limit: Schema.optional(statsLimit),
})

const appError = Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.String,
  message: Schema.String,
  statusCode: Schema.Int,
})

export const respondWithError = (statusCode: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { success: false, error: message, message, statusCode },
    { status: statusCode },
  )

const notFound = appError.pipe(HttpApiSchema.status(404))
const internalError = appError.pipe(HttpApiSchema.status(500))
const health = Schema.Struct({ ok: Schema.Number })

const badRequest = appError.pipe(HttpApiSchema.status(400))
const success = Schema.Literal(true)
const createdUrl = Schema.Struct({ success, data: url }).pipe(HttpApiSchema.status(201))

const createEndpoint = HttpApiEndpoint.post('create', '/api/v1', {
  payload: createUrl,
  success: createdUrl,
  error: [
    badRequest,
    appError.pipe(HttpApiSchema.status(409)),
    appError.pipe(HttpApiSchema.status(413)),
    internalError,
  ],
})

const statsEndpoint = HttpApiEndpoint.get('stats', '/api/v1/stats', {
  query: statsQuery,
  success: Schema.Struct({ success, data: Schema.Array(url) }),
  error: [badRequest, internalError],
})

const redirectEndpoint = HttpApiEndpoint.get('redirect', '/api/v1/:shortCode', {
  params: shortCodePath,
  success: HttpApiSchema.Empty(302),
  error: [notFound, appError.pipe(HttpApiSchema.status(410)), internalError],
})

const deleteEndpoint = HttpApiEndpoint.post('delete', '/api/v1/:shortCode/delete', {
  params: shortCodePath,
  success: Schema.Struct({ success, message: Schema.String }),
  error: [notFound, internalError],
})

const urls = HttpApiGroup.make('urls').add(
  createEndpoint,
  statsEndpoint,
  redirectEndpoint,
  deleteEndpoint,
)

const probes = HttpApiGroup.make('health').add(
  HttpApiEndpoint.get('health', '/health', { success: health }),
  HttpApiEndpoint.get('live', '/live', { success: health }),
)

export const UrlApi = HttpApi.make('url-shortener')
  .add(urls)
  .add(probes)
  .annotate(OpenApi.Title, 'URL Shortener API')
  .annotate(OpenApi.Description, 'URL shortener service with Effect')
  .annotate(OpenApi.Version, '1.0.0')
