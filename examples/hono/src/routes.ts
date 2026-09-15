import type { AppHono } from "./main.ts";

export const usersRoutes = (app: AppHono) => {
  app.get("/users/:id", async (c) => {
    const result = await c.env.users.findById(c.req.param("id"));
    return result.matchTags((user) => c.json(user), {
      UserNotFoundError: () => c.json({ error: "User not found" }, 404),
      UserReadError: () => c.json({ error: "Temporarily unavailable" }, 503),
    });
  });
  app.delete("/users/:id", async (c) => {
    const result = await c.env.users.remove(c.req.param("id"));
    return result.match(
      () => c.body(null, 204),
      () => c.json({ error: "User not found" }, 404),
    );
  });
};

export const healthRoutes = (app: AppHono) => {
  app.get("/health", async (c) => {
    const result = await c.env.health.check();
    return result.match(
      (health) => c.json(health),
      () => c.json({ error: "Health unavailable" }, 503),
    );
  });
};
