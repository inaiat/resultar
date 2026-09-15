import { ResultTask } from "resultar";
import { expect, test } from "vite-plus/test";

import { createModule } from "../src/index.js";

interface Database {
  readonly health: () => ResultTask<string>;
  readonly close: () => ResultTask<void>;
}
interface Session {
  readonly close: () => ResultTask<void>;
}
interface Health {
  readonly check: () => ResultTask<string>;
}
interface Server {
  readonly waitForShutdown: () => ResultTask<void>;
  readonly close: () => ResultTask<void>;
}

// Application-facing contracts contain tasks. SDK Promise adapters belong inside these factories.
const applicationModule = (events: string[]) => {
  const connectDatabase = (url: string): ResultTask<Database> =>
    ResultTask.sync(() => {
      events.push(`database: ${url}`);
      let open = true;
      return {
        health: () => ResultTask.sync(() => (open ? "healthy" : "closed")),
        close: () =>
          ResultTask.sync(() => {
            open = false;
            events.push("close database");
          }),
      };
    });
  const connectSession = (database: Database): ResultTask<Session> =>
    database.health().map((health) => {
      expect(health).toBe("healthy");
      events.push("session");
      return {
        close: () =>
          ResultTask.sync(() => {
            events.push("close session");
          }),
      };
    });
  const createHealthUseCase = ({ database }: { readonly database: Database }): Health => ({
    check: database.health,
  });
  const serve = ({
    health,
  }: {
    readonly health: Health;
    readonly session: Session;
  }): ResultTask<Server> =>
    health.check().map((status) => {
      expect(status).toBe("healthy");
      events.push("server");
      return {
        waitForShutdown: () =>
          ResultTask.sync(() => {
            events.push("wait");
          }),
        close: () =>
          ResultTask.sync(() => {
            events.push("close server");
          }),
      };
    });

  return createModule()
    .value("config", { databaseUrl: "memory" })
    .resource("database", ["config"], {
      acquire: ({ config }) => connectDatabase(config.databaseUrl),
      release: (database) => database.close(),
    })
    .scoped("health", ["database"], createHealthUseCase)
    .resource("session", ["database"], {
      acquire: ({ database }) => connectSession(database),
      release: (session) => session.close(),
    })
    .resource("server", ["health", "session"], {
      acquire: serve,
      release: (server) => server.close(),
    });
};

test("runs an application through one lifetime", async () => {
  const events: string[] = [];
  const services = applicationModule(events);
  const program = services.use(["server"], ({ server }) => server.waitForShutdown());
  expect(await ResultTask.runExit(program)).toEqual({ _tag: "Success", value: undefined });
  expect(events).toEqual([
    "database: memory",
    "session",
    "server",
    "wait",
    "close server",
    "close session",
    "close database",
  ]);
});

test("tests health with a typed replacement and no application infrastructure", async () => {
  const events: string[] = [];
  const fakeDatabase: Database = {
    health: () => ResultTask.succeed("mock healthy"),
    close: () =>
      ResultTask.sync(() => {
        events.push("externally owned");
      }),
  };
  const testing = applicationModule(events).override("database", fakeDatabase);
  const result = await ResultTask.runResult(
    testing.use(["health"], ({ health }) => health.check()),
  );
  expect(result.isOk() && result.value).toBe("mock healthy");
  expect(events).toEqual([]);
});

test("reuses an existing ResultTask resource acquisition without duplicating its finalizer", async () => {
  const events: string[] = [];
  const acquireApp = () =>
    ResultTask.acquireRelease({
      acquire: ResultTask.sync(() => {
        events.push("acquire");
        return { status: "running" };
      }),
      release: () =>
        ResultTask.sync(() => {
          events.push("release");
        }),
    });
  const services = createModule().task("app", [], acquireApp);
  const task = services.use(["app"], ({ app }) =>
    ResultTask.sync(() => {
      events.push(app.status);
    }),
  );
  expect(events).toEqual([]);
  await ResultTask.runPromise(task);
  expect(events).toEqual(["acquire", "running", "release"]);
});
