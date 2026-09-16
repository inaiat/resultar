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
    // @ts-expect-error Promises are not lazy construction tasks.
    Service<Reader>()("bad", { requires: {}, make: () => Promise.resolve({ find: () => "ok" }) });
  };
  expectTypeOf(invalid).toBeFunction();
});

test("infers synchronous factories while preserving contracts and dependency requirements", () => {
  const Cache = Service.require<ReadonlyMap<string, string>>()("cache");
  interface Reader {
    readonly find: (key: string) => string | undefined;
  }
  class Explicit extends Service<Reader>()("reader", {
    requires: { storage: Cache },
    make: (deps) => {
      expectTypeOf(deps).toEqualTypeOf<{ readonly storage: ReadonlyMap<string, string> }>();
      return { find: (key: string) => deps.storage.get(key) };
    },
  }) {}
  const Inferred = Service("size", {
    requires: { storage: Cache },
    make: ({ storage }) => ({ size: storage.size }),
  });
  const Curried = Service()("curried", {
    requires: { reader: Explicit },
    make: ({ reader }) => reader.find("1"),
  });
  const Empty = Service("empty", { requires: {}, make: () => ({ value: 42 }) });
  expectTypeOf(Explicit.make).toEqualTypeOf<ResultTask<Reader, never, typeof Cache>>();
  expectTypeOf(Inferred.make).toEqualTypeOf<ResultTask<{ size: number }, never, typeof Cache>>();
  expectTypeOf(Curried.make).toEqualTypeOf<
    ResultTask<string | undefined, never, typeof Explicit>
  >();
  expectTypeOf(Empty.make).toEqualTypeOf<ResultTask<{ value: number }>>();
  const external = createModule()
    .scoped(Inferred)
    .use(["size"], ({ size }) => ResultTask.succeed(size));
  expectTypeOf(external).toEqualTypeOf<ResultTask<{ size: number }, never, typeof Cache>>();
  const invalid = () => {
    // @ts-expect-error A synchronous factory must satisfy an explicit contract.
    Service<Reader>()("bad", { requires: {}, make: () => ({ find: () => 42 }) });
    // @ts-expect-error A known provider must satisfy a synchronous service's requirements.
    createModule().value("cache", 42).scoped(Inferred);
    // @ts-expect-error Missing dependencies remain required at the boundary.
    const missing = ResultTask.runPromise(external);
    expectTypeOf(missing).toEqualTypeOf<Promise<{ size: number }>>();
    // @ts-expect-error Inferred factories must not return promises.
    Service("bad", { requires: {}, make: async () => ({ value: 42 }) });
    // @ts-expect-error A broad explicit contract must not hide promises.
    Service<unknown>()("bad", { requires: {}, make: async () => ({ value: 42 }) });
    const maybeAsync = (): { value: number } | Promise<{ value: number }> =>
      Math.random() > 0.5 ? { value: 42 } : Promise.resolve({ value: 42 });
    // @ts-expect-error A synchronous branch must not hide an asynchronous branch.
    Service("bad-union", { requires: {}, make: maybeAsync });
    // @ts-expect-error Explicit broad contracts must reject asynchronous unions too.
    Service<object>()("bad-union", { requires: {}, make: maybeAsync });
    const maybeTask = (): { value: number } | ResultTask<{ value: number }> =>
      Math.random() > 0.5 ? { value: 42 } : ResultTask.succeed({ value: 42 });
    // @ts-expect-error A task branch must use the task overload, not leak into the service value.
    Service("bad-task-union", { requires: {}, make: maybeTask });
    Service("bad-then", {
      requires: {},
      // @ts-expect-error Any callable then is rejected by the runtime, not just PromiseLike signatures.
      // eslint-disable-next-line unicorn/no-thenable -- Deliberately invalid thenable factory.
      make: () => ({ then: () => 42 }),
    });
    Service("bad", {
      requires: {},
      // @ts-expect-error A structural thenable is asynchronous too.
      // eslint-disable-next-line unicorn/no-thenable -- Deliberately invalid async factory.
      make: () => ({ then: Promise.resolve(42).then.bind(Promise.resolve(42)) }),
    });
    Service("readonly", {
      requires: { cache: Cache },
      make: (deps) => {
        // @ts-expect-error Synchronous factories receive readonly aliases.
        deps.cache = new Map();
        return {};
      },
    });
  };
  expectTypeOf(invalid).toBeFunction();
});
