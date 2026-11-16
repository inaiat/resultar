import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createHonoApp, type InferRequestServices } from "resultar-hono";
import { appConfig } from "./app-config.ts";
import { healthRoutes, usersRoutes } from "./routes.ts";
import { createServices } from "./services.ts";

// The package infers context.env and keeps resources alive until the response finishes.
export const createApplication = (services = createServices()) =>
  createHonoApp({ services }, (app) => {
    usersRoutes(app);
    healthRoutes(app);
  });

export type AppHono = Hono<{ Bindings: InferRequestServices<typeof createApplication> }>;

if (import.meta.main) {
  const config = await appConfig.load().runResult();
  if (config.isErr()) {
    console.error("Invalid application configuration", config.error.issues);
    process.exitCode = 1;
  } else {
    const app = createApplication(createServices().override("appConfig", config.value));
    serve({ fetch: app.fetch, port: config.value.PORT }, (info) => {
      console.log(`Listening on http://${info.address}:${info.port}/`);
    });
  }
}
