import { createTaggedError, ok, type StrictResultAsync } from "resultar";

export type User = { readonly id: string; readonly name: string };
export interface UsersRepository {
  readonly findById: (id: string) => StrictResultAsync<User | undefined, UserReadError>;
}

export class UserNotFoundError extends createTaggedError({
  name: "UserNotFoundError",
  message: "User $id was not found",
}) {}

export class UserReadError extends createTaggedError({
  name: "UserReadError",
  message: "Could not read user $id",
}) {}

export interface UsersService {
  readonly findById: (id: string) => StrictResultAsync<User, UserNotFoundError | UserReadError>;
}

/** Plain business logic: usable with or without a DI module or an HTTP framework. */
export const createUsersService = ({
  repository,
}: {
  readonly repository: UsersRepository;
}): UsersService => ({
  findById(id) {
    return repository
      .findById(id)
      .andThen((user) => (user === undefined ? UserNotFoundError.err({ id }) : ok(user)));
  },
});
