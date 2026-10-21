import { Controller, Get, Req, type INestApplication, type LoggerService } from "@nestjs/common";
import { ResultTask } from "resultar";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createNestApp,
  createNestModule,
  createModule,
  resource,
  Service,
  service,
  Services,
  type NestAppOptions,
  type NestRequest,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

test("configures a native application synchronously and preserves lazy scoped resources", async () => {
  let opened = 0;
  let released = 0;
  let configured = 0;
  const Session = resource("session", {
    acquire: ResultTask.sync(() => {
      opened += 1;
      return { id: opened };
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });

  @Controller()
  class SessionController {
    @Get()
    get(@Services() services: { session: { id: number } }) {
      return services;
    }
  }

  const app = createNestApp(
    {
      services: createModule().scoped(Session),
      bindings: ["session"],
      controllers: [SessionController],
    },
    (instance) => {
      configured += 1;
      expectTypeOf(instance).toExtend<Omit<INestApplication, "listen">>();
    },
  );
  expectTypeOf(app).toExtend<Omit<INestApplication, "listen">>();
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<
    Readonly<{ session: { id: number } }>
  >();
  expect(app).not.toHaveProperty("serviceTypes");
  expect(configured).toBe(1);
  expect(opened).toBe(0);
  expect(app.server.listening).toBe(false);
  try {
    const responses = await Promise.all([app.inject("/"), app.inject("/")]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) => response.json<{ session: { id: number } }>())).toEqual([
      { session: { id: 1 } },
      { session: { id: 2 } },
    ]);
  } finally {
    await app.close();
  }
  expect([configured, opened, released]).toEqual([1, 2, 2]);
});

test("keeps separate application roots and releases their singletons on close", async () => {
  let opened = 0;
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => {
      opened += 1;
      return opened;
    }),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });

  @Controller()
  class ConnectionController {
    @Get()
    get(@Services() services: { connection: number }) {
      return services;
    }
  }

  const options = {
    services: createModule().singleton(Connection),
    bindings: ["connection"],
    appBindings: ["connection"],
    controllers: [ConnectionController],
  } as const;
  const first = createNestApp(options);
  const second = createNestApp(options);
  expect(opened).toBe(0);
  try {
    const firstResponse = await first.inject("/");
    const secondResponse = await second.inject("/");
    expect(firstResponse.json()).toEqual({ connection: 1 });
    expect(secondResponse.json()).toEqual({ connection: 2 });
  } finally {
    await first.close();
    await second.close();
  }
  expect(released).toBe(2);
});

test("retains native startup failure and rollback", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.succeed("connected"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const Failing = service("failing", ResultTask.fail("offline"));
  const app = createNestApp({
    services: createModule().singleton(Connection).singleton(Failing),
    bindings: [],
    appBindings: ["connection", "failing"],
  });
  try {
    await expect(app.ready()).rejects.toThrow();
    expect(released).toBe(1);
  } finally {
    await app.close();
  }
});

test("runs an optional ResultTask startup once after application services are ready", async () => {
  let runs = 0;
  const Config = Service.require<{ readonly environment: string }>()("config");
  const startup = ResultTask.gen(function* initialize() {
    const config = yield* Config;
    runs += 1;
    expect(config.environment).toBe("test");
  });

  @Controller()
  class ReadyController {
    @Get()
    get() {
      return "ready";
    }
  }

  const app = createNestApp({
    services: createModule().value("config", { environment: "test" }),
    startup,
    bindings: [],
    controllers: [ReadyController],
  });
  expect(runs).toBe(0);
  await app.ready();
  expect(runs).toBe(1);
  await app.inject("/");
  await app.ready();
  expect(runs).toBe(1);
  await app.close();
});

test("rolls back application resources when optional startup fails", async () => {
  let released = 0;
  const Connection = resource("connection", {
    acquire: ResultTask.sync(() => "connected"),
    release: () =>
      ResultTask.sync(() => {
        released += 1;
      }),
  });
  const app = createNestApp({
    services: createModule().singleton(Connection),
    startup: ResultTask.gen(function* failStartup() {
      yield* Connection;
      return yield* ResultTask.fail("offline" as const);
    }),
    bindings: [],
  });
  await expect(app.ready()).rejects.toThrow();
  expect(released).toBe(1);
  await app.close();
});

const typeChecks = () => {
  const module = createModule().value("answer", 42);
  // @ts-expect-error Unknown binding.
  createNestApp({ services: module, bindings: ["missing"] });
  const Tenant = Service.require<string>()("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);
  const services = createModule().scoped(Greeting);
  // @ts-expect-error Required dependency was not supplied.
  createNestApp({ services, bindings: ["greeting"] });
  createNestApp({ services, bindings: ["greeting"], locals: () => ({ tenant: "ok" }) });
  // @ts-expect-error Incompatible local dependency.
  createNestApp({ services, bindings: ["greeting"], locals: () => ({ tenant: 42 }) });
  const Config = Service.require<string>()("config");
  const startup = ResultTask.gen(function* checkConfig() {
    yield* Config;
  });
  createNestApp({ services: createModule().value("config", "test"), startup, bindings: [] });
  // @ts-expect-error Startup requirements must be registered in the module.
  createNestApp({ services: createModule(), startup, bindings: [] });
  const ConfigGreeting = service("configGreeting", { config: Config }, ({ config }) => config);
  const transitiveStartup = ResultTask.gen(function* useGreeting() {
    yield* ConfigGreeting;
  });
  const missingTransitive = {
    services: createModule().singleton(ConfigGreeting),
    startup: transitiveStartup,
    bindings: [],
  } as const;
  // @ts-expect-error Transitive startup requirements must be registered in the module.
  createNestApp(missingTransitive);
};
expectTypeOf(typeChecks).toBeFunction();

test("infers selected services from the application factory without exposing internal providers", async () => {
  const module = createModule().value("answer", 42).value("internal", "hidden");

  @Controller()
  class AnswerController {
    @Get()
    get(@Services() services: { answer: number }) {
      return services;
    }
  }

  const createApplication = (services = module) =>
    createNestApp({
      services,
      bindings: ["answer"],
      appBindings: ["internal"],
      controllers: [AnswerController],
    });
  type Application = ReturnType<typeof createApplication>;
  type RequestServices = InferRequestServices<typeof createApplication>;
  expectTypeOf<RequestServices>().toEqualTypeOf<InferRequestServices<Application>>();
  expectTypeOf<RequestServices>().toEqualTypeOf<Readonly<{ answer: number }>>();
  expectTypeOf<keyof RequestServices>().toEqualTypeOf<"answer">();
  expectTypeOf<InferAppServices<Application>>().toEqualTypeOf<Readonly<{ internal: string }>>();
  expectTypeOf<InferAppServices<typeof createApplication>>().toEqualTypeOf<
    InferAppServices<Application>
  >();
  const app = createApplication();
  try {
    const response = await app.inject("/");
    expect(response.json()).toEqual({ answer: 42 });
    expect(app.getDecorator("services")).toEqual({ internal: "hidden" });
  } finally {
    await app.close();
  }
});

const inferenceChecks = () => {
  const options = {
    services: createModule().value("answer", 42),
    bindings: ["answer"],
    exposeRequest: () => ({ visible: "request" }),
    exposeApplication: () => ({ visible: "app" }),
  } as const;
  const nestModule = createNestModule(options);
  const createMod = (answer: number) =>
    createNestModule({ services: createModule().value("answer", answer), bindings: ["answer"] });
  expectTypeOf<InferRequestServices<typeof createMod>>().toEqualTypeOf<
    Readonly<{ answer: number }>
  >();
  // eslint-disable-next-line typescript/no-generated-empty-object-type -- This assertion verifies that no application service keys are selected.
  expectTypeOf<keyof InferAppServices<typeof createMod>>().toEqualTypeOf<never>();
  expectTypeOf<InferRequestServices<() => number>>().toEqualTypeOf<never>();
  expectTypeOf<InferAppServices<() => number>>().toEqualTypeOf<never>();
  const app = createNestApp(options);
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<
    InferRequestServices<typeof nestModule>
  >();
  expectTypeOf<InferRequestServices<typeof app>>().toEqualTypeOf<{ visible: string }>();
  expectTypeOf<InferAppServices<typeof app>>().toEqualTypeOf<InferAppServices<typeof nestModule>>();
  expectTypeOf<InferAppServices<typeof app>>().toEqualTypeOf<{ visible: string }>();
  const empty = createNestApp({ services: options.services, bindings: [] });
  // eslint-disable-next-line typescript/no-generated-empty-object-type -- This assertion verifies that an empty selection exposes no request service keys.
  expectTypeOf<keyof InferRequestServices<typeof empty>>().toEqualTypeOf<never>();
  // eslint-disable-next-line typescript/no-generated-empty-object-type -- This assertion verifies that an empty selection exposes no application service keys.
  expectTypeOf<keyof InferAppServices<typeof empty>>().toEqualTypeOf<never>();
};
expectTypeOf(inferenceChecks).toBeFunction();

test("forwards NestJS application options and requestIdHeader to the underlying instance", async () => {
  const logs: string[] = [];
  const logger: LoggerService = {
    log(message: unknown) {
      logs.push(String(message));
    },
    error(message: unknown) {
      logs.push(String(message));
    },
    warn(message: unknown) {
      logs.push(String(message));
    },
  };

  @Controller()
  class TraceController {
    @Get()
    get(@Req() request: NestRequest, @Services() services: { answer: number }) {
      logger.log("handled request");
      return { id: request.id, answer: services };
    }
  }

  const options = {
    services: createModule().value("answer", 42),
    bindings: ["answer"],
    logger,
    requestIdHeader: "x-trace-id",
    controllers: [TraceController],
  } as const satisfies NestAppOptions;
  const app = createNestApp(options);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-trace-id": "req-123" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "req-123", answer: { answer: 42 } });
    expect(logs.some((entry) => entry.includes("handled request"))).toBe(true);
  } finally {
    await app.close();
  }
});
