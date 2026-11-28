import { ResultTask, ResultTaskCauseError } from 'resultar'
import { createApp } from './app.js'
import { appConfig } from './infrastructure/app-config.js'

const controller = new AbortController()
const shutdown = () => {
  controller.abort('process shutdown')
}
const program = ResultTask.gen(function* () {
  const settings = yield* appConfig.load()
  const app = yield* ResultTask.acquireRelease({
    acquire: ResultTask.sync(() => createApp(settings)),
    release: (server) => ResultTask.fromPromise(async () => server.close()),
  })
  yield* ResultTask.fromPromise(async () =>
    app.listen({ host: settings.HOST, port: settings.PORT }),
  )
  return yield* ResultTask.never()
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
const exit = await program.runExit({ signal: controller.signal })
process.off('SIGINT', shutdown)
process.off('SIGTERM', shutdown)

if (exit._tag === 'Failure' && exit.cause._tag !== 'Interrupt') {
  throw new ResultTaskCauseError(exit.cause)
}
