import { Controller, Get, Param, Res } from "@nestjs/common";
import { createTaggedError, errAsync, Match, okAsync, type ResultAsync } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createNestApp,
  createNestModule,
  createModule,
  Services,
  type InferRequestServices,
} from "../src/index.js";

class MissingError extends createTaggedError({
  name: "MissingError",
  message: "Missing $id",
}).withProps<{ id: string }>() {}
class OfflineError extends createTaggedError({ name: "OfflineError", message: "Offline" }) {}
type User = { id: string; name: string };
interface TypedReply {
  readonly status: ((code: 200) => { readonly send: (body: User) => User }) &
    ((code: 404) => {
      readonly send: (body: { error: string; id: string }) => { error: string; id: string };
    }) &
    ((code: 503) => { readonly send: (body: { error: string }) => { error: string } });
}

const find = (id: string): ResultAsync<User, MissingError | OfflineError> => {
  if (id === "1") return okAsync({ id, name: "Ada" });
  if (id === "offline") return errAsync(new OfflineError());
  return errAsync(new MissingError({ id }));
};

const respondError = Match.context<
  MissingError | OfflineError,
  [reply: TypedReply]
>().tagsExhaustive({
  MissingError: (error, reply) => {
    expectTypeOf(error.id).toEqualTypeOf<string>();
    return reply.status(404).send({ error: error.message, id: error.id });
  },
  OfflineError: (error, reply) => reply.status(503).send({ error: error.message }),
});

test("Match.context maps typed native NestJS service errors and replies", async () => {
  const nestModule = createNestModule({ services: createModule().value("users", { find }) });
  type ReqServices = InferRequestServices<typeof nestModule>;

  @Controller("users")
  class UsersController {
    @Get(":id")
    async byId(
      @Param("id") id: string,
      @Services() services: ReqServices,
      @Res() reply: TypedReply,
    ) {
      expectTypeOf(services.users.find).toEqualTypeOf<typeof find>();
      const result = await services.users.find(id);
      return result.match({
        ok: (user) => reply.status(200).send(user),
        error: (error) => respondError(error, reply),
      });
    }
  }

  const app = createNestApp({
    services: createModule().value("users", { find }),
    controllers: [UsersController],
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

const checkTypes = (reply: TypedReply) => {
  Match.context<MissingError, [reply: TypedReply]>().tagsExhaustive({
    MissingError: (_error, selectedReply) => {
      // @ts-expect-error Match preserves status-specific response schema.
      selectedReply.status(404).send({ id: "1", name: "Ada" });
      return selectedReply;
    },
  })(new MissingError({ id: "1" }), reply);
};
expectTypeOf(checkTypes).toBeFunction();
