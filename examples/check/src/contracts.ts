import { okAsync, type StrictResultAsync } from "resultar";

type User = { readonly id: string };

// preferResultAsyncMode: "all" also rejects plain Promise repository contracts.
export interface UsersRepository {
  readonly findById: (id: string) => Promise<User | undefined>;
}

// Removing the annotation still exposes a native Promise and must be reported.
export const inferredRepository = {
  async findById(id: string) {
    return id === "1" ? { id } : undefined;
  },
};

export const resultRepository: {
  readonly findById: (id: string) => StrictResultAsync<User | undefined, never>;
} = {
  findById: (id) => okAsync(id === "1" ? { id } : undefined),
};

// Native framework lifecycle callbacks own their rejection boundary.
// resultar-check-disable-next-line prefer-result-async
export async function nativeBootstrap(): Promise<void> {}
