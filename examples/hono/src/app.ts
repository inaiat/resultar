import { createHonoApp } from "resultar-hono";
import { createServices } from "./services.ts";

// The package infers context.env and keeps resources alive until the response finishes.
export const createApplication = (services = createServices()) =>
  createHonoApp({ services, bindings: ["health", "users"] }, (app) => {
    app.get("/health", async (c) => {
      const result = await c.env.health.check();
      return result.match(
        (health) => c.json(health),
        () => c.json({ error: "Health unavailable" }, 503),
      );
    });
    app.get("/users/:id", async (c) => {
      const result = await c.env.users.find(c.req.param("id"));
      return result.match(
        (user) => c.json(user),
        () => c.json({ error: "User not found" }, 404),
      );
    });
    app.delete("/users/:id", async (c) => {
      const result = await c.env.users.remove(c.req.param("id"));
      return result.match(
        () => c.body(null, 204),
        () => c.json({ error: "User not found" }, 404),
      );
    });
  });
