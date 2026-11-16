/* eslint-disable unicorn/no-await-expression-member, no-await-in-loop -- Sequential isolation checks inspect execution results. */
import { expect, expectTypeOf, test } from "vite-plus/test";
import { Type } from "typebox";
import { ResultTask } from "resultar";
import { createModule } from "resultar-di";
import { ConfigError, defineAppConfig, t, type AppConfigModule } from "../src/index.js";

const properties = {
  PORT: Type.Integer({ default: 8080, minimum: 1, maximum: 65_535 }),
  TOKEN: Type.String({ minLength: 3 }),
  ENABLED: Type.Boolean({ default: false }),
  MODE: Type.Union([Type.Literal("dev"), Type.Literal("prod")], { default: "dev" }),
  OPTIONAL: Type.Optional(Type.String()),
};
const read = (source: Readonly<Record<string, string | undefined>>) =>
  defineAppConfig({ properties, source }).load();

test("defaults, booleans, literals, optional properties and immutable explicit inputs", async () => {
  const source = Object.freeze({
    TOKEN: "  secret  ",
    PORT: "9000",
    ENABLED: "false",
    EXTRA: "ignore",
  });
  const value = await read(source).runPromise();
  expect(value).toEqual({ TOKEN: "  secret  ", PORT: 9000, ENABLED: false, MODE: "dev" });
  expect(source.PORT).toBe("9000");
  expect((await read({ TOKEN: "secret", ENABLED: "true" }).runPromise()).ENABLED).toBe(true);
  expect((await read({ TOKEN: "secret" }).runPromise()).PORT).toBe(8080);
  expectTypeOf(value.PORT).toEqualTypeOf<number>();
  expectTypeOf(value.OPTIONAL).toEqualTypeOf<string | undefined>();
  expectTypeOf(value.MODE).toEqualTypeOf<"dev" | "prod">();
});

for (const value of ["NaN", "Infinity", "-Infinity", "1e309", "-1e309", "1.5", "0", "65536", ""]) {
  test(`rejects invalid numeric input ${value}`, async () => {
    expect((await read({ TOKEN: "secret", PORT: value }).runResult()).isErr()).toBe(true);
  });
}
for (const value of ["yes", "1", "TRUE", ""]) {
  test(`rejects unsupported boolean ${value}`, async () => {
    expect((await read({ TOKEN: "secret", ENABLED: value }).runResult()).isErr()).toBe(true);
  });
}

test("finite numbers are revalidated after coercion, including nested defaults", async () => {
  for (const value of ["Infinity", "1e309"]) {
    const config = defineAppConfig({
      properties: { NUMBER: Type.Number() },
      source: { NUMBER: value },
    });
    expect(
      (await config.use(["appConfig"], () => ResultTask.ok(undefined)).runResult()).isErr(),
    ).toBe(true);
  }
  const result = await defineAppConfig({
    properties: { NESTED: Type.Object({ N: Type.Number() }, { default: { N: "1e309" } }) },
    source: {},
  })
    .use(["appConfig"], () => ResultTask.ok(undefined))
    .runResult();
  expect(result.isErr()).toBe(true);
});

test("aggregates controlled issues without rejected values, source maps or validator exceptions", async () => {
  const result = await read({ PORT: "secret-port", ENABLED: "secret-bool" }).runResult();
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(ConfigError);
    expect(result.error.issues.map((issue) => issue.path).toSorted()).toEqual([
      "/ENABLED",
      "/PORT",
      "/TOKEN",
    ]);
    expect(JSON.stringify(result.error)).not.toContain("secret");
    expect(result.error.cause).toBeUndefined();
    expect(Object.isFrozen(result.error.issues)).toBe(true);
  }
});

test("configuration is lazy, cached within a root, and isolated across roots", async () => {
  let reads = 0;
  const source = {
    get TOKEN() {
      reads += 1;
      return "secret";
    },
  };
  const module = createModule().merge(defineAppConfig({ properties, source }));
  const root = module.scope();
  expect(reads).toBe(0);
  const first = await root
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runPromise();
  const second = await root
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runPromise();
  expect(first).toBe(second);
  expect(reads).toBe(1);
  await root.close().runPromise();
  const third = await module
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runPromise();
  expect(third).not.toBe(first);
  expect(reads).toBe(2);
});

test("explicit empty sources never fall back to the environment, while default reads at resolution", async () => {
  const key = "RESULTAR_CONFIG_TEST_TOKEN";
  const previous = process.env[key];
  try {
    const config = defineAppConfig({ properties: { [key]: Type.String() } });
    process.env[key] = "host-secret";
    expect(
      await config
        .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig[key]))
        .runPromise(),
    ).toBe("host-secret");
    const isolated = defineAppConfig({ properties: { [key]: Type.String() }, source: {} });
    expect(
      (await isolated.use(["appConfig"], () => ResultTask.ok(undefined)).runResult()).isErr(),
    ).toBe(true);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = previous;
  }
});

test("schema faults stay defects and failed validation can be retried in the same root", async () => {
  const invalidSchema = defineAppConfig({
    properties: { TOKEN: Type.String({ pattern: "[" }) },
    source: { TOKEN: "secret" },
  });
  const exit = await invalidSchema.load().runExit();
  expect(exit._tag === "Failure" && exit.cause._tag).toBe("Die");
  const source: Record<string, string> = {};
  const root = defineAppConfig({ properties, source }).scope();
  expect((await root.use(["appConfig"], () => ResultTask.ok(undefined)).runResult()).isErr()).toBe(
    true,
  );
  source.TOKEN = "secret";
  expect((await root.use(["appConfig"], () => ResultTask.ok(undefined)).runResult()).isOk()).toBe(
    true,
  );
  await root.close().runPromise();
});

test("startup dependency graph validates before resources and rolls back later failures", async () => {
  for (const valid of [false, true]) {
    const events: string[] = [];
    const source = {
      get TOKEN() {
        events.push("config");
        return valid ? "secret" : "";
      },
    };
    const module = createModule()
      .merge(defineAppConfig({ properties, source }))
      .resource("database", ["appConfig"], {
        acquire: () =>
          ResultTask.sync(() => {
            events.push("database");
            return 1;
          }),
        release: () =>
          ResultTask.sync(() => {
            events.push("close database");
          }),
      })
      .resource("server", ["database"], {
        acquire: () =>
          ResultTask.sync(() => {
            events.push("server");
          }).andThen(() => ResultTask.err("listen" as const)),
        release: () => ResultTask.ok(undefined),
      });
    const result = await module.use(["server"], () => ResultTask.ok(undefined)).runResult();
    expect(result.isErr()).toBe(true);
    expect(events).toEqual(valid ? ["config", "database", "server", "close database"] : ["config"]);
  }
});

const typeChecks = () => {
  const config = defineAppConfig({ properties, source: { TOKEN: "secret" } });
  expectTypeOf(config).toEqualTypeOf<AppConfigModule<typeof properties>>();
  expectTypeOf(config.load()).toEqualTypeOf<
    ResultTask<
      { PORT: number; TOKEN: string; ENABLED: boolean; MODE: "dev" | "prod"; OPTIONAL?: string },
      ConfigError
    >
  >();
  const factory = (input = config) => createModule().merge(input).value("unrelated", 1);
  const module = factory();
  expectTypeOf(
    module.use(["unrelated"], ({ unrelated }) => ResultTask.ok(unrelated)),
  ).toEqualTypeOf<ResultTask<number>>();
  expectTypeOf(
    module.use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig.PORT)),
  ).toEqualTypeOf<ResultTask<number, ConfigError>>();
  // @ts-expect-error Injected configuration must preserve its schema types.
  factory(defineAppConfig({ properties: { PORT: Type.String() } }));
  // @ts-expect-error Duplicate registrations remain rejected.
  config.merge(config);
};
expectTypeOf(typeChecks).toBeFunction();

test("empty and whitespace strings follow each schema without normalization", async () => {
  const value = await defineAppConfig({
    properties: { TEXT: Type.String(), NUMBER: Type.Number() },
    source: { TEXT: "", NUMBER: "  " },
  })
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runPromise();
  expect(value).toEqual({ TEXT: "", NUMBER: 0 });
  const result = await read({ TOKEN: "secret", PORT: "  " }).runResult();
  expect(result.isErr()).toBe(true);
});
const mergedErrors = () => {
  const module = defineAppConfig({ properties }).task("other", ["appConfig"], () =>
    ResultTask.err("other" as const),
  );
  expectTypeOf(module.use(["other"], () => ResultTask.ok(undefined))).toEqualTypeOf<
    ResultTask<undefined, ConfigError | "other">
  >();
};
expectTypeOf(mergedErrors).toBeFunction();

test("aggregates numeric overflow with unrelated missing fields", async () => {
  const result = await defineAppConfig({
    properties: { NUMBER: Type.Number(), SECRET: Type.String() },
    source: { NUMBER: "1e309" },
  })
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runResult();
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error.issues.map((issue) => issue.path).toSorted()).toEqual([
      "/NUMBER",
      "/SECRET",
    ]);
});

test("load is lazy and refreshes each execution without changing existing root snapshots", async () => {
  let reads = 0;
  let token = "first";
  const config = defineAppConfig({
    properties,
    source: {
      get TOKEN() {
        reads += 1;
        return token;
      },
    },
  });
  const task = config.load();
  const root = createModule().merge(config).scope();
  expect(reads).toBe(0);
  const cached = await root
    .use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig))
    .runPromise();
  const first = await task.runPromise();
  expect(first).toEqual(cached);
  expect(first).not.toBe(cached);
  token = "second";
  const second = await task.runPromise();
  expect(second.TOKEN).toBe("second");
  expect(second).not.toBe(first);
  expect(
    await root.use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig)).runPromise(),
  ).toBe(cached);
  expect(cached.TOKEN).toBe("first");
  expect(reads).toBe(3);
  await root.close().runPromise();
});

test("t reexports TypeBox and preserves inference alongside directly imported schemas", async () => {
  expect(t).toBe(Type);
  const config = defineAppConfig({
    properties: {
      PORT: t.Integer({ default: 3000 }),
      MODE: t.Union([t.Literal("dev"), t.Literal("prod")]),
      TOKEN: t.Optional(t.String()),
      ENABLED: Type.Boolean({ default: false }),
    },
    source: { PORT: "9000", MODE: "dev" },
  });
  expectTypeOf(config.load()).toEqualTypeOf<
    ResultTask<
      { PORT: number; MODE: "dev" | "prod"; TOKEN?: string; ENABLED: boolean },
      ConfigError
    >
  >();
  expect(await config.load().runPromise()).toEqual({ PORT: 9000, MODE: "dev", ENABLED: false });
});
