import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  it("imports and runs core, Match, TaggedError, DI, and lazy config under --disallow-code-generation-from-strings", () => {
    const entryUrl = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href;
    const script = `
      import {
        Match,
        ResultTask,
        createModule,
        createTaggedError,
        defineAppConfig,
        t,
      } from ${JSON.stringify(entryUrl)};

      class TestErr extends createTaggedError({ name: "TestErr", message: "code $code" }) {}
      const errInstance = new TestErr({ code: 42 });

      const matcher = Match.type().pipe(
        Match.discriminator("kind")("hit", () => "matched"),
        Match.orElse(() => "missed"),
      );

      const chain = ResultTask.sync(() => 10).map((n) => n + 5).map((n) => n * 2);
      const taskRuns = [
        await chain.runPromise(),
        await chain.runPromise(),
        await chain.runPromise(),
      ];

      const config = defineAppConfig({
        properties: { PORT: t.Integer({ default: 3000 }) },
        source: {},
      });
      const root = createModule().merge(config).value("greeting", "hello").scope();
      const handle = root.fetch(["greeting"], ({ greeting }) => new Response(greeting));
      const response = await handle(new Request("https://example.test/"));
      const fetchBody = await response.text();
      await root.close().runPromise();

      const configExit = await config.load().runExit();

      console.log(JSON.stringify({
        errMessage: errInstance.message,
        matched: matcher({ kind: "hit" }),
        taskRuns,
        fetchBody,
        configExitTag: configExit._tag,
        configCauseTag: configExit._tag === "Failure" ? configExit.cause._tag : undefined,
        configIsEvalError:
          configExit._tag === "Failure" &&
          configExit.cause._tag === "Die" &&
          configExit.cause.defect instanceof EvalError,
      }));
    `;

    for (const jitFlag of ["0", "1"] as const) {
      const raw = execFileSync(
        process.execPath,
        ["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
        {
          env: { ...process.env, RESULTAR_JIT: jitFlag },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      assert.deepEqual(JSON.parse(raw.trim()), {
        errMessage: "code 42",
        matched: "matched",
        taskRuns: [30, 30, 30],
        fetchBody: "hello",
        configExitTag: "Failure",
        configCauseTag: "Die",
        configIsEvalError: true,
      });
    }
  });
});
