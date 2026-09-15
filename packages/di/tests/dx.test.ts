import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { createModule, service, resource } from "../src/index.js";

const Cache = service(
  "cache",
  ResultTask.sync(() => new Map<string, string>()),
);
const Tenant = ResultTask.service<string, "tenant">("tenant");
const Users = service("users", { cache: Cache, tenant: Tenant }, ({ cache, tenant }) => ({
  cache,
  tenant,
}));

test("overrides prune provider initialization, external requirements, and cleanup errors", async () => {
  const Credentials = ResultTask.service<string, "credentials">("credentials");
  let started = false;
  const Database = resource("database", {
    acquire: ResultTask.gen(function* connect() {
      started = true;
      yield* Credentials;
      return yield* ResultTask.fail("offline" as const).map(() => ({ read: (): string => "live" }));
    }),
    release: () => ResultTask.fail("release failed" as const),
  });
  const Query = service("query", { database: Database }, ({ database }) => database.read());
  const original = createModule().singleton(Database).scoped(Query);
  const testing = original.override("database", { read: () => "fake" });
  const task = testing.use(["query"], ({ query }) => ResultTask.succeed(query));
  expectTypeOf(task).toEqualTypeOf<ResultTask<string, never, never>>();
  expectTypeOf(testing.scope().close()).toEqualTypeOf<ResultTask<void, never, never>>();
  expect(await ResultTask.runPromise(task)).toBe("fake");
  expect(started).toBe(false);
  const live = original.use(["query"], ({ query }) => ResultTask.succeed(query));
  expectTypeOf(live).toEqualTypeOf<
    ResultTask<string, "offline" | "release failed", typeof Credentials>
  >();
});

test("http owns its root while reusing one handler across isolated requests", async () => {
  let singletonAcquisitions = 0;
  let singletonReleases = 0;
  let requestAcquisitions = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      singletonAcquisitions += 1;
      return {};
    }),
    release: () =>
      ResultTask.sync(() => {
        singletonReleases += 1;
      }),
  });
  const RequestService = service("requestService", { shared: Shared }, ({ shared }) => {
    requestAcquisitions += 1;
    return { shared, id: requestAcquisitions };
  });
  let handlerCalls = 0;
  const application = createModule()
    .singleton(Shared)
    .scoped(RequestService)
    .http(["requestService"], ({ requestService }) => {
      handlerCalls += 1;
      return new Response(String(requestService.id));
    });
  expect(singletonAcquisitions).toBe(0);
  const program = ResultTask.scoped(
    application.flatMap((app) =>
      ResultTask.tryPromise({
        try: async () => {
          const [a, b] = await Promise.all([app.request("/a"), app.request("/b")]);
          expect(await a.text()).not.toBe(await b.text());
          expect(singletonReleases).toBe(singletonAcquisitions - 1);
        },
        catch: (error) => error,
      }),
    ),
  );
  await ResultTask.runPromise(program);
  expect(singletonAcquisitions).toBe(1);
  expect(singletonReleases).toBe(1);
  expect(handlerCalls).toBe(2);
  await ResultTask.runPromise(program);
  expect(singletonAcquisitions).toBe(2);
  expect(singletonReleases).toBe(2);
});

test("selection retains only reachable errors and requirements, including callback tokens", async () => {
  const External = ResultTask.service<string, "external">("external");
  const Remote = service(
    "remote",
    ResultTask.gen(function* remote() {
      yield* External;
      return yield* ResultTask.fail("offline" as const).map(() => "unreachable");
    }),
  );
  const module = createModule().value("health", "ok").scoped(Remote);
  const healthTask = module.use(["health"], ({ health }) => ResultTask.succeed(health));
  expectTypeOf(healthTask).toEqualTypeOf<ResultTask<string, never, never>>();
  expect(await ResultTask.runPromise(healthTask)).toBe("ok");
  const remote = module.use([], () =>
    ResultTask.gen(function* callback() {
      return yield* Remote;
    }),
  );
  expectTypeOf(remote).toEqualTypeOf<ResultTask<string, "offline", typeof External>>();
  const FetchRemote = module.scope();
  // @ts-expect-error A fetch handler cannot hide unresolved external dependencies.
  FetchRemote.fetch(["remote"], () => new Response());
  const fetch = FetchRemote.fetch(["health"], ({ health }) => new Response(health));
  const response = await fetch(new Request("http://localhost"));
  expect(await response.text()).toBe("ok");
  await ResultTask.runPromise(FetchRemote.close());
});

test("small factories infer dependencies and request locals remain isolated", async () => {
  const root = createModule().singleton(Cache).scoped(Users).scope();
  const read = (tenant: string) =>
    ResultTask.runPromise(
      root.withServices({ tenant }).use(["users"], ({ users }) => ResultTask.succeed(users)),
    );
  const [a, b] = await Promise.all([read("a"), read("b")]);
  expect(a.tenant).toBe("a");
  expect(b.tenant).toBe("b");
  expect(a).not.toBe(b);
  expect(a.cache).toBe(b.cache);
  // @ts-expect-error Request locals must satisfy the token contract.
  root.withServices({ tenant: 123 });
  // @ts-expect-error Request locals cannot replace application registrations.
  root.withServices({ cache: new Map() });
  await ResultTask.runPromise(root.close());
});

test("singletons cannot capture a request-local token", async () => {
  const root = createModule().singleton(Cache).singleton(Users).scope();
  const exit = await ResultTask.runExit(
    root
      .withServices({ tenant: "secret" })
      .use(["users"], ({ users }) => ResultTask.succeed(users)),
  );
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Die" } });
  await ResultTask.runPromise(root.close());
});

test("merges immutable modules and rejects duplicate registrations", async () => {
  const first = createModule().singleton(Cache);
  const second = createModule().scoped(Users);
  const root = first.merge(second).scope();
  expect(
    await ResultTask.runPromise(
      root
        .withServices({ tenant: "a" })
        .use(["users"], ({ users }) => ResultTask.succeed(users.tenant)),
    ),
  ).toBe("a");
  expect(() => {
    // @ts-expect-error Duplicate service names are rejected statically and dynamically.
    first.merge(first);
  }).toThrow("Service already registered: cache");
  await ResultTask.runPromise(root.close());
});

test("resource tokens use lifetime methods and preserve close error types", async () => {
  const Database = resource("database", {
    acquire: ResultTask.succeed(1),
    release: () => ResultTask.fail("close failed" as const),
  });
  const root = createModule().singleton(Database).scope();
  expectTypeOf(root.close()).toEqualTypeOf<ResultTask<void, "close failed", never>>();
  await ResultTask.runPromise(
    root.use(["database"], ({ database }) => ResultTask.succeed(database)),
  );
  expect(await ResultTask.runExit(root.close())).toEqual({
    _tag: "Failure",
    cause: { _tag: "Fail", error: "close failed" },
  });
});

test("fetch keeps scoped resources open through streaming and drains before root close", async () => {
  let releases = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        releases += 1;
      }),
  });
  const root = createModule().scoped(Connection).scope();
  const fetch = root.fetch(
    ["connection"],
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"));
            controller.close();
          },
        }),
      ),
  );
  const response = await fetch(new Request("http://localhost"));
  expect(releases).toBe(0);
  const closing = ResultTask.runPromise(root.close());
  expect(await response.text()).toBe("hello");
  await closing;
  expect(releases).toBe(1);
});

test("body cancellation propagates and releases the request scope", async () => {
  let canceled = false;
  let released = false;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        released = true;
      }),
  });
  const root = createModule().scoped(Connection).scope();
  const response = await root.fetch(
    ["connection"],
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      ),
  )(new Request("http://localhost"));
  await response.body?.cancel("client gone");
  expect(canceled).toBe(true);
  expect(released).toBe(true);
  await ResultTask.runPromise(root.close());
});

test("stream errors release resources and aborted startup cancels late response bodies", async () => {
  let releases = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        releases += 1;
      }),
  });
  const root = createModule().scoped(Connection).scope();
  const response = await root.fetch(
    ["connection"],
    () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error("stream failed");
          },
        }),
      ),
  )(new Request("http://localhost"));
  await expect(response.text()).rejects.toThrow("stream failed");
  expect(releases).toBe(1);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  let canceled = false;
  const fetching = root.fetch(["connection"], async () => {
    entered.resolve();
    await finish.promise;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    );
  })(new Request("http://localhost", { signal: controller.signal }));
  const failure = expect(fetching).rejects.toThrow("Request scope failed");
  await entered.promise;
  controller.abort("disconnected");
  finish.resolve();
  await failure;
  expect(canceled).toBe(true);
  expect(releases).toBe(2);
  await ResultTask.runPromise(root.close());
});

test("request abort cancels streaming and cleanup failure reaches the body consumer", async () => {
  let releases = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        releases += 1;
      }).flatMap(() => ResultTask.fail("cleanup")),
  });
  const root = createModule().scoped(Connection).scope();
  const controller = new AbortController();
  const response = await root.fetch(
    ["connection"],
    () => new Response(new ReadableStream()),
  )(new Request("http://localhost", { signal: controller.signal }));
  const body = response.text();
  controller.abort("disconnected");
  await expect(body).rejects.toThrow();
  await ResultTask.runPromise(root.close());
  expect(releases).toBe(1);
});

test("empty responses finish cleanup before fetch resolves, and handler failures close scopes", async () => {
  let releases = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed(1),
    release: () =>
      ResultTask.sync(() => {
        releases += 1;
      }),
  });
  const root = createModule().scoped(Connection).scope();
  const empty = await root.fetch(
    ["connection"],
    () => new Response(undefined, { status: 204 }),
  )(new Request("http://localhost"));
  expect(empty.status).toBe(204);
  expect(releases).toBe(1);
  await expect(
    root.fetch(["connection"], () => {
      throw new Error("handler");
    })(new Request("http://localhost")),
  ).rejects.toThrow("Request scope failed");
  expect(releases).toBe(2);
  await ResultTask.runPromise(root.close());
});

test("the unified module preserves named and token registration throughout fluent composition", async () => {
  const initial = createModule();
  const value = initial.value("version", 1);
  const singleton = value.singleton(Cache);
  const scoped = singleton.scoped(service("scoped", {}, () => 1));
  const transient = scoped.transient(service("transient", {}, () => 1));
  const merged = transient.merge(createModule().value("other", 1));
  const overridden = merged.override("cache", new Map<string, string>());
  type Registration = "task" | "resource";
  expectTypeOf<Extract<keyof typeof initial, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof value, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof singleton, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof scoped, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof transient, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof merged, Registration>>().toEqualTypeOf<Registration>();
  expectTypeOf<Extract<keyof typeof overridden, Registration>>().toEqualTypeOf<Registration>();
  const events: string[] = [];
  const mixed = overridden
    .singleton("namedSingleton", ["version"], ({ version }) => version + 1)
    .scoped("namedScoped", ["namedSingleton"], ({ namedSingleton }) => namedSingleton + 1)
    .transient("namedTransient", ["namedScoped"], ({ namedScoped }) => namedScoped + 1)
    .task(
      "computed",
      ["namedTransient"],
      ({ namedTransient }) => ResultTask.succeed(namedTransient + 1),
      { lifetime: "transient" },
    )
    .resource("lease", ["computed"], {
      lifetime: "transient",
      acquire: ({ computed }) =>
        ResultTask.sync(() => {
          events.push("open");
          return computed;
        }),
      release: () =>
        ResultTask.sync(() => {
          events.push("close");
        }),
    });
  expect(events).toEqual([]);
  const task = mixed.use(["lease"], ({ lease }) => ResultTask.succeed(lease));
  expectTypeOf(task).toEqualTypeOf<ResultTask<number, never, never>>();
  expect(await ResultTask.runPromise(task)).toBe(5);
  expect(events).toEqual(["open", "close"]);
});
