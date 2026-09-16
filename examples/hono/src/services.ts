import {
  createTaggedError,
  ok,
  okAsync,
  Result,
  ResultTask,
  type StrictResultAsync,
} from "resultar";
import { createModule, Service, service } from "resultar-hono";

export type User = { readonly id: string; readonly name: string };

export class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}) {}

export class UserReadError extends createTaggedError({
  name: "UserReadError",
  message: "Could not read user $id",
}) {}

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
      return Result.gen(async function* () {
        const user = yield* repository.findById(id);
        if (user === undefined) return UserNotFoundError.err({ id });
        return ok(user);
      });
    },
    remove(id: string): StrictResultAsync<void, UserNotFoundError> {
      return Result.gen(async function* () {
        const removed = yield* repository.remove(id);
        if (!removed) return UserNotFoundError.err({ id });
        return ok(undefined);
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
