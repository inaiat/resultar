import { ResultTask, type ResultTaskScope } from "resultar";
import { expectTypeOf, test } from "vite-plus/test";

import { createModule } from "../src/index.js";

test("requires a declared parameter when synchronous factories list dependencies", () => {
  const services = createModule().value("cache", new Map<string, string>());
  const fooBarZinoh = () => {
    // Reproduce the empty, zero-argument factory from the application example.
  };
  const unusedDependencies = () => ({ find: (id: string) => id });
  const createUsers = ({ cache }: { readonly cache: Map<string, string> }) => ({
    find: (id: string) => cache.get(id),
  });
  const users = services.scoped("users", ["cache"], createUsers);
  const task = users.use(["users"], (deps) => ResultTask.succeed(deps.users.find("1")));
  expectTypeOf(task).toEqualTypeOf<ResultTask<string | undefined>>();

  // No dependencies means a zero-argument function is valid.
  const independent = services.singleton("independent", [], unusedDependencies);
  expectTypeOf(independent).toBeObject();

  const invalidExamples = () => {
    // @ts-expect-error Named zero-argument functions must receive declared dependencies.
    services.scoped("users", ["cache"], fooBarZinoh);
    // @ts-expect-error A valid service return type does not replace the dependency parameter.
    services.singleton("users", ["cache"], unusedDependencies);
    // @ts-expect-error Transients obey the same parameter requirement.
    services.transient("users", ["cache"], unusedDependencies);
    // @ts-expect-error Inline factories cannot omit the dependency parameter either.
    services.scoped("users", ["cache"], () => ({ find: () => "1" }));
    // @ts-expect-error The declared parameter must match the selected dependency types.
    services.scoped("users", ["cache"], (_deps: { cache: number }) => "1");
    // @ts-expect-error A factory cannot require an undeclared dependency.
    services.scoped("users", [], createUsers);
  };
  expectTypeOf(invalidExamples).toBeFunction();
});

test("accepts optional, default, and rest dependency parameters", () => {
  type Dependencies = { readonly cache: Map<string, string> };
  const services = createModule().value("cache", new Map<string, string>());
  const optional = (deps?: Dependencies) => deps?.cache.size;
  const defaults: Dependencies = { cache: new Map() };
  const defaulted = (deps: Dependencies = defaults) => deps.cache.size;
  const rest = (...[deps]: [Dependencies]) => deps.cache.size;
  const registered = services
    .singleton("optional", ["cache"], optional)
    .scoped("defaulted", ["cache"], defaulted)
    .transient("rest", ["cache"], rest);
  const task = registered.use(["optional", "defaulted", "rest"], (deps) => {
    expectTypeOf(deps.optional).toEqualTypeOf<number | undefined>();
    expectTypeOf(deps.defaulted).toEqualTypeOf<number>();
    expectTypeOf(deps.rest).toEqualTypeOf<number>();
    return ResultTask.succeed(deps.rest);
  });
  expectTypeOf(task).toEqualTypeOf<ResultTask<number>>();
});

test("infers synchronous registrations and rejects unsupported lifetime arguments", () => {
  const services = createModule()
    .singleton("cache", [], () => new Map<string, string>())
    .scoped("users", ["cache"], ({ cache }) => {
      expectTypeOf(cache).toEqualTypeOf<Map<string, string>>();
      return { find: (id: string) => cache.get(id) };
    })
    .transient("operation", ["users"], ({ users }) => {
      expectTypeOf(users.find).toEqualTypeOf<(id: string) => string | undefined>();
      return users.find("1");
    });

  const task = services.use(["operation"], ({ operation }) => ResultTask.succeed(operation));
  expectTypeOf(task).toEqualTypeOf<ResultTask<string | undefined>>();

  const invalidExamples = () => {
    // @ts-expect-error The method declares the lifetime; there is no fourth argument.
    services.singleton("extra", [], () => 1, { lifetime: "scoped" });
    // @ts-expect-error Singleton initialization must be synchronous.
    services.singleton("async", [], () => Promise.resolve(1));
    // @ts-expect-error Transient initialization must also be synchronous.
    services.transient("lazy", [], () => ResultTask.succeed(1));
    // @ts-expect-error Dependency names remain checked for singleton registrations.
    services.singleton("missing", ["unknown"], () => 1);
    // @ts-expect-error Duplicate names are rejected across registration methods.
    services.transient("cache", [], () => 1);
  };
  expectTypeOf(invalidExamples).toBeFunction();
});

test("infers factory dependencies, resource values, and all failure channels", () => {
  const services = createModule()
    .value("config", { port: 3000 })
    .scoped("address", ["config"], ({ config }) => `localhost:${config.port}`)
    .resource("server", ["address"], {
      acquire: ({ address }) =>
        ResultTask.try({ try: () => ({ address }), catch: () => "acquire" as const }),
      release: () => ResultTask.fail("release" as const),
    });
  const task = services.use(["server"], ({ server }) => {
    expectTypeOf(server).toEqualTypeOf<{ address: string }>();
    return ResultTask.try({ try: () => server.address.length, catch: () => "use" as const });
  });
  expectTypeOf(task).toEqualTypeOf<ResultTask<number, "acquire" | "release" | "use">>();
});

test("preserves external service requirements and nested finalizer errors", () => {
  const Clock = ResultTask.service<{ now: () => number }, "clock">("clock");
  const services = createModule().resource("database", [], {
    acquire: () =>
      ResultTask.gen(function* acquireDatabase() {
        const clock = yield* Clock;
        return yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed(clock.now()),
          release: () => ResultTask.fail("inner release" as const),
        });
      }),
    release: () => ResultTask.fail("outer release" as const),
  });
  const task = services.use(["database"], ({ database }) => ResultTask.succeed(database));
  expectTypeOf(task).toEqualTypeOf<
    ResultTask<number, "inner release" | "outer release", typeof Clock>
  >();
  const nestedUse = createModule().use([], () =>
    ResultTask.acquireRelease({
      acquire: ResultTask.succeed(1),
      release: () => ResultTask.fail("use release" as const),
    }),
  );
  expectTypeOf(nestedUse).toEqualTypeOf<ResultTask<number, "use release">>();
  expectTypeOf(nestedUse).not.toEqualTypeOf<
    ResultTask<number, never, ResultTaskScope<"use release">>
  >();

  const taskProvider = createModule().task("config", [], () =>
    ResultTask.acquireRelease({
      acquire: ResultTask.try({ try: () => 3000, catch: () => "config" as const }),
      release: () => ResultTask.fail("config release" as const),
    }),
  );
  const config = taskProvider.use(["config"], (deps) => ResultTask.succeed(deps.config));
  expectTypeOf(config).toEqualTypeOf<ResultTask<number, "config" | "config release">>();
});

test("rejects unsafe dependency declarations, replacements, and async factories", () => {
  const invalidExamples = (broadName: string) => {
    const services = createModule()
      .value("config", { port: 3000 })
      .value("logger", { log: () => "logged" });
    // @ts-expect-error Dependencies must already exist.
    services.scoped("repo", ["database"], () => 1);
    // @ts-expect-error Existing services cannot be registered again.
    services.value("config", 2);
    // @ts-expect-error Replacements retain the original service contract.
    services.override("config", { port: "bad" });
    // @ts-expect-error Selection controls which services the callback receives.
    services.use(["config"], ({ logger }) => ResultTask.succeed(logger));
    // @ts-expect-error Factory dependencies are also narrowed.
    services.scoped("repo", ["config"], ({ logger }) => String(logger));
    // @ts-expect-error Promise factories hide acquisition errors and ownership.
    services.scoped("async", [], () => Promise.resolve(1));
    // @ts-expect-error ResultTask factories use task or resource registration.
    services.scoped("task", [], () => ResultTask.succeed(1));
    // @ts-expect-error Use callbacks return tasks, not already executing promises.
    services.use(["config"], () => Promise.resolve(1));
    // @ts-expect-error A broad string cannot guarantee a known service property.
    services.value(broadName, 1);
    const unionName = Math.random() > 0.5 ? "one" : "two";
    // @ts-expect-error One runtime name must not claim two statically present services.
    services.value(unionName, 1);
    const dynamicKeys: ("config" | "logger")[] = ["config"];
    // @ts-expect-error Widened arrays cannot promise all selected properties are present.
    services.use(dynamicKeys, () => ResultTask.succeed(1));
    const unionKey = Math.random() > 0.5 ? "config" : "logger";
    // @ts-expect-error A union element does not guarantee both dependencies.
    services.use([unionKey], () => ResultTask.succeed(1));
    const unionTuple = Math.random() > 0.5 ? (["config"] as const) : (["logger"] as const);
    // @ts-expect-error A union of tuples also cannot guarantee all selected properties.
    services.use(unionTuple, () => ResultTask.succeed(1));
  };
  expectTypeOf(invalidExamples).toBeFunction();
});
