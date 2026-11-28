import { Clock, Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'

import { UrlApi } from '../url-api.js'

const liveness = Clock.currentTimeMillis.pipe(
  Effect.map((now) => HttpServerResponse.jsonUnsafe({ ok: now })),
)

export const HealthRoutes = HttpApiBuilder.group(UrlApi, 'health', (handlers) =>
  handlers.handle('health', () => liveness).handle('live', () => liveness),
)
