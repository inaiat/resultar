import { Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'

import { HttpAppLive } from '../../src/app.js'
import { createTestAppLayer } from './test-layers.js'

export const build = () => {
  const layer = createTestAppLayer()
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpAppLive.pipe(Layer.provideMerge(layer), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )

  return {
    handler,
    request: ({
      method = 'GET',
      url,
      payload,
    }: {
      method?: 'GET' | 'POST'
      url: string
      payload?: unknown
    }) =>
      handler(
        new Request(
          new URL(url, 'http://localhost'),
          payload === undefined
            ? { method }
            : {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              },
        ),
      ),
    close: dispose,
  }
}
