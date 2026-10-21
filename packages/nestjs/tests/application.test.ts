/* eslint-disable unicorn/no-null, unicorn/no-await-expression-member */
import { Readable, PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { request as nodeHttpRequest } from "node:http";
import {
  BadRequestException,
  Catch,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Req,
  Res,
  StreamableFile,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplicationContext,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ResultTask } from "resultar";
import { createModule, service, resource } from "resultar-di";
import {
  APP_SERVICES,
  createNestApp,
  createNestModule,
  FastifyAdapter,
  getAppServices,
  getRequestServices,
  Services,
  type InferAppServices,
  type InferRequestServices,
  type NestRequest,
} from "../src/index.js";

function serverUrl(server: { address: () => string | AddressInfo | null }): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function fixture() {
  const events: string[] = [];
  let next = 0;
  const Shared = resource("shared", {
    acquire: ResultTask.sync(() => {
      events.push("open root");
      return { closed: false };
    }),
    release: (value) =>
      ResultTask.sync(() => {
        value.closed = true;
        events.push("close root");
      }),
  });
  const Local = resource("local", {
    acquire: ResultTask.gen(function* acquireLocal() {
      const shared = yield* Shared;
      next += 1;
      return { shared, id: next, closed: false };
    }),
    release: (value) =>
      ResultTask.sync(() => {
        value.closed = true;
        events.push("close child");
      }),
  });
  const services = createModule().singleton(Shared).scoped(Local);
  const nestModule = createNestModule({ services, appBindings: ["shared"], bindings: ["local"] });
  return { events, services, nestModule };
}

test("native registration initializes app singletons and isolates concurrent request services", async () => {
  const { events, nestModule } = fixture();
  type App = InferAppServices<typeof nestModule>;
  type Request = InferRequestServices<typeof nestModule>;
  expectTypeOf<App>().toEqualTypeOf<Readonly<{ shared: { closed: boolean } }>>();
  const instances: Request["local"][] = [];

  @Controller()
  class RootController {
    readonly #appServices: App;
    constructor(@Inject(APP_SERVICES) appServices: App) {
      this.#appServices = appServices;
    }

    @Get()
    get(@Services() reqServices: Request, @Services("local") directLocal: Request["local"]) {
      const { local } = reqServices;
      expect(directLocal).toBe(local);
      instances.push(local);
      expect(local.shared).toBe(this.#appServices.shared);
      return { id: local.id };
    }
  }

  const app = createNestApp({
    services: fixture().services,
    imports: [],
    controllers: [RootController],
    appBindings: ["shared"],
    bindings: ["local"],
  });

  // Also test createNestModule imported into a native NestFactory application
  @Module({ imports: [nestModule], controllers: [RootController] })
  class NativeModule {}

  const nativeApp = await NestFactory.create(NativeModule, new FastifyAdapter(), { logger: false });
  expect(events).toEqual([]);
  await nativeApp.init();
  expect(events).toEqual(["open root"]);
  expect(getAppServices<App>(nativeApp)?.shared.closed).toBe(false);
  await nativeApp.close();
  expect(events).toEqual(["open root", "close root"]);

  // Now exercise the createNestApp instance with concurrent requests
  const { events: appEvents, services: appServices } = fixture();
  const concurrentApp = createNestApp({
    services: appServices,
    appBindings: ["shared"],
    bindings: ["local"],
    controllers: [RootController],
  });
  expect(appEvents).toEqual([]);
  await concurrentApp.ready();
  expect(appEvents).toEqual(["open root"]);
  expect(concurrentApp.services.shared.closed).toBe(false);
  const [first, second] = await Promise.all([concurrentApp.inject("/"), concurrentApp.inject("/")]);
  expect(first.statusCode).toBe(200);
  expect(first.json()).not.toEqual(second.json());
  expect(instances.every((instance) => instance.closed)).toBe(true);
  expect(appEvents).toEqual(["open root", "close child", "close child"]);
  await concurrentApp.close();
  await concurrentApp.close();
  expect(appEvents.at(-1)).toBe("close root");
  expect(instances[0]?.shared.closed).toBe(true);
  await app.close();
});

test("plain factories stay uninitialized until selected and explicit overrides are shared", async () => {
  let calls = 0;
  const Value = service("value", {}, () => {
    calls += 1;
    return 1;
  });
  @Controller()
  class ValueController {
    @Get()
    get(@Services() services: { value: number }) {
      return services;
    }
  }
  const app = createNestApp({
    services: createModule().singleton(Value),
    bindings: ["value"],
    controllers: [ValueController],
  });
  await app.ready();
  expect(calls).toBe(0);
  await app.inject("/");
  await app.inject("/");
  expect(calls).toBe(1);
  await app.close();

  const other = createNestApp({
    services: createModule().singleton(Value).override("value", 42),
    bindings: ["value"],
    controllers: [ValueController],
  });
  expect((await other.inject("/")).json()).toEqual({ value: 42 });
  expect(calls).toBe(1);
  await other.close();
});

test("module factories see prior app decorators and locals see authentication before controller", async () => {
  const Tenant = ResultTask.service<string, "tenant">("tenant");
  const Greeting = service("greeting", { tenant: Tenant }, ({ tenant }) => tenant);

  @Controller()
  class GreetingController {
    @Get()
    get(@Services() services: { greeting: string; suffix: string }) {
      expectTypeOf(services.greeting).toEqualTypeOf<string>();
      return services.greeting + services.suffix;
    }
  }

  const app = createNestApp(
    {
      services: async (instance: INestApplicationContext) => {
        const decorated = instance as INestApplicationContext & {
          getDecorator: <T>(name: PropertyKey) => T;
        };
        return createModule()
          .scoped(Greeting)
          .value("suffix", decorated.getDecorator<{ suffix: string }>("settings").suffix);
      },
      bindings: ["greeting", "suffix"],
      locals: async (request: NestRequest) => ({ tenant: request.getDecorator<string>("tenant") }),
      controllers: [GreetingController],
    },
    (instance) => {
      instance.decorate("settings", { suffix: "!" });
      instance.use((req: NestRequest, _res: unknown, next: () => void) => {
        req.setDecorator?.("tenant", "acme");
        (req as unknown as { tenant?: string }).tenant = "acme";
        next();
      });
    },
  );
  // Also ensure setDecorator works before ensureRequestHelpers by testing locals reading header/decorator
  app.use((req: NestRequest, _res: unknown, next: () => void) => {
    req.headers["x-tenant"] = "acme";
    next();
  });
  await app.close();

  const appWithGuard = createNestApp(
    {
      services: async (instance: INestApplicationContext) => {
        const decorated = instance as INestApplicationContext & {
          getDecorator: <T>(name: PropertyKey) => T;
        };
        return createModule()
          .scoped(Greeting)
          .value("suffix", decorated.getDecorator<{ suffix: string }>("settings").suffix);
      },
      bindings: ["greeting", "suffix"],
      locals: async (request: NestRequest) => ({ tenant: request.getDecorator<string>("tenant") }),
      controllers: [GreetingController],
    },
    (instance) => {
      instance.decorate("settings", { suffix: "!" });
      instance.useGlobalGuards({
        canActivate(context) {
          const req = context.switchToHttp().getRequest<NestRequest>();
          req.setDecorator("tenant", "acme");
          return true;
        },
      });
    },
  );
  expect((await appWithGuard.inject("/")).body).toBe("acme!");
  await appWithGuard.close();
});

test("early guard responses skip acquisition and exception filters retain live request resources", async () => {
  const { services, events } = fixture();
  type Request = InferRequestServices<
    ReturnType<typeof createNestModule<{ services: typeof services; bindings: ["local"] }>>
  >;

  @Catch()
  class TestFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
      const ctx = host.switchToHttp();
      const request = ctx.getRequest<NestRequest>();
      const response = ctx.getResponse<{
        status: (code: number) => { send: (body: unknown) => void };
      }>();
      const reqServices = getRequestServices<Request>(request);
      if (reqServices !== undefined) {
        expect(reqServices.local.closed).toBe(false);
        response.status(418).send({ handled: true });
        return;
      }
      const status = exception instanceof BadRequestException ? 401 : 500;
      response.status(status).send({ early: true });
    }
  }

  @Controller()
  class TestController {
    @Get("error")
    fail() {
      throw new Error("route failed");
    }

    @Get("early")
    early() {
      return "unreachable";
    }

    @Delete()
    @HttpCode(204)
    remove(): null {
      return null;
    }
  }

  const app = createNestApp(
    { services, bindings: ["local"], controllers: [TestController] },
    (instance) => {
      instance.useGlobalGuards({
        canActivate(context) {
          const req = context.switchToHttp().getRequest<NestRequest>();
          if (req.url === "/early") throw new BadRequestException("auth");
          return true;
        },
      });
      instance.useGlobalFilters(new TestFilter());
    },
  );

  expect((await app.inject("/early")).statusCode).toBe(401);
  expect(events).toEqual([]);
  expect((await app.inject("/error")).statusCode).toBe(418);
  expect(events).toEqual(["open root", "close child"]);
  expect((await app.inject({ method: "DELETE", url: "/" })).statusCode).toBe(204);
  await app.close();
  expect(events).toEqual(["open root", "close child", "close child", "close root"]);
});

test("rolls back partial startup and rejects scoped application bindings", async () => {
  const { services, events } = fixture();
  const Failing = service("failing", ResultTask.fail("offline"));
  const app = createNestApp({
    services: services.singleton(Failing),
    appBindings: ["shared", "failing"],
    bindings: [],
  });
  await expect(app.ready()).rejects.toThrow();
  expect(events).toEqual(["open root", "close root"]);
  await app.close();

  const other = createNestApp({ services, appBindings: ["local"], bindings: [] });
  await expect(other.ready()).rejects.toThrow();
  await other.close();
});

test("request acquisition failures use the native exception filter and preserve the cause", async () => {
  const Failing = service("failing", ResultTask.fail("offline"));

  @Catch()
  class AcquisitionFilter implements ExceptionFilter {
    catch(error: unknown, host: ArgumentsHost) {
      expect(error).toHaveProperty("cause");
      host
        .switchToHttp()
        .getResponse<{ status: (code: number) => { send: (body: unknown) => void } }>()
        .status(503)
        .send({ unavailable: true });
    }
  }

  @Controller()
  class TestController {
    @Get()
    get() {
      return "unreachable";
    }
  }

  const app = createNestApp(
    {
      services: createModule().scoped(Failing),
      bindings: ["failing"],
      controllers: [TestController],
    },
    (instance) => {
      instance.useGlobalFilters(new AcquisitionFilter());
    },
  );
  expect((await app.inject("/")).statusCode).toBe(503);
  await app.close();
});

test("duplicate module registrations in the same NestJS context fail", async () => {
  const duplicate = createNestApp({ services: createModule(), bindings: [] }, (instance) => {
    instance.decorate("services", {});
  });
  await expect(duplicate.ready()).rejects.toThrow("already registered");
  await duplicate.close();

  const modA = createNestModule({ services: createModule(), bindings: [] });
  const modB = createNestModule({ services: createModule(), bindings: [] });
  @Module({ imports: [modA, modB] })
  class DuplicateAppModule {}
  const nativeDuplicate = await NestFactory.create(DuplicateAppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  await expect(nativeDuplicate.init()).rejects.toThrow("already registered");
  await nativeDuplicate.close();
});

test("streamed replies keep resources alive until consumption finishes", async () => {
  const { services, events } = fixture();
  const release = Promise.withResolvers<void>();

  @Controller()
  class StreamController {
    @Get()
    stream(@Services() reqServices: { local: { closed: boolean } }) {
      const { local } = reqServices;
      return new StreamableFile(
        Readable.from(
          (async function* body() {
            yield "first";
            await release.promise;
            expect(local.closed).toBe(false);
            yield "last";
          })(),
        ),
      );
    }
  }

  const app = createNestApp({
    services,
    appBindings: ["shared"],
    bindings: ["local"],
    controllers: [StreamController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
  const response = await fetch(url, { headers: { connection: "close" } });
  expect(events).toEqual(["open root"]);
  const closing = app.close();
  release.resolve();
  expect(await response.text()).toBe("firstlast");
  await closing;
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("client disconnect releases its request scope exactly once", async () => {
  const { services, events } = fixture();
  const stream = new PassThrough();

  @Controller()
  class DisconnectController {
    @Get()
    stream(@Res() res: { raw: NodeJS.WritableStream }) {
      stream.write("chunk");
      stream.pipe(res.raw);
    }
  }

  const app = createNestApp({
    services,
    appBindings: ["shared"],
    bindings: ["local"],
    controllers: [DisconnectController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
  await new Promise<void>((resolve, reject) => {
    const client = nodeHttpRequest(url, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    client.once("error", reject);
    client.end();
  });
  await expect.poll(() => events.filter((event) => event === "close child").length).toBe(1);
  stream.destroy();
  await app.close();
  expect(events).toEqual(["open root", "close child", "close root"]);
});

test("handlerTimeout aborts request work and releases scoped resources", async () => {
  const { services, events } = fixture();

  @Controller()
  class TimeoutController {
    @Get()
    async slow(@Req() request: NestRequest) {
      const result = await ResultTask.runResult(
        ResultTask.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          catch: (error) => error,
        }),
        { signal: request.signal },
      ).then(undefined, () => {
        /* The timeout response owns interruption. */
      });
      return result ?? "interrupted";
    }
  }

  const app = createNestApp({
    services,
    appBindings: ["shared"],
    bindings: ["local"],
    handlerTimeout: 40,
    controllers: [TimeoutController],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = serverUrl(app.server);
  const response = await fetch(url, { headers: { connection: "close" } });
  expect(response.status).toBe(503);
  await response.text();
  await app.close();
  expect(events).toEqual(["open root", "close child", "close root"]);
});

const typeChecks = () => {
  const services = createModule().value("answer", 42);
  // @ts-expect-error Unknown selected service.
  createNestModule({ services, bindings: ["missing"] });
  const External = ResultTask.service<string, "external">("external");
  const Dependent = service("dependent", { external: External }, ({ external }) => external);
  const module = createModule().scoped(Dependent).merge(services);
  // @ts-expect-error A selected graph must have all external requirements supplied.
  createNestModule({ services: module, bindings: ["dependent"] });
  createNestModule({ services: module, bindings: ["answer"] });
  createNestModule({
    services: module,
    bindings: ["dependent"],
    locals: () => ({ external: "ok" }),
  });
  createNestModule({
    services: module,
    // @ts-expect-error Incompatible local service contract.
    bindings: ["dependent"],
    locals: () => ({ external: 42 }),
  });
  // @ts-expect-error Locals cannot replace registrations.
  createNestModule({ services, bindings: ["answer"], locals: () => ({ answer: 2 }) });
  createNestModule({
    services: module,
    bindings: [],
    // @ts-expect-error Application bindings cannot capture request locals.
    appBindings: ["dependent"],
    locals: () => ({ external: "ok" }),
  });
};
expectTypeOf(typeChecks).toBeFunction();
