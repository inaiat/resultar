import { Type } from "typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

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
