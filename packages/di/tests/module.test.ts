import { ResultTask } from "resultar";
import { describe, expect, test } from "vite-plus/test";

import { createModule } from "../src/index.js";

describe("service composition", () => {
  test("is lazy and resolves only the selected dependency graph", async () => {
    const events: string[] = [];
    const services = createModule()
      .value("config", { url: "memory" })
      .scoped("database", ["config"], ({ config }) => {
        events.push("database");
        return { url: config.url };
      })
      .scoped("health", ["database"], ({ database }) => {
        events.push("health");
        return { check: () => database.url };
      })
      .scoped("session", [], () => {
        throw new Error("unselected service must not be created");
      });
    const task = services.use(["health"], ({ health }) => ResultTask.sync(health.check));
    expect(events).toEqual([]);
    expect(await ResultTask.runExit(task)).toEqual({ _tag: "Success", value: "memory" });
    expect(events).toEqual(["database", "health"]);
  });

  test("shares diamond dependencies once per execution, including reruns of the same task", async () => {
    let creations = 0;
    const services = createModule()
      .scoped("database", [], () => {
        creations += 1;
        return { id: creations };
      })
      .scoped("left", ["database"], ({ database }) => database)
      .scoped("right", ["database"], ({ database }) => database);
    const task = services.use(["left", "right"], ({ left, right }) => {
      expect(left).toBe(right);
      return ResultTask.succeed(left.id);
    });
    const exits = await Promise.all([ResultTask.runExit(task), ResultTask.runExit(task)]);
    expect(exits).toEqual([
      { _tag: "Success", value: 1 },
      { _tag: "Success", value: 2 },
    ]);
    expect(creations).toBe(2);
  });

  test("overrides skip the original dependencies without modifying the original module", async () => {
    let creations = 0;
    const services = createModule()
      .scoped("database", [], () => {
        creations += 1;
        return { status: "live" };
      })
      .scoped("health", ["database"], ({ database }) => ({ check: () => database.status }));
    const testing = services.override("health", { check: () => "mock" });
    expect(
      await ResultTask.runPromise(
        testing.use(["health"], ({ health }) => ResultTask.sync(health.check)),
      ),
    ).toBe("mock");
    expect(creations).toBe(0);
    expect(
      await ResultTask.runPromise(
        services.use(["health"], ({ health }) => ResultTask.sync(health.check)),
      ),
    ).toBe("live");
    expect(creations).toBe(1);
  });

  test("rebuilds dependents with overridden dependencies", async () => {
    const services = createModule()
      .value("database", { status: "live" })
      .scoped("health", ["database"], ({ database }) => database.status)
      .override("database", { status: "mock" });
    expect(
      await ResultTask.runPromise(
        services.use(["health"], ({ health }) => ResultTask.succeed(health)),
      ),
    ).toBe("mock");
  });

  test("caches undefined and handles property names without prototype collisions", async () => {
    let creations = 0;
    const services = createModule()
      .scoped("__proto__", [], () => {
        creations += 1;
      })
      .scoped("constructor", ["__proto__"], (deps) => Object.hasOwn(deps, "__proto__"));
    const value = await ResultTask.runPromise(
      services.use(["constructor", "__proto__"], (deps) => ResultTask.succeed(deps.constructor)),
    );
    expect(value).toBe(true);
    expect(creations).toBe(1);
  });

  test("validates duplicate registrations and missing dependencies for JavaScript callers", () => {
    const services = createModule().value("config", 1);
    // @ts-expect-error Duplicate service names are also rejected statically.
    expect(() => services.value("config", 2)).toThrow("Service already registered: config");
    // @ts-expect-error Forward references are rejected before execution.
    expect(() => services.scoped("repo", ["missing"], () => 1)).toThrow("Unknown service: missing");
    // @ts-expect-error Unknown selections cannot silently produce undefined.
    expect(() => services.use(["missing"], () => ResultTask.succeed(1))).toThrow(
      "Unknown service: missing",
    );
    // @ts-expect-error An override must replace a registered service.
    expect(() => services.override("missing", 2)).toThrow("Unknown service: missing");
  });

  test("rejects asynchronous factories for JavaScript callers", async () => {
    // @ts-expect-error Tasks must use resource acquisition, not synchronous factories.
    const services = createModule().scoped("invalid", [], () => ResultTask.succeed(1));
    const exit = await ResultTask.runExit(services.use(["invalid"], () => ResultTask.succeed(1)));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Die") {
      expect(exit.cause.defect).toBeInstanceOf(TypeError);
    } else {
      throw new Error("Expected a factory defect");
    }
  });
});

describe("service lifetimes", () => {
  test("creates a distinct transient for each injection within one child scope", async () => {
    const services = createModule()
      .transient("operation", [], () => ({}))
      .transient("left", ["operation"], ({ operation }) => operation)
      .transient("right", ["operation"], ({ operation }) => operation);

    const distinct = await ResultTask.runPromise(
      services.use(["left", "right"], ({ left, right }) => ResultTask.succeed(left !== right)),
    );
    expect(distinct).toBe(true);
  });

  test("shares singletons across child scopes and recreates scoped and transient services", async () => {
    let singletonCreations = 0;
    let scopedCreations = 0;
    let transientCreations = 0;
    const services = createModule()
      .singleton("singleton", [], () => {
        singletonCreations += 1;
        return { id: singletonCreations };
      })
      .scoped("scoped", ["singleton"], ({ singleton }) => {
        scopedCreations += 1;
        return { singleton, id: scopedCreations };
      })
      .transient("transient", ["singleton"], ({ singleton }) => {
        transientCreations += 1;
        return { singleton, id: transientCreations };
      });
    const application = services.scope();
    const program = application.use(["singleton", "scoped", "transient"], (resolved) =>
      ResultTask.succeed(resolved),
    );
    const first = await ResultTask.runPromise(program);
    const second = await ResultTask.runPromise(program);

    expect(first.singleton).toBe(second.singleton);
    expect(first.scoped).not.toBe(second.scoped);
    expect(first.transient).not.toBe(second.transient);
    expect(singletonCreations).toBe(1);
    expect(scopedCreations).toBe(2);
    expect(transientCreations).toBe(2);
    await ResultTask.runPromise(application.close());
  });

  test("keeps singleton resources alive until the root closes", async () => {
    const events: string[] = [];
    const services = createModule().resource("database", [], {
      lifetime: "singleton",
      acquire: () =>
        ResultTask.sync(() => {
          events.push("open");
          return { open: true };
        }),
      release: (database) =>
        ResultTask.sync(() => {
          database.open = false;
          events.push("close");
        }),
    });
    const application = services.scope();

    await ResultTask.runPromise(
      application.use(["database"], ({ database }) => ResultTask.succeed(database.open)),
    );
    await ResultTask.runPromise(
      application.use(["database"], ({ database }) => ResultTask.succeed(database.open)),
    );
    expect(events).toEqual(["open"]);

    await ResultTask.runPromise(application.close());
    await ResultTask.runPromise(application.close());
    expect(events).toEqual(["open", "close"]);
  });

  test("rejects a singleton that captures a shorter-lived service", async () => {
    const services = createModule()
      .scoped("request", [], () => ({ id: 1 }))
      .singleton("application", ["request"], ({ request }) => request);
    const exit = await ResultTask.runExit(
      services.use(["application"], ({ application }) => ResultTask.succeed(application)),
    );

    expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Die" } });
    if (exit._tag === "Failure" && exit.cause._tag === "Die") {
      expect(exit.cause.defect).toBeInstanceOf(TypeError);
      expect((exit.cause.defect as TypeError).message).toBe(
        'Lifetime violation: singleton service "application" cannot depend on shorter-lived scoped service "request". Resolution path: application -> request. Align their lifetimes or pass request data to a service method.',
      );
    }
  });
});

describe("scoped resources", () => {
  const createApplication = (events: string[]) =>
    createModule()
      .resource("database", [], {
        acquire: () =>
          ResultTask.sync(() => {
            events.push("open database");
            return { open: true };
          }),
        release: (database) =>
          ResultTask.sync(() => {
            database.open = false;
            events.push("close database");
          }),
      })
      .resource("session", ["database"], {
        acquire: ({ database }) =>
          ResultTask.sync(() => {
            expect(database.open).toBe(true);
            events.push("open session");
            return { connected: true };
          }),
        release: (session, exit, { database }) =>
          ResultTask.sync(() => {
            expect(database.open).toBe(true);
            session.connected = false;
            events.push(`close session: ${exit._tag}`);
          }),
      });

  test("keeps resources alive through use and closes dependents before dependencies", async () => {
    const events: string[] = [];
    const task = createApplication(events)
      .use(["database", "session"], ({ database, session }) =>
        ResultTask.sync(() => {
          expect(database.open && session.connected).toBe(true);
          events.push("use");
          return "done";
        }),
      )
      .map((value) => {
        events.push("after scope");
        return value;
      });
    expect(await ResultTask.runPromise(task)).toBe("done");
    expect(events).toEqual([
      "open database",
      "open session",
      "use",
      "close session: Success",
      "close database",
      "after scope",
    ]);
  });

  test("rolls back acquired resources when a later acquisition fails", async () => {
    const events: string[] = [];
    const bootError = new Error("server failed");
    const services = createApplication(events).resource("server", ["session"], {
      acquire: () => ResultTask.fail(bootError),
      release: () =>
        ResultTask.sync(() => {
          events.push("must not release unacquired server");
        }),
    });
    const exit = await ResultTask.runExit(
      services.use(["server"], () => ResultTask.succeed("unreachable")),
    );
    expect(exit).toEqual({ _tag: "Failure", cause: { _tag: "Fail", error: bootError } });
    expect(events).toEqual([
      "open database",
      "open session",
      "close session: Failure",
      "close database",
    ]);
  });

  test("cleans up when a factory throws during partial construction", async () => {
    const events: string[] = [];
    const defect = new Error("factory bug");
    const services = createApplication(events).scoped("server", ["session"], ({ session }) => {
      expect(session.connected).toBe(true);
      throw defect;
    });
    expect(await ResultTask.runExit(services.use(["server"], () => ResultTask.succeed(1)))).toEqual(
      { _tag: "Failure", cause: { _tag: "Die", defect } },
    );
    expect(events.slice(-2)).toEqual(["close session: Failure", "close database"]);
  });

  test("preserves use and release failures and still releases earlier resources", async () => {
    const events: string[] = [];
    const useError = { _tag: "UseError" };
    const releaseError = { _tag: "ReleaseError" };
    const services = createApplication(events).resource("server", ["session"], {
      acquire: () => ResultTask.succeed(1),
      release: () => ResultTask.fail(releaseError),
    });
    const exit = await ResultTask.runExit(
      services.use(["server"], () => ResultTask.fail(useError)),
    );
    expect(exit).toEqual({
      _tag: "Failure",
      cause: {
        _tag: "Sequential",
        left: { _tag: "Fail", error: useError },
        right: { _tag: "Fail", error: releaseError },
      },
    });
    expect(events.slice(-2)).toEqual(["close session: Failure", "close database"]);
  });

  test("continues cleanup after a release callback throws", async () => {
    const events: string[] = [];
    const defect = new Error("release bug");
    const services = createApplication(events).resource("server", ["session"], {
      acquire: () => ResultTask.succeed(1),
      release: () => {
        throw defect;
      },
    });
    const exit = await ResultTask.runExit(services.use(["server"], () => ResultTask.succeed(1)));
    expect(exit).toEqual({ _tag: "Failure", cause: { _tag: "Die", defect } });
    expect(events.slice(-2)).toEqual(["close session: Success", "close database"]);
  });

  test("interruption cleans up using a fresh signal", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const services = createApplication(events).resource("server", ["session"], {
      acquire: () => ResultTask.succeed(1),
      release: () =>
        ResultTask.tryPromise({
          try: (signal) => {
            expect(signal.aborted).toBe(false);
            events.push("close server");
            return Promise.resolve();
          },
          catch: (cause) => cause,
        }),
    });
    const task = services.use(["server"], () =>
      ResultTask.sync(() => {
        controller.abort("stop");
      }),
    );
    const exit = await ResultTask.runExit(task, { signal: controller.signal });
    expect(exit).toEqual({ _tag: "Failure", cause: { _tag: "Interrupt", reason: "stop" } });
    expect(events.slice(-3)).toEqual(["close server", "close session: Failure", "close database"]);
  });

  test("does not acquire or release an overridden resource", async () => {
    const events: string[] = [];
    const session = { connected: true };
    const services = createApplication(events).override("session", session);
    await ResultTask.runPromise(
      services.use(["session"], (deps) => ResultTask.succeed(deps.session.connected)),
    );
    expect(events).toEqual([]);
    expect(session.connected).toBe(true);
  });

  test("cleans up when the use callback throws before returning a task", async () => {
    const events: string[] = [];
    const defect = new Error("callback bug");
    const task = createApplication(events).use(["session"], () => {
      throw defect;
    });
    expect(await ResultTask.runExit(task)).toEqual({
      _tag: "Failure",
      cause: { _tag: "Die", defect },
    });
    expect(events.slice(-2)).toEqual(["close session: Failure", "close database"]);
  });
});
