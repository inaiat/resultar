import { ResultTask } from "resultar";
import { describe, expect, test } from "vite-plus/test";

import { Service, createModule } from "../src/advanced.js";

interface CacheService {
  readonly values: ReadonlyMap<string, string>;
}

interface UsersService {
  readonly cache: CacheService;
  readonly find: (id: string) => string | undefined;
}

describe("class-shaped services", () => {
  test("declares dependencies with yield* and applies class lifetimes", async () => {
    let cacheCreations = 0;
    let usersCreations = 0;

    class Cache extends Service<CacheService>()("cache", {
      make: ResultTask.sync(() => {
        cacheCreations += 1;
        return { values: new Map([["1", "Ada"]]) };
      }),
    }) {}

    class Users extends Service<UsersService>()("users", {
      make: ResultTask.gen(function* buildUsers() {
        const cache = yield* Cache;
        usersCreations += 1;
        return { cache, find: (id: string) => cache.values.get(id) };
      }),
    }) {}

    const application = createModule().singleton(Cache).scoped(Users).scope();
    const program = application.use(["users"], ({ users }) => ResultTask.succeed(users));

    const first = await ResultTask.runPromise(program);
    const second = await ResultTask.runPromise(program);

    expect(first).not.toBe(second);
    expect(first.cache).toBe(second.cache);
    expect(first.find("1")).toBe("Ada");
    expect(cacheCreations).toBe(1);
    expect(usersCreations).toBe(2);

    await ResultTask.runPromise(application.close());
  });

  test("reports missing class dependencies when the graph is executed", async () => {
    class MissingDependency extends Service<{ readonly value: string }>()("missing", {
      make: ResultTask.succeed({ value: "ok" }),
    }) {}

    class NeedsMissing extends Service<{ readonly dependency: string }>()("needs", {
      make: ResultTask.gen(function* buildNeedsMissing() {
        const dependency = yield* MissingDependency;
        return { dependency: dependency.value };
      }),
    }) {}

    const module = createModule().scoped(NeedsMissing);
    const task = module.use(["needs"], ({ needs }) => ResultTask.succeed(needs.dependency));
    const exit = await ResultTask.runExit(task, { services: {} as never });

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Die") {
      expect(exit.cause.defect).toMatchObject({ message: "Missing ResultTask service: missing" });
    }
  });

  test("recreates transient class services for each child scope", async () => {
    let creations = 0;
    class TransientService extends Service<{ readonly id: number }>()("transient", {
      make: ResultTask.sync(() => {
        creations += 1;
        return { id: creations };
      }),
    }) {}

    const application = createModule().transient(TransientService).scope();
    const task = application.use(["transient"], ({ transient }) => ResultTask.succeed(transient));
    const first = await ResultTask.runPromise(task);
    const second = await ResultTask.runPromise(task);

    expect(first).not.toBe(second);
    expect(creations).toBe(2);
    await ResultTask.runPromise(application.close());
  });

  test("infers service contract from make without explicit type arguments", async () => {
    class InferredService extends Service("inferred", {
      make: ResultTask.sync(() => ({ greet: (name: string) => `Hello, ${name}!` })),
    }) {}

    class CurriedInferred extends Service()("curried", {
      make: ResultTask.sync(() => ({ count: 42 })),
    }) {}

    const application = createModule().scoped(InferredService).scoped(CurriedInferred).scope();
    const task = application.use(["inferred", "curried"], ({ inferred, curried }) =>
      ResultTask.succeed({ message: inferred.greet("Ada"), count: curried.count }),
    );

    const result = await ResultTask.runPromise(task);
    expect(result.message).toBe("Hello, Ada!");
    expect(result.count).toBe(42);
    await ResultTask.runPromise(application.close());
  });
});
