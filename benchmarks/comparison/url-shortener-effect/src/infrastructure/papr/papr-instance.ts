import { Context, Effect, Layer } from 'effect'
import Papr from 'papr'

import { MongoDatabaseService } from '../database/mongo-database.js'

export class PaprInstance extends Context.Service<PaprInstance>()('app/PaprInstance', {
  make: Effect.gen(function* () {
    const db = yield* MongoDatabaseService
    const papr = new Papr()
    papr.initialize(db)
    return papr
  }),
}) {
  static readonly Default = Layer.effect(this, this.make)
}
