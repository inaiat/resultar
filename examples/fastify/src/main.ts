import { createFastifyApp, type InferRequestServices } from "resultar-fastify";
import { healthRoutes, usersRoutes } from "./routes.ts";
import { createServices } from "./services.ts";

export const createApplication = (services = createServices()) =>
  createFastifyApp({ services }, (app) => {
    app.register(usersRoutes);
    app.register(healthRoutes);
  });

declare module "fastify" {
  interface FastifyRequest {
    services: InferRequestServices<typeof createApplication>;
  }
}

if (import.meta.main) {
  const app = createApplication();
  await app.listen({ port: Number(process.env.PORT ?? 3000) });
}
