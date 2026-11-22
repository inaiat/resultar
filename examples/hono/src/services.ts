import {
  createModule,
  createTaggedError,
  ResultTask,
  Service,
  service,
  type StrictResultTask,
} from "resultar-app";
import { appConfig } from "./app-config.ts";

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
    findById(id: string): StrictResultTask<User | undefined, UserReadError> {
      return ResultTask.sync(() => cache.get(id));
    },
    remove(id: string): StrictResultTask<boolean, never> {
      return ResultTask.sync(() => cache.delete(id));
    },
  }),
}) {}

export class Users extends Service("users", {
  requires: { repository: UsersRepository },
  make: ({ repository }) => ({
    findById(id: string): StrictResultTask<User, UserNotFoundError | UserReadError> {
      return ResultTask.gen(function* () {
        const user = yield* repository.findById(id);
        if (user === undefined) return yield* UserNotFoundError.taskErr({ id });
        return user;
      });
    },
    remove(id: string): StrictResultTask<void, UserNotFoundError> {
      return ResultTask.gen(function* () {
        const removed = yield* repository.remove(id);
        if (!removed) return yield* UserNotFoundError.taskErr({ id });
      });
    },
  }),
}) {}

export const Health = service("health", { cache: Cache }, ({ cache }) => ({
  check() {
    return ResultTask.sync(() => ({ status: "ok", users: cache.size }));
  },
}));

export const createServices = (config = appConfig) =>
  createModule()
    .merge(config)
    .singleton(Cache)
    .singleton(UsersRepository)
    .scoped(Users)
    .scoped(Health);
