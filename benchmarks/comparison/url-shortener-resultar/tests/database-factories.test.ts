import { createFastifyPlugin, type InferAppServices } from 'resultar-fastify'
import { createMongoPaprModule } from '../src/infrastructure/database/mongo-database.js'
import fastify from 'fastify'
import { describe, expect, it, vi } from 'vite-plus/test'

const services = createMongoPaprModule({
  databaseName: 'url_shortener_v2_test',
  startupTimeoutMs: 2000,
  url: 'mongodb://127.0.0.1:27017',
})

describe('database factories', () => {
  it('assembles and disposes the shared MongoDB and Papr graph without connecting', async () => {
    const app = fastify({ logger: false })
    const plugin = createFastifyPlugin({
      services,
      appBindings: [
        'mongoClient',
        'mongoDatabase',
        'mongoPaprProvisioningService',
        'papr',
        'urlCollection',
      ],
      bindings: [],
    })
    await app.register(plugin)
    await app.ready()

    const {
      mongoClient,
      mongoDatabase,
      mongoPaprProvisioningService,
      papr,
      urlCollection: urlsModel,
    } = app.getDecorator<InferAppServices<typeof plugin>>('services')
    const close = vi.spyOn(mongoClient, 'close')

    expect(app.getDecorator<InferAppServices<typeof plugin>>('services').mongoClient).toBe(
      mongoClient,
    )
    expect(mongoDatabase.databaseName).toBe('url_shortener_v2_test')
    expect(papr.db).toBe(mongoDatabase)
    expect(mongoPaprProvisioningService.provision).toBeTypeOf('function')
    expect(urlsModel.collection.collectionName).toBe('urls')
    expect('findCursor' in urlsModel).toBe(false)

    await app.close()

    expect(close).toHaveBeenCalledOnce()
  })
})
