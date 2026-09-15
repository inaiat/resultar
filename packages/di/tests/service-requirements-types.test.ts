import { ResultTask, type ServiceTag } from "resultar";
import { expectTypeOf, test } from "vite-plus/test";
import { Service, createModule } from "../src/index.js";

test("infers dependency aliases, contracts, errors and additional requirements", () => {
  const Cache = Service.require<ReadonlyMap<string, string>>()("cache");
  const Prefix = ResultTask.service<string>()("prefix");
  expectTypeOf(Cache).toEqualTypeOf<ServiceTag<"cache", ReadonlyMap<string, string>>>();
  const dependencies = { storage: Cache } as const;
  const Users = Service("users", {
    requires: dependencies,
    make: (deps) => {
      expectTypeOf(deps).toEqualTypeOf<{ readonly storage: ReadonlyMap<string, string> }>();
      return ResultTask.gen(function* construct() {
        const prefix = yield* Prefix;
        return yield* ResultTask.try({
          try: () => prefix + deps.storage.size,
          catch: () => "read" as const,
        });
      });
    },
  });
  expectTypeOf(Users.make).toEqualTypeOf<
    ResultTask<string, "read", typeof Cache | typeof Prefix>
  >();
  const task = createModule()
    .value("cache", new Map<string, string>())
    .value("prefix", "n=")
    .scoped(Users)
    .use(["users"], ({ users }) => ResultTask.succeed(users));
  expectTypeOf(task).toEqualTypeOf<ResultTask<string, "read">>();
  const external = createModule()
    .scoped(Users)
    .use(["users"], ({ users }) => ResultTask.succeed(users));
  expectTypeOf(external).toEqualTypeOf<ResultTask<string, "read", typeof Cache | typeof Prefix>>();
  const invalid = () => {
    // @ts-expect-error Missing external dependencies remain required at the boundary.
    const missing = ResultTask.runPromise(external);
    expectTypeOf(missing).toEqualTypeOf<Promise<string>>();
    // @ts-expect-error A known provider must satisfy its required service contract.
    createModule().value("cache", 42).scoped(Users);
    // @ts-expect-error Dependencies are tokens or classes, not names.
    Service("invalid", { requires: { storage: "cache" }, make: () => ResultTask.succeed(1) });
    Service("readonly", {
      requires: dependencies,
      make: (deps) => {
        // @ts-expect-error Injected dependency properties are readonly.
        deps.storage = new Map();
        return ResultTask.succeed(1);
      },
    });
  };
  expectTypeOf(invalid).toBeFunction();
});

test("preserves explicit and inferred contracts in both class declaration forms", () => {
  interface Reader {
    readonly find: (key: string) => string | undefined;
  }
  const Cache = Service.require<ReadonlyMap<string, string>>()("cache");
  class Explicit extends Service<Reader>()("explicit", {
    requires: { cache: Cache },
    make: ({ cache }) => ResultTask.sync(() => ({ find: (key: string) => cache.get(key) })),
  }) {}
  class Inferred extends Service()("inferred", {
    requires: { reader: Explicit },
    make: ({ reader }) => ResultTask.succeed(reader.find("1")),
  }) {}
  class Inline extends Service<Reader>()("inline", {
    make: ResultTask.gen(function* construct() {
      const cache = yield* Service.require<ReadonlyMap<string, string>>()("cache");
      return { find: (key: string) => cache.get(key) };
    }),
  }) {}
  expectTypeOf(Explicit.make).toEqualTypeOf<ResultTask<Reader, never, typeof Cache>>();
  expectTypeOf(Inferred.make).toEqualTypeOf<
    ResultTask<string | undefined, never, typeof Explicit>
  >();
  expectTypeOf(Inline.make).toEqualTypeOf<ResultTask<Reader, never, typeof Cache>>();
  const Empty = Service()("empty", { requires: {}, make: () => ResultTask.succeed(42) });
  expectTypeOf(Empty.make).toEqualTypeOf<ResultTask<number>>();
  const invalid = () => {
    // @ts-expect-error Explicit contracts validate the result of make.
    Service<Reader>()("bad", { requires: { cache: Cache }, make: () => ResultTask.succeed(42) });
    // @ts-expect-error A ready task is not a requires factory in the curried form.
    Service<Reader>()("bad", { requires: {}, make: ResultTask.succeed({ find: () => "ok" }) });
    // @ts-expect-error An ordinary object is not a construction task.
    Service<Reader>()("bad", { requires: {}, make: () => ({ find: () => "ok" }) });
    // @ts-expect-error Promises are not lazy construction tasks.
    Service<Reader>()("bad", { requires: {}, make: () => Promise.resolve({ find: () => "ok" }) });
  };
  expectTypeOf(invalid).toBeFunction();
});
