import { Type } from "typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

// Fastify's plugin callback uses its native async lifecycle contract.
// resultar-check-disable-next-line prefer-result-async
export const usersRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/users/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        response: {
          200: Type.Object({ id: Type.String(), name: Type.String() }),
          404: Type.Object({ error: Type.String() }),
          503: Type.Object({ error: Type.String() }),
        },
      },
    },
    // Fastify awaits the HTTP reply after the Resultar channel has been matched.
    // resultar-check-disable-next-line prefer-result-async
    async (request, reply) => {
      const result = await request.services.users.findById(request.params.id);
      return result.matchTags((user) => reply.code(200).send(user), {
        UserNotFoundError: (error) => reply.code(404).send({ error: error.message }),
        UserReadError: (error) => {
          request.log.error({ err: error }, "User lookup failed");
          return reply.code(503).send({ error: "Temporarily unavailable" });
        },
      });
    },
  );
};
