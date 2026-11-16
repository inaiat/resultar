import { deepEqual } from "node:assert/strict";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { defineAppConfig, t } from "../dist/index.js";

const properties = {
  PORT: t.Integer({ default: 8080, minimum: 1, maximum: 65_535 }),
  DATABASE_URL: t.String({ minLength: 1 }),
};
const defaultConfig = defineAppConfig({ properties });
const createServices = (config = defaultConfig) => createModule().merge(config);
const events: string[] = [];
const testConfig = defineAppConfig({
  properties,
  source: { PORT: "9000", DATABASE_URL: "postgresql://localhost/example_test" },
});
deepEqual(await testConfig.load().runPromise(), {
  PORT: 9000,
  DATABASE_URL: "postgresql://localhost/example_test",
});
const services = createServices(testConfig)
  .resource("database", ["appConfig"], {
    acquire: ({ appConfig }) =>
      ResultTask.sync(() => {
        events.push("database");
        return { url: appConfig.DATABASE_URL };
      }),
    release: () =>
      ResultTask.sync(() => {
        events.push("close database");
      }),
  })
  .resource("server", ["appConfig", "database"], {
    acquire: ({ appConfig, database }) =>
      ResultTask.sync(() => {
        events.push("server");
        return { port: appConfig.PORT, database };
      }),
    release: () =>
      ResultTask.sync(() => {
        events.push("close server");
      }),
  });
const program = services.use(["server"], ({ server }) => ResultTask.ok(server.port));
deepEqual(events, []);
deepEqual(await program.runExit(), { _tag: "Success", value: 9000 });
deepEqual(events, ["database", "server", "close server", "close database"]);
