import {
  createTaggedError,
  err,
  ok,
  okAsync,
  Result,
  ResultTask,
  safeTry,
  tryResult,
  type ResultAsync,
} from "resultar";

interface User {
  readonly email: string;
  readonly id: string;
}

class SaveUserError extends createTaggedError({
  name: "SaveUserError",
  message: "Could not save user $id",
}) {}

class ParseUserError extends createTaggedError({
  name: "ParseUserError",
  message: "Could not parse user payload",
}) {}

class FetchUserError extends createTaggedError({
  name: "FetchUserError",
  message: "Could not fetch user $id",
}) {}

// resultar/prefer-tagged-error: domain errors in Resultar channels should use
// createTaggedError, not a plain native Error subclass.
class LegacyDomainError extends Error {}

// resultar/tagged-error-name-match: the runtime tag should match the TypeScript
// class name so matchTags/catchTag handlers stay predictable.
export class MismatchedTaggedError extends createTaggedError({
  name: "DifferentTaggedError",
  message: "This tag name should match the class name",
}) {}

// resultar/no-tagged-error-constructor-override: createTaggedError owns the
// constructor because it wires template props, cause, _tag, and serialization.
export class TaggedErrorWithConstructor extends createTaggedError({
  name: "TaggedErrorWithConstructor",
  message: "The generated constructor should not be overridden",
}) {
  constructor() {
    super();
  }
}

const saveUser = (id: string): Result<User, SaveUserError> =>
  id === "" ? SaveUserError.err({ id }) : ok({ email: `${id}@example.com`, id });

const saveUserAsync = (id: string): ResultAsync<User, SaveUserError> =>
  okAsync({ email: `${id}@example.com`, id });

const fetchUser = async (id: string): Promise<User> => ({ email: `${id}@example.com`, id });

const loadUserTask = (id: string): ResultTask<User, FetchUserError> =>
  ResultTask.tryPromise({
    try: async () => fetchUser(id),
    catch: (cause) => new FetchUserError({ cause, id }),
  });

const inspect = (_value: unknown): void => {};

// resultar/no-discard: Result and ResultAsync are must-use values. A bare
// expression statement drops the success/error channel on the floor.
saveUser("ignored-sync");
saveUserAsync("ignored-async");

// Explicit void is the escape hatch when ignoring the channel is deliberate.
void saveUser("explicit-void");

const assigned = saveUser("assigned");

// resultar/no-discard in must-use mode: assigning a Result is not enough. The
// assigned value must still be matched, unwrapped, returned, or explicitly voided.
const unhandled = saveUser("unhandled");
inspect(unhandled);

const handled = saveUser("handled");

export const returned = (): Result<User, SaveUserError> => saveUser("returned");

export const awaitedResultAsync = async (): Promise<Result<User, SaveUserError>> =>
  await saveUserAsync("awaited-result-async");

export const assignedValue = assigned.match(
  (user) => user.id,
  (error) => error.message,
);

export const handledValue = handled.match(
  (user) => user.id,
  (error) => error.message,
);

// resultar/prefer-map-err: orElse is for recovery. If every branch only returns
// err(...), the Ok value cannot recover and mapErr expresses that intent better.
export const preferMapErrExample = (): Result<User, ParseUserError> =>
  saveUser("prefer-map-err").orElse((error) => err(new ParseUserError({ cause: error })));

// resultar/prefer-and-then: map should return plain values. Returning a Result
// from map nests the channel, so fallible composition should use andThen.
export const preferAndThenExample = () =>
  saveUser("prefer-and-then").map((user) => saveUser(user.id));

// resultar/no-promise-in-result-success: synchronous Result values must not
// contain Promises. Use ResultAsync or asyncMap for asynchronous work.
export const noPromiseInResultSuccessExample = (): Result<Promise<User>, SaveUserError> =>
  saveUser("promise-in-success").map(async (user) => user);

// resultar/no-unknown-result-error: error channels should describe a concrete
// domain error instead of forcing every consumer to narrow unknown.
export type UnknownErrorResult = Result<User, unknown>;

// resultar/prefer-map: andThen is unnecessary when the callback only wraps a
// plain transformed value in ok(...).
export const preferMapExample = (): Result<string, SaveUserError> =>
  saveUser("prefer-map").andThen((user) => ok(user.email));

// resultar/prefer-first-success-of: independent fallback chains are clearer as
// Result.firstSuccessOf([...]).
export const preferFirstSuccessOfExample = (): Result<User, SaveUserError> =>
  saveUser("primary")
    .orElse(() => saveUser("replica"))
    .orElse(() => saveUser("cache"));

// resultar/prefer-result-for-each: avoid allocating an intermediate array of
// Results before combining it.
export const preferResultForEachExample = () =>
  Result.combine(["first", "second"].map((id) => saveUser(id)));

type ProviderReason = { readonly _tag: "Unavailable" };
type ProviderFailure = { readonly _tag: "ProviderFailure"; readonly reason: ProviderReason };

declare const providerFailure: Result<User, ProviderFailure>;

// resultar/prefer-catch-reason: use catchReason when a catchTag callback
// manually inspects a nested reason._tag.
export const preferCatchReasonExample = () =>
  providerFailure.catchTag("ProviderFailure", (error) =>
    error.reason._tag === "Unavailable" ? saveUser("fallback") : providerFailure,
  );

// resultar/typed-catch-mapper: tryResult without a catch mapper leaves the error
// channel as unknown instead of converting the thrown value to a domain error.
export const typedCatchMapperExample = () => tryResult(() => JSON.parse('{"id":"parsed"}') as User);

// resultar/no-unsafe-await: raw Promise awaits can reject outside Resultar. In
// all mode, this is reported even outside functions returning Result/ResultAsync.
export const noUnsafeAwaitAllModeExample = async (): Promise<User> =>
  await fetchUser("unsafe-all-mode");

// resultar/no-unsafe-await: awaiting a Resultar async value inside a raw
// Promise<User> boundary unwraps the error channel back into thrown errors.
export const noUnsafeAwaitRawPromiseBoundaryExample = async (): Promise<User> => {
  const result = await saveUserAsync("raw-promise-boundary");

  return result.match(
    (user) => user,
    (error) => {
      throw error;
    },
  );
};

// resultar/no-unsafe-await: Resultar-returning async functions are checked even
// in the default resultar-context mode.
export const noUnsafeAwaitResultContextExample = async (): Promise<Result<User, FetchUserError>> =>
  ok(await fetchUser("unsafe-result-context"));

// resultar/no-throw: expected failures should stay in Resultar channels instead
// of escaping through throw control flow.
export const noThrowExample = (): never => {
  throw new SaveUserError({ id: "no-throw" });
};

// resultar/no-try-catch: expected failures should be converted at the throwing
// boundary with tryResult or tryResultAsync instead of broad exception control flow.
export const noTryCatchExample = (input: string): User | undefined => {
  try {
    return JSON.parse(input) as User;
  } catch {
    return undefined;
  }
};

const fastify = {
  after: async (): Promise<void> => undefined,
  ready: async (): Promise<void> => undefined,
};

const app = { after: async (): Promise<void> => undefined };

const startServer = async (): Promise<void> => undefined;

// In the full TypeScript checker, bare function identifiers can be ignored by
// exact source name. A project can allow this call by configuring "startServer".
export const ignoredUnsafeAwaitFunctionExample = async (): Promise<void> => {
  await startServer();
};

// noUnsafeAwaitIgnoreCalls is exact and source-name based. A project can allow
// this call by configuring "fastify.after".
export const ignoredUnsafeAwaitCallExample = async (): Promise<void> => {
  await fastify.after();
};

// This remains unsafe because "fastify.ready" is not configured in the ignore
// list. The ignore list is not a wildcard for every method on fastify.
export const nonIgnoredUnsafeAwaitCallExample = async (): Promise<void> => {
  await fastify.ready();
};

// This is also reported: the method name is the same, but the source path is
// "app.after", not "fastify.after".
export const nonIgnoredSourceNameExample = async (): Promise<void> => {
  await app.after();
};

// resultar/no-try-catch-in-safe-try: safeTry generators should compose Resultar
// values. Use tryResult/tryResultAsync boundaries for throwing APIs.
export const noTryCatchInSafeTryExample = (): Result<User, SaveUserError> =>
  safeTry(function* () {
    try {
      const user = yield* saveUser("safe-try");

      return ok(user);
    } catch {
      return SaveUserError.err({ id: "safe-try" });
    }
  });

// resultar/no-await-in-safe-try: inside safeTry, compose Resultar values with
// yield*. Awaiting a ResultAsync unwraps the channel into ordinary control flow.
export const noAwaitInSafeTryExample = (): ResultAsync<User, SaveUserError> =>
  safeTry(async function* () {
    const result = await saveUserAsync("await-in-safe-try");

    return result;
  });

// resultar/yield-star-in-safe-try: yield* is what unwraps Resultar values inside
// safeTry. A plain yield does not compose the Result channel correctly.
export const yieldStarInSafeTryExample = (): Result<User, SaveUserError> =>
  safeTry(function* () {
    yield err<never, SaveUserError>(new SaveUserError({ id: "yield-star" }));

    return ok({ email: "unreachable@example.com", id: "unreachable" });
  });

// resultar/unsafe-result-type-assertion: narrowing the error side with `as`
// discards possible failures from the type system.
export const unsafeResultTypeAssertionExample = (
  result: Result<User, SaveUserError | ParseUserError>,
): Result<User, SaveUserError> => result as Result<User, SaveUserError>;

// resultar/prefer-tagged-error: err(new Error(...)) loses stable tags and typed
// metadata; prefer a createTaggedError instance.
export const preferTaggedErrorExample = (): Result<User, Error> =>
  err(new Error("Use createTaggedError for domain errors"));

type RecordIdParts = { readonly id: string; readonly table: string };

// resultar/prefer-tagged-error: throwing new Error(...) also loses stable tags
// and typed metadata. Convert throwing helpers to Resultar boundaries or throw a
// createTaggedError instance when a throw boundary is intentional.
export const preferTaggedErrorThrowExample = (value: unknown, table: string): RecordIdParts => {
  if (typeof value === "string") {
    return { id: value, table };
  }

  throw new Error(`Invalid record id for table ${table}: ${String(value)}`);
};

// Use LegacyDomainError so the native Error subclass stays live in this example.
export const legacyErrorInstance = new LegacyDomainError("legacy");

// resultar/no-useless-recovery: mapErr/orElse/catchTag cannot run when the error
// channel is never. Remove the recovery or make the operation actually fallible.
export const noUselessRecoveryExample = (): Result<User, never> =>
  ok<User, never>({ email: "infallible@example.com", id: "infallible" }).mapErr((error) => error);

// ResultTask is lazy and must also be handled, returned, or explicitly voided.
loadUserTask("ignored-task");

// resultar/no-promise-in-result-success: ResultTask.map stores the callback
// result as its success value. Use flatMap/andThen with tryPromise instead of
// creating a ResultTask<Promise<...>>.
export const noPromiseInResultTaskSuccessExample = (): ResultTask<Promise<User>, FetchUserError> =>
  loadUserTask("promise-in-task").map(async (user) => user);

// resultar/no-unknown-result-error: ResultTask error channels should remain
// concrete just like Result and ResultAsync channels.
export declare const unknownResultTask: ResultTask<User, unknown>;

// resultar/prefer-and-then: map should return plain values, not another
// ResultTask. Use andThen/flatMap for lazy fallible composition.
export const preferResultTaskAndThenExample = () =>
  loadUserTask("prefer-task-and-then").map(() => ResultTask.succeed("nested"));

// resultar/prefer-map: andThen is unnecessary when the callback only creates a
// successful ResultTask. A direct map keeps the transformation non-fallible.
export const preferResultTaskMapExample = () =>
  loadUserTask("prefer-task-map").andThen((user) => ResultTask.succeed(user.email));

// resultar/no-useless-recovery: catchAll cannot recover an infallible task.
export const noUselessResultTaskRecoveryExample = () =>
  ResultTask.succeed("infallible-task").catchAll(() => ResultTask.succeed("unreachable"));

// resultar/unsafe-result-type-assertion: narrowing a ResultTask error channel
// discards possible failures from the type system.
export const unsafeResultTaskTypeAssertionExample = (
  task: ResultTask<User, SaveUserError | ParseUserError>,
): ResultTask<User, SaveUserError> => task as ResultTask<User, SaveUserError>;

// resultar/yield-star-in-result-task-gen: ResultTask.gen only composes tasks
// and services through yield*. A plain yield is rejected as an unsupported
// runtime value.
export const yieldStarInResultTaskGenExample = () =>
  ResultTask.gen(function* () {
    yield loadUserTask("plain-yield");

    return { email: "unreachable@example.com", id: "unreachable" };
  });
