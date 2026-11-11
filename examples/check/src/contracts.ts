// Checker fixture: the first two repository examples intentionally FAIL validation.
// They test an optional eager-compatibility policy, not recommended application APIs.
import { okAsync, ResultTask, type StrictResultAsync } from "resultar";

type User = { readonly id: string };

// INVALID: preferResultAsyncMode: "all" rejects plain Promise repository contracts.
export interface UsersRepository {
  readonly findById: (id: string) => Promise<User | undefined>;
}

// INVALID: removing the annotation still exposes a native Promise and must be reported.
export const inferredRepository = {
  async findById(id: string) {
    return id === "1" ? { id } : undefined;
  },
};

// Existing eager API: retained for gradual migration.
export const resultRepository: {
  readonly findById: (id: string) => StrictResultAsync<User | undefined, never>;
} = {
  findById: (id) => okAsync(id === "1" ? { id } : undefined),
};

// Recommended contract for a new asynchronous repository: a lazy Task, not async.
export const taskRepository: {
  readonly findById: (id: string) => ResultTask<User | undefined, never>;
} = {
  findById: (id) => ResultTask.ok(id === "1" ? { id } : undefined),
};

// Native framework lifecycle callbacks own their rejection boundary.
// resultar-check-disable-next-line prefer-result-async
export async function nativeBootstrap(): Promise<void> {}
