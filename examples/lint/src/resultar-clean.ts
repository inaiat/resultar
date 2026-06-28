import {
  createTaggedError,
  fromPromise,
  ok,
  runPromise,
  safeTry,
  tryResult,
  tryResultAsync,
  type Result,
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

class StartupTaskError extends createTaggedError({
  name: "StartupTaskError",
  message: "Startup task failed: $label",
}) {}

interface FastifyLifecycle {
  after(): Promise<void>;
}

const validateEmail = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes("@") ? ok(email) : InvalidEmailError.err({ email });

const ensureUserDoesNotExist = (email: string): StrictResult<string, UserAlreadyExistsError> =>
  email === "taken@example.com" ? UserAlreadyExistsError.err({ email }) : ok(email);

const insertUser = (email: string): StrictResult<User, never> =>
  ok({ email, id: `usr_${email.length}` });

const fetchUserRecord = async (id: string): Promise<User> => ({
  email: `${id}@example.com`,
  id,
});

// no-discard: returning the Result keeps the caller responsible for the channel.
export const createUser = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  validateEmail(email).andThen(ensureUserDoesNotExist).andThen(insertUser);

// no-discard: explicitly void only when the project intentionally ignores the
// channel, for example in a fire-and-forget metric.
export const intentionallyDiscardValidation = (email: string): void => {
  void validateEmail(email);
};

// no-discard: match/matchTags/unwrapOr/unwrapOrThrow are consumers, so the
// Result is handled and no must-use diagnostic is emitted.
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

// prefer-and-then: use andThen when the callback returns another Result.
export const createUserWithSafeTry = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email);
    const availableEmail = yield* ensureUserDoesNotExist(validEmail);

    return insertUser(availableEmail);
  });

// typed-catch-mapper: map thrown values to a typed Resultar error.
export const parseUser = (input: string): StrictResult<User, ParseUserError> =>
  tryResult(
    () => JSON.parse(input) as User,
    (cause) => new ParseUserError({ cause }),
  );

// typed-catch-mapper: the object form is also valid when it includes catch.
export const parseUserFromObjectBoundary = (input: string): StrictResult<User, ParseUserError> =>
  tryResult({
    try: () => JSON.parse(input) as User,
    catch: (cause) => new ParseUserError({ cause }),
  });

// no-unsafe-await: raw Promise work is placed inside tryResultAsync so rejections
// become FetchUserError instead of escaping as rejected Promises.
export const loadUser = (id: string): StrictResultAsync<User, FetchUserError> =>
  tryResultAsync({
    try: async () => await fetchUserRecord(id),
    catch: (cause) => new FetchUserError({ cause, id }),
  });

// no-unsafe-await: fromPromise is another safe boundary for existing Promises.
export const loadUserWithFromPromise = (id: string): StrictResultAsync<User, FetchUserError> =>
  fromPromise(fetchUserRecord(id), (cause) => new FetchUserError({ cause, id }));

// no-unsafe-await: runPromise is a final boundary. Awaiting it is allowed only
// when its argument is ResultAsync, because errors have already been captured.
export const loadUserAtPromiseBoundary = async (id: string): Promise<User> =>
  await runPromise(loadUser(id));

// noUnsafeAwaitIgnoreCalls: project-level escape hatches are exact. This is
// clean because tsconfig.json configures ["fastify.after"].
export const waitForFastifyLifecycle = async (fastify: FastifyLifecycle): Promise<void> => {
  await fastify.after();
};

// prefer-map-err: mapErr transforms the error side without pretending to recover
// the Ok side.
export const parseUserResponse = (input: string): Result<User, ParseUserError> =>
  parseUser(input).mapErr((cause) => new ParseUserError({ cause }));

// prefer-and-then: andThen keeps fallible composition flat instead of producing
// Result<Result<...>, ...>.
export const normalizedUserId = (email: string): StrictResult<string, InvalidEmailError> =>
  validateEmail(email)
    .map((value) => value.trim().toLowerCase())
    .andThen((value) => ok(`user:${value}`));

// unsafe-result-type-assertion: widen error channels by assignment or map them
// explicitly; do not narrow possible errors with `as`.
export const widenErrorChannel = (
  result: Result<User, InvalidEmailError>,
): Result<User, InvalidEmailError | ParseUserError> => result;

// no-useless-recovery: an infallible Result has error type never, so there is no
// recovery branch to map. Continue with map/andThen instead.
export const infallibleUserId = (): Result<string, never> =>
  ok<User, never>({ email: "ok@example.com", id: "ok" }).map((user) => user.id);

// no-try-catch-in-safe-try and yield-star-in-safe-try: compose Resultar values
// directly inside safeTry; use yield* for every Result/ResultAsync value.
export const createUserWithGenerator = (
  email: string,
): StrictResult<User, InvalidEmailError | UserAlreadyExistsError> =>
  safeTry(function* () {
    const validEmail = yield* validateEmail(email);
    const availableEmail = yield* ensureUserDoesNotExist(validEmail);

    return insertUser(availableEmail);
  });

export const runStartupTask = (
  label: string,
  task: () => Promise<void>,
): StrictResultAsync<void, StartupTaskError> =>
  tryResultAsync({
    try: task,
    catch: (cause) => new StartupTaskError({ cause, label }),
  });
