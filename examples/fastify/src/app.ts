import Fastify, { type FastifyInstance } from "fastify";
import { createServices } from "./services.ts";
import { usersRoutes } from "./routes.ts";
import type { UsersRepository } from "./users.ts";

export const createApplication = async (repository: UsersRepository): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(createServices(repository));
  await app.register(usersRoutes);
  return app;
};
