// Checker fixture for the documented Task-first application configuration
// (`preferResultAsync: "off"`, `noPromiseResultar: "error"`).
import {
  createTaggedError,
  ok,
  ResultTask,
  type Exit,
  type Result,
  type StrictResult,
  type StrictResultTask,
} from "resultar";
import { okAsync, type ResultAsync, type StrictResultAsync } from "resultar/async";

type User = { readonly id: string };

class UserLookupError extends createTaggedError({
  name: "UserLookupError",
  message: "Could not load user $id",
}) {}

// INVALID: explicit Promise<ResultTask> and Promise<StrictResultTask> contracts.
export interface ProhibitedContracts {
  readonly readTask: (id: string) => Promise<ResultTask<User, UserLookupError>>;
  readonly readStrictTask: (id: string) => Promise<StrictResultTask<User, UserLookupError>>;
}

// INVALID: unannotated async wrapper returning ResultTask.
export const inferredTaskFactory = async (id: string) => ResultTask.ok({ id });

// INVALID: constrained generic Promise<T> wrapper over ResultTask and heterogeneous Result | ResultTask union.
export async function wrapGenericTask<T extends ResultTask<User, UserLookupError>>(
  value: T,
): Promise<T> {
  return value;
}
export type HeterogeneousPromiseUnion = Promise<Result<number, UserLookupError> | ResultTask<User>>;

// VALID: direct ResultTask, execution-boundary Promise<Result> / Promise<StrictResult>,
// ResultAsync (from resultar/async), raw SDK Promises, and Exit boundaries.
export interface ValidContracts {
  readonly task: (id: string) => ResultTask<User, UserLookupError>;
  readonly boundaryResult: (id: string) => Promise<Result<User, UserLookupError>>;
  readonly boundaryStrict: (id: string) => Promise<StrictResult<User, UserLookupError>>;
  readonly eager: (id: string) => ResultAsync<User, UserLookupError>;
  readonly strictEager: (id: string) => StrictResultAsync<User, UserLookupError>;
  readonly rawDriver: (id: string) => Promise<User | undefined>;
  readonly exitBoundary: (id: string) => Promise<Exit<User, UserLookupError>>;
}

export const validTaskFactory = (id: string) => ResultTask.ok({ id });
export const validBoundaryRunner = (id: string) => validTaskFactory(id).runResult();
export const validSyncWrapper = async (id: string) => ok({ id });
export const validEagerFactory = (id: string) => okAsync({ id });
export const validRawDriver = async (id: string): Promise<User> => ({ id });
export async function validGenericIdentity<T>(value: T): Promise<T> {
  return value;
}
