import {
  createTaggedError,
  fromPromise,
  ok,
  safeTry,
  tryResult,
  type StrictResult,
  type StrictResultAsync,
} from "resultar";

interface User {
  readonly email: string;
  readonly id: string;
}

class InvalidEmailError extends createTaggedError({
  name: "InvalidEmailError",
  message: "Invalid email $email",
}) {}

class UserAlreadyExistsError extends createTaggedError({
  name: "UserAlreadyExistsError",
  message: "User $email already exists",
}) {}

class ParseUserError extends createTaggedError({
  name: "ParseUserError",
  message: "Failed to parse user payload",
}) {}

class FetchUserError extends createTaggedError({
  name: "FetchUserError",
  message: "Failed to fetch user $id",
}) {}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });

const ensureUserDoesNotExist = (email: string): StrictResult<string, UserAlreadyExistsError> =>
  email === "taken@example.com" ? UserAlreadyExistsError.err({ email }) : ok(email);

const insertUser = (email: string): StrictResult<User, never> =>
  ok({ email, id: `usr_${email.length}` });

export const createUser = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser);

export const createUserWithSafeTry = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email);
    const availableEmail = yield* ensureUserDoesNotExist(validEmail);

    return insertUser(availableEmail);
  });

export const parseUser = (input: string): StrictResult<User, ParseUserError> =>
  tryResult(
    () => JSON.parse(input) as User,
    (cause) => new ParseUserError({ cause }),
  );

export const loadUser = (id: string): StrictResultAsync<User, FetchUserError> =>
  fromPromise(
    Promise.resolve({ email: `${id}@example.com`, id }),
    (cause) => new FetchUserError({ cause, id }),
  );

export const createUserResponse = (email: string) =>
  createUser(email).matchTags((user) => ({ body: user, statusCode: 201 }), {
    InvalidEmailError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 400,
    }),
    UserAlreadyExistsError: (error) => ({
      body: { code: error._tag, message: error.message },
      statusCode: 409,
    }),
  });

export const normalizedUserId = (email: string): StrictResult<string, InvalidEmailError> =>
  validateEmail(email)
    .map((value) => value.trim().toLowerCase())
    .andThen((value) => ok(`user:${value}`));

export const parseUserResponse = (input: string) =>
  parseUser(input).mapErr((cause) => new ParseUserError({ cause }));
