import autoload from '@fastify/autoload'
import { fileURLToPath } from 'node:url'
import { LogController, type FastifyServerOptions } from 'fastify'
import { createFastifyApp } from 'resultar-fastify'

import { urlErrorStatusByTag } from './application/routes/url.schemas.js'
import {
  createAppServices,
  type AppConfig,
  type ServiceOverrides,
} from './infrastructure/app-services.js'

type CreateAppOptions = { overrides?: ServiceOverrides; server?: FastifyServerOptions }

export const createApp = (settings: AppConfig, { overrides, server }: CreateAppOptions = {}) =>
  createFastifyApp(
    {
      logger: { level: 'error' },
      logController: new LogController({ disableRequestLogging: true }),
      ...server,
      ...createAppServices(settings, overrides),
      httpErrors: { statusByTag: urlErrorStatusByTag },
    },
    (app) => {
      app.register(autoload, {
        dir: fileURLToPath(new URL('application/routes/', import.meta.url)),
        matchFilter: /\.route\.(?:ts|js)$/u,
        dirNameRoutePrefix: false,
      })
    },
  )
