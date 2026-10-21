import fastify, { type FastifyReply } from "fastify";
import { createTaggedError, errAsync, Match, okAsync, type ResultAsync } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { createFastifyPlugin, createModule, type InferRequestServices } from "../src/index.js";

class MissingError extends createTaggedError({
  name: "MissingError",
  message: "Missing $id",
}).withProps<{ id: string }>() {}
class OfflineError extends createTaggedError({ name: "OfflineError", message: "Offline" }) {}
type User = { id: string; name: string };
type Route = {
  Params: { id: string };
  Reply: { 200: User; 404: { error: string; id: string }; 503: { error: string } };
};
const find = (id: string): ResultAsync<User, MissingError | OfflineError> => {
  if (id === "1") return okAsync({ id, name: "Ada" });
  if (id === "offline") return errAsync(new OfflineError());
  return errAsync(new MissingError({ id }));
};

const respondError = Match.context<
  MissingError | OfflineError,
  [reply: FastifyReply<Route>]
>().tagsExhaustive({
  MissingError: (error, reply) => {
    expectTypeOf(error.id).toEqualTypeOf<string>();
    return reply.code(404).send({ error: error.message, id: error.id });
  },
  OfflineError: (error, reply) => reply.code(503).send({ error: error.message }),
});

test("Match.context maps typed native Fastify service errors and replies", async () => {
  const app = fastify();
  const plugin = createFastifyPlugin({ services: createModule().value("users", { find }) });
  app.register(plugin);
  app.get<Route>("/users/:id", async (request, reply) => {
    const services = request.getDecorator<InferRequestServices<typeof plugin>>("services");
    expectTypeOf(services.users.find).toEqualTypeOf<typeof find>();
    const result = await services.users.find(request.params.id);
    return result.match({
      ok: (user) => reply.code(200).send(user),
      error: (error) => respondError(error, reply),
    });
  });
  try {
    const found = await app.inject("/users/1");
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ id: "1", name: "Ada" });
    const missing = await app.inject("/users/2");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Missing 2", id: "2" });
    const offline = await app.inject("/users/offline");
    expect(offline.statusCode).toBe(503);
    expect(offline.json()).toEqual({ error: "Offline" });
  } finally {
    await app.close();
  }
});

const checkTypes = (reply: FastifyReply<Route>) => {
  Match.context<MissingError, [reply: FastifyReply<Route>]>().tagsExhaustive({
    MissingError: (_error, selectedReply) => {
      // @ts-expect-error Match preserves Fastify's status-specific response schema.
      selectedReply.code(404).send({ id: "1", name: "Ada" });
      return selectedReply;
    },
  })(new MissingError({ id: "1" }), reply);
};
expectTypeOf(checkTypes).toBeFunction();
