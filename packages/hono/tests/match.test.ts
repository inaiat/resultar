/* eslint-disable unicorn/no-await-expression-member */
import { Hono, type Context, type Env } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { createTaggedError, errAsync, Match, okAsync, type ResultAsync } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { createHonoServices, createModule } from "../src/index.js";

class MissingError extends createTaggedError({
  name: "MissingError",
  message: "Missing $id",
}).withProps<{ id: string }>() {}
class OfflineError extends createTaggedError({ name: "OfflineError", message: "Offline" }) {}
type User = { id: string; name: string };
const find = (id: string): ResultAsync<User, MissingError | OfflineError> => {
  if (id === "1") return okAsync({ id, name: "Ada" });
  if (id === "offline") return errAsync(new OfflineError());
  return errAsync(new MissingError({ id }));
};

type AppEnv = Env & {
  Variables: { traceId: string; services: Readonly<{ users: { find: typeof find } }> };
};
const respondError = Match.context<
  MissingError | OfflineError,
  [context: Context<AppEnv, "/users/:id">]
>().tagsExhaustive({
  MissingError: (error, c) => {
    expectTypeOf(error.id).toEqualTypeOf<string>();
    expectTypeOf(c.get("traceId")).toEqualTypeOf<string>();
    c.header("x-trace-id", c.get("traceId"));
    return c.json({ error: error.message, id: error.id }, 404);
  },
  OfflineError: async (error, c) => c.json({ error: error.message }, 503),
});

test("Match.context preserves Hono variables, RPC payloads and statuses with async handlers", async () => {
  const di = createHonoServices(createModule().value("users", { find }));
  const app = new Hono<AppEnv>()
    .use("*", (c, next) => {
      c.set("traceId", "trace-1");
      return next();
    })
    .get("/users/:id", di.middleware(["users"]), async (c) => {
      const result = await c.var.services.users.find(c.req.param("id"));
      return result.match({
        ok: (user) => c.json(user, 200),
        error: (error) => respondError(error, c),
      });
    });
  const client = hc<typeof app>("http://localhost", {
    fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
  });
  const get = client.users[":id"].$get;
  expectTypeOf<InferResponseType<typeof get, 200>>().toEqualTypeOf<User>();
  expectTypeOf<InferResponseType<typeof get, 404>>().toEqualTypeOf<{ error: string; id: string }>();
  expectTypeOf<InferResponseType<typeof get, 503>>().toEqualTypeOf<{ error: string }>();
  const found = await get({ param: { id: "1" } });
  expect(found.status).toBe(200);
  expect(await found.json()).toEqual({ id: "1", name: "Ada" });
  const missing = await get({ param: { id: "2" } });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("x-trace-id")).toBe("trace-1");
  expect(await missing.json()).toEqual({ error: "Missing 2", id: "2" });
  const offline = await get({ param: { id: "offline" } });
  expect(offline.status).toBe(503);
  expect(await offline.json()).toEqual({ error: "Offline" });
  expect((await di.close()).isOk()).toBe(true);
});
