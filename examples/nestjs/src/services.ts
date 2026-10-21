import { createTaggedError, okAsync, Result, ResultTask, type StrictResultAsync } from "resultar";
import { createModule, Service, service, type NestRequestLogger } from "resultar-nestjs";

export type User = { readonly id: string; readonly name: string };

export const Log = ResultTask.service<NestRequestLogger, "log">("log");

export class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}).withProps<{ id: string }>() {}

export class UserReadError extends createTaggedError({
  name: "UserReadError",
  message: "Could not read user $id",
}).withProps<{ id: string }>() {}

export class Cache extends Service("cache", {
  make: ResultTask.sync(() => new Map<string, User>([["1", { id: "1", name: "Ada" }]])),
}) {}

export class UsersRepository extends Service("repository", {
  requires: { cache: Cache },
  make: ({ cache }) => ({
    findById(id: string): StrictResultAsync<User | undefined, UserReadError> {
      return okAsync(cache.get(id));
    },
    remove(id: string): StrictResultAsync<boolean, never> {
      return okAsync(cache.delete(id));
    },
  }),
}) {}

export class Users extends Service("users", {
  requires: { repository: UsersRepository, log: Log },
  make: ({ repository, log }) => ({
    findById(id: string): StrictResultAsync<User, UserNotFoundError | UserReadError> {
      return Result.gen(async function* () {
        log.info({ id }, "Looking up user");
        const user = yield* repository.findById(id);
        if (user === undefined) {
          log.warn({ id }, "User not found");
          return yield* UserNotFoundError.err({ id });
        }
        return user;
      });
    },
    remove(id: string): StrictResultAsync<void, UserNotFoundError> {
      return Result.gen(async function* () {
        const removed = yield* repository.remove(id);
        if (!removed) return yield* UserNotFoundError.err({ id });
      });
    },
  }),
}) {}

export const Health = service("health", { cache: Cache }, ({ cache }) => ({
  check() {
    return okAsync({ status: "ok", users: cache.size });
  },
}));

export const createServices = () =>
  createModule().singleton(Cache).singleton(UsersRepository).scoped(Users).scoped(Health);
