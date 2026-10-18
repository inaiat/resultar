import { createTaggedError, ResultTask } from "resultar";
import { gen as genAsync, okAsync, type StrictResultAsync } from "resultar/async";
import { createModule, Service, service } from "resultar-fastify";

export type User = { readonly id: string; readonly name: string };

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
  requires: { repository: UsersRepository },
  make: ({ repository }) => ({
    findById(id: string): StrictResultAsync<User, UserNotFoundError | UserReadError> {
      return genAsync(async function* () {
        const user = yield* repository.findById(id);
        if (user === undefined) return yield* UserNotFoundError.err({ id });
        return user;
      });
    },
    remove(id: string): StrictResultAsync<void, UserNotFoundError> {
      return genAsync(async function* () {
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
