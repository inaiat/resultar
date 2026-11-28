import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox'

import { Type } from 'typebox'

const healthRoute: FastifyPluginCallbackTypebox = (fastify, _options, done) => {
  fastify.get(
    '/health',
    {
      config: { resultar: { requestScope: false } },
      schema: {
        response: { 200: Type.Object({ ok: Type.Number() }) },
        tags: ['Health'],
        description: 'Health check endpoint',
      },
    },
    (_request, reply) => {
      reply.send({ ok: Date.now() })
    },
  )

  done()
}

export default healthRoute
