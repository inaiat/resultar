// Checker fixture for the documented Task-first application configuration
// (`preferResultAsync: "off"`, `noPromiseResultar: "error"`).
import {
  createTaggedError,
  ok,
  okAsync,
  ResultTask,
  type Exit,
  type Result,
  type ResultAsync,
  type StrictResult,
  type StrictResultAsync,
} from "resultar";

type User = { readonly id: string };

class UserLookupError extends createTaggedError({
  name: "UserLookupError",
  message: "Could not load user $id",
}) {}

// INVALID: explicit Promise<Result>, Promise<StrictResult>, and Promise<ResultTask> contracts.
export interface ProhibitedContracts {
  readonly readResult: (id: string) => Promise<Result<User, UserLookupError>>;
  readonly readStrict: (id: string) => Promise<StrictResult<User, UserLookupError>>;
  readonly readTask: (id: string) => Promise<ResultTask<User, UserLookupError>>;
}

// INVALID: unannotated async wrappers returning ok, okAsync, or ResultTask.
export const inferredSyncResult = async (id: string) => ok({ id });
export const inferredResultAsyncWrapper = async (id: string) => okAsync({ id });
export const inferredTaskFactory = async (id: string) => ResultTask.ok({ id });

// INVALID: constrained generic Promise<T> wrappers and heterogeneous Result | ResultTask unions.
export async function wrapGenericResult<T extends Result<number, UserLookupError>>(
  value: T,
): Promise<T> {
  return value;
}
export async function wrapGenericTask<T extends ResultTask<User, UserLookupError>>(
  value: T,
): Promise<T> {
  return value;
}
export type HeterogeneousPromiseUnion = Promise<Result<number, UserLookupError> | ResultTask<User>>;

// VALID: direct ResultTask, ResultAsync, StrictResultAsync, raw SDK Promises, and Exit boundaries.
export interface ValidContracts {
  readonly task: (id: string) => ResultTask<User, UserLookupError>;
  readonly eager: (id: string) => ResultAsync<User, UserLookupError>;
  readonly strictEager: (id: string) => StrictResultAsync<User, UserLookupError>;
  readonly rawDriver: (id: string) => Promise<User | undefined>;
  readonly exitBoundary: (id: string) => Promise<Exit<User, UserLookupError>>;
}

export const validTaskFactory = (id: string) => ResultTask.ok({ id });
export const validEagerFactory = (id: string) => okAsync({ id });
export const validRawDriver = async (id: string): Promise<User> => ({ id });
export async function validGenericIdentity<T>(value: T): Promise<T> {
  return value;
}
