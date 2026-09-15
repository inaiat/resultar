import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createHonoApp, type InferRequestServices } from "resultar-hono";
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
  const app = createApplication();
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => {
    console.log(`Listening on http://${info.address}:${info.port}/`);
  });
}
