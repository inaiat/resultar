import { ResultTask } from "resultar";
import { describe, expect, it } from "vite-plus/test";
import {
  createModule,
  inspectModule,
  useServiceAccess,
  withProvider,
  service,
} from "../src/index.js";

describe("framework service access", () => {
  it("keeps factories lazy, caches by scope and recreates transients on every read", async () => {
    let singletons = 0;
    let scoped = 0;
    let transients = 0;
    const application = withProvider(createModule(), "singleton", {
      create: () => {
        singletons += 1;
        return singletons;
      },
    });
    const scopedModule = withProvider(application, "scoped", {
      lifetime: "scoped",
      create: () => {
        scoped += 1;
        return scoped;
      },
    });
    const module = withProvider(scopedModule, "transient", {
      lifetime: "transient",
      create: () => {
        transients += 1;
        return transients;
      },
    });
    const root = module.scope();
    expect([singletons, scoped, transients]).toEqual([0, 0, 0]);
    for (const request of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      await ResultTask.runPromise(
        useServiceAccess(root, (access) =>
          ResultTask.sync(() => {
            expect(access.get("singleton").unwrapOrThrow()).toBe(1);
            expect(access.get("scoped").unwrapOrThrow()).toBe(request);
            expect(access.get("scoped").unwrapOrThrow()).toBe(request);
            expect(access.get("transient").unwrapOrThrow()).toBe(request * 2 - 1);
            expect(access.get("transient").unwrapOrThrow()).toBe(request * 2);
          }),
        ),
      );
    }
    await ResultTask.runPromise(root.close());
  });

  it("shares factories with token resolution and releases mixed resources in dependency order", async () => {
    const events: string[] = [];
    const dependency = ResultTask.service<object, "database">("database");
    const token = service(
      "consumer",
      ResultTask.gen(function* acquireConsumer() {
        const database = yield* dependency;
        return yield* ResultTask.acquireRelease({
          acquire: ResultTask.succeed({ database }),
          release: () =>
            ResultTask.sync(() => {
              events.push("consumer");
            }),
        });
      }),
    );
    const module = withProvider(createModule().singleton(token), "database", {
      create: () => ({}),
      release: () =>
        ResultTask.sync(() => {
          events.push("database");
        }),
    });
    const root = module.scope();
    await ResultTask.runPromise(
      useServiceAccess(
        root,
        (access) =>
          ResultTask.sync(() => {
            expect(access.get("consumer").unwrapOrThrow()).toEqual({
              database: access.get("database").unwrapOrThrow(),
            });
          }),
        { application: true, initialize: ["consumer"] },
      ),
    );
    expect(events).toEqual([]);
    await ResultTask.runPromise(root.close());
    expect(events).toEqual(["consumer", "database"]);
  });

  it("reports missing, cyclic, asynchronous and lifetime-invalid reads, and rejects closed access", async () => {
    const base = createModule().singleton(service("async", ResultTask.succeed(1)));
    const cyclic = withProvider(base, "cycle", {
      create: (access) => access.get("cycle").unwrapOrThrow(),
    });
    const scopedModule = withProvider(cyclic, "scoped", { lifetime: "scoped", create: () => 1 });
    const module = withProvider(scopedModule, "asyncFactory", {
      create: () => ResultTask.succeed(1),
    });
    const root = module.scope();
    const access = await ResultTask.runPromise(
      useServiceAccess(root, (view) => ResultTask.succeed(view), { application: true }),
    );
    expect(access.get("missing").isErr()).toBe(true);
    expect(() => access.get("cycle").unwrapOrThrow()).toThrow("Circular dependency");
    expect(() => access.get("async").unwrapOrThrow()).toThrow("yield*");
    expect(() => access.get("scoped").unwrapOrThrow()).toThrow("application");
    expect(() => access.get("asyncFactory").unwrapOrThrow()).toThrow("synchronous");
    await ResultTask.runPromise(root.close());
    expect(() => access.get("cycle").unwrapOrThrow()).toThrow("closed");
  });

  it("replaces providers without acquisition and leaves external values unowned", async () => {
    let calls = 0;
    const original = withProvider(createModule(), "value", {
      create: () => {
        calls += 1;
        return 1;
      },
    });
    const external = {
      close: () => {
        calls += 1;
      },
    };
    const module = withProvider(original, "value", { value: external });
    const root = module.scope();
    await ResultTask.runPromise(
      useServiceAccess(root, (access) =>
        ResultTask.sync(() => {
          expect(access.get("value").unwrapOrThrow()).toBe(external);
          expect(access.has("value")).toBe(true);
          expect(access.keys).toEqual(["value"]);
        }),
      ),
    );
    await ResultTask.runPromise(root.close());
    expect(calls).toBe(0);
    expect(inspectModule(module)).toEqual([{ name: "value", lifetime: "singleton" }]);
    expect(() => inspectModule({})).toThrow("createModule");
    await expect(
      ResultTask.runPromise(useServiceAccess({}, (view) => ResultTask.succeed(view))),
    ).rejects.toThrow("scope");
  });
});
