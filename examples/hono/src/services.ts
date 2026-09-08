import { createTaggedError, errAsync, okAsync, ResultTask, type ResultAsync } from "resultar";
import { createModule, service, Service } from "resultar-di";

export interface User {
  readonly id: string;
  readonly name: string;
}

export class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}) { }

const Cache = service(
  "cache",
  ResultTask.sync(() => new Map<string, User>([["1", { id: "1", name: "Ada" }]])),
);

export class Users extends Service("users", {
  make: ResultTask.gen(function* () {
    const cache = yield* Cache;
    return {
      find: (id: string): ResultAsync<User, UserNotFoundError> => {
        const user = cache.get(id);
        return user === undefined ? errAsync(new UserNotFoundError({ id })) : okAsync(user);
      },
      remove: (id: string): ResultAsync<void, UserNotFoundError> =>
        cache.delete(id) ? okAsync(undefined) : errAsync(new UserNotFoundError({ id })),
    };
  }),
}) {}
const Health = service("health", { cache: Cache }, ({ cache }) => ({
  check: () => okAsync({ status: "ok", users: cache.size }),
}));

// Shared cache; fresh services per request. None need release.
export const createServices = () => createModule().singleton(Cache).scoped(Users).scoped(Health);
