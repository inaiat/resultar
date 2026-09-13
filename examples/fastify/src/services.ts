import { createModule, service } from "resultar-di";
import { createFastifyPlugin, type InferRequestServices } from "resultar-fastify";
import { createUsersService, type UsersRepository } from "./users.ts";

export const createServices = (repository: UsersRepository) => {
  const Repository = service("repository", {}, () => repository);
  const Users = service("users", { repository: Repository }, createUsersService);
  return createFastifyPlugin({
    services: createModule().singleton(Repository).scoped(Users),
    bindings: ["users"],
  });
};

type RequestServices = InferRequestServices<ReturnType<typeof createServices>>;

declare module "fastify" {
  interface FastifyRequest {
    services: RequestServices;
  }
}
