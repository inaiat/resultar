import assert from "node:assert/strict";
import { describe, expectTypeOf, it } from "vite-plus/test";
import * as core from "resultar";
import * as di from "resultar-di";
import * as config from "resultar-config";
import * as app from "../src/index.js";
import { ConfigError, createModule, defineAppConfig, ResultTask, t } from "../src/index.js";

describe("resultar-app", () => {
  it("preserves runtime identities for the component packages", () => {
    for (const component of [core, di, config]) {
      for (const [name, value] of Object.entries(component)) {
        if (name !== "default") assert.equal(Reflect.get(app, name), value, name);
      }
    }
  });

  it("composes inferred configuration and resources with lazy execution and cleanup", async () => {
    const events: string[] = [];
    const settings = defineAppConfig({
      properties: { PORT: t.Integer({ default: 3000 }) },
      source: { PORT: "9000" },
    });
    const services = createModule()
      .merge(settings)
      .resource("connection", ["appConfig"], {
        acquire: ({ appConfig }) =>
          ResultTask.sync(() => {
            events.push("open");
            return { port: appConfig.PORT };
          }),
        release: () =>
          ResultTask.sync(() => {
            events.push("close");
          }),
      });
    const task = services.use(["connection"], ({ connection }) => ResultTask.ok(connection.port));
    expectTypeOf(task).toEqualTypeOf<ResultTask<number, ConfigError>>();
    assert.deepEqual(events, []);
    assert.equal(await task.runPromise(), 9000);
    assert.deepEqual(events, ["open", "close"]);
    assert.equal(await task.runPromise(), 9000);
    assert.deepEqual(events, ["open", "close", "open", "close"]);
  });

  it("reports invalid config before acquiring dependent resources", async () => {
    let acquisitions = 0;
    const services = createModule()
      .merge(defineAppConfig({ properties: { PORT: t.Integer() }, source: { PORT: "invalid" } }))
      .singleton("server", ["appConfig"], ({ appConfig }) => {
        acquisitions += 1;
        return appConfig.PORT;
      });
    const result = await services
      .use(["server"], ({ server }) => ResultTask.ok(server))
      .runResult();
    assert.ok(result.isErr());
    assert.ok(result.error instanceof ConfigError);
    assert.equal(acquisitions, 0);
  });
});
