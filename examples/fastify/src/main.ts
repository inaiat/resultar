import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { createServices } from "./services.ts";
import { usersRoutes } from "./routes.ts";

export const createApplication = (): FastifyInstance => {
  const app = Fastify();
  app.register(createServices());
  app.register(usersRoutes);
  return app;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApplication();

  await app.listen({ port: 3000, host: "127.0.0.1" });
  process.once("SIGINT", () => {
    app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
