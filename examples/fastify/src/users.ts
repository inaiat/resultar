import { createTaggedError, ok, tryResultAsync, type StrictResult } from "resultar";

export type User = { readonly id: string; readonly name: string };
export interface UsersRepository {
  readonly findById: (id: string) => Promise<User | undefined>;
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
  readonly findById: (id: string) => Promise<StrictResult<User, UserNotFoundError | UserReadError>>;
}

/** Plain business logic: usable with or without a DI module or an HTTP framework. */
export const createUsersService = ({
  repository,
}: {
  readonly repository: UsersRepository;
}): UsersService => ({
  async findById(id) {
    const result = await tryResultAsync(
      () => repository.findById(id),
      (cause) => new UserReadError({ id, cause }),
    );
    return result.andThen((user) =>
      user === undefined ? UserNotFoundError.err({ id }) : ok(user),
    );
  },
});
