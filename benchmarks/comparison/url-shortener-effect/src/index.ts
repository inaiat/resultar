import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Exit, Layer, References, Runtime } from 'effect'
import { HttpRouter } from 'effect/http'
import { createServer } from 'node:http'

import { HttpAppLive } from './app.js'
import { AppConfigLive, AppConfigTag } from './infrastructure/app-config.js'
import { UrlAppLive } from './infrastructure/app-services.js'

const NodeServerLive = Layer.unwrap(
  Effect.map(AppConfigTag, (config) =>
    NodeHttpServer.layer(createServer, { port: config.PORT, host: config.HOST }),
  ),
).pipe(Layer.provide(AppConfigLive))

const logErrorsOnly = Effect.provideService(References.MinimumLogLevel, 'Error')
const server = HttpRouter.serve(HttpAppLive, {
  disableLogger: true,
  middleware: logErrorsOnly,
}).pipe(Layer.provide(UrlAppLive), Layer.provide(NodeServerLive))

NodeRuntime.runMain(logErrorsOnly(Layer.launch(server)), {
  teardown(exit, onExit) {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      onExit(0)
      return
    }

    Runtime.defaultTeardown(exit, onExit)
  },
})
