import { FastifyAdapter } from "@nestjs/platform-fastify";
import { createNestApp } from "resultar-nestjs";
import { HealthController, UsersController } from "./routes.ts";
import { createServices } from "./services.ts";

export const createApplication = (services = createServices()) =>
  createNestApp({
    adapter: new FastifyAdapter({ logger: true }),
    services,
    locals: (request) => ({ log: request.log }),
    controllers: [UsersController, HealthController],
    logger: ["error", "warn"],
  });

if (import.meta.main) {
  const app = createApplication();
  await app.listen({ port: Number(process.env.PORT ?? 3000) });
}
