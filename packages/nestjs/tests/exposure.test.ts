import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  Query,
  type PipeTransform,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ResultTask } from "resultar";
import { createModule, withProvider } from "resultar-di";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  APP_SERVICES,
  createNestApp,
  createNestModule,
  FastifyAdapter,
  getAppServices,
  getRequestServices,
  type NestRequest,
  type NestServicesOptions,
  type InferAppServices,
  type InferRequestServices,
} from "../src/index.js";

describe("framework service exposure", () => {
  it("exposes lazy services in guard hook and releases them even when validation pipe rejects", async () => {
    let opened = 0;
    let closed = 0;
    const module = withProvider(createModule(), "connection", {
      lifetime: "scoped",
      create: () => {
        opened += 1;
        return opened;
      },
      release: () =>
        ResultTask.sync(() => {
          closed += 1;
        }),
    });
    const options = {
      services: module,
      bindings: [] as const,
      requestHook: "guard",
      exposeApplication: () => ({ health: "ready" }),
      exposeRequest: (access) => ({ connection: () => access.get("connection").unwrapOrThrow() }),
    } satisfies NestServicesOptions;
    const nestModule = createNestModule(options);
    expectTypeOf<InferAppServices<typeof nestModule>>().toEqualTypeOf<{ health: string }>();
    expectTypeOf<InferRequestServices<typeof nestModule>>().toEqualTypeOf<{
      connection: () => unknown;
    }>();

    const requireIdPipe: PipeTransform = {
      transform(value: unknown) {
        if (typeof value !== "string" || value.length === 0) {
          throw new BadRequestException("Missing id");
        }
        return value;
      },
    };

    @Controller()
    class ValidatedController {
      @Get()
      get(@Query("id", requireIdPipe) _id: string) {
        return "ok";
      }
    }

    const app = createNestApp({ ...options, controllers: [ValidatedController] }, (instance) => {
      instance.useGlobalGuards({
        canActivate(context) {
          const req = context.switchToHttp().getRequest<NestRequest>();
          const services = getRequestServices<InferRequestServices<typeof nestModule>>(req);
          expect(services?.connection()).toBe(opened);
          expect(services?.connection()).toBe(opened);
          return true;
        },
      });
    });
    expect(opened).toBe(0);
    const invalid = await app.inject("/");
    expect(invalid.statusCode).toBe(400);
    expect([opened, closed]).toEqual([1, 1]);
    const valid = await app.inject("/?id=1");
    expect(valid.statusCode).toBe(200);
    expect([opened, closed]).toEqual([2, 2]);
    await app.close();
    expect(closed).toBe(2);
  });

  it("preserves prototype methods, getters, and instanceof on @Inject(APP_SERVICES) when exposeApplication returns a class instance", async () => {
    class AppServicesFacade {
      readonly prefix: string;
      constructor(prefix: string) {
        this.prefix = prefix;
      }

      get upper(): string {
        return this.prefix.toUpperCase();
      }

      format(name: string): string {
        return `${this.prefix}:${name}`;
      }
    }

    @Controller()
    class FacadeController {
      readonly #facade: AppServicesFacade;
      constructor(@Inject(APP_SERVICES) facade: AppServicesFacade) {
        this.#facade = facade;
      }

      @Get()
      get() {
        return {
          isInstance: this.#facade instanceof AppServicesFacade,
          upper: this.#facade.upper,
          formatted: this.#facade.format("users"),
        };
      }
    }

    const app = createNestApp({
      services: createModule().value("prefix", "api"),
      appBindings: ["prefix"],
      bindings: [],
      exposeApplication: (access) =>
        new AppServicesFacade(access.get("prefix").unwrapOrThrow() as string),
      controllers: [FacadeController],
    });
    const response = await app.inject("/");
    expect(response.json()).toEqual({ isInstance: true, upper: "API", formatted: "api:users" });
    expect(app.services).toBeInstanceOf(AppServicesFacade);
    expect(app.get(APP_SERVICES)).toBeInstanceOf(AppServicesFacade);
    await app.close();

    // Also verify standalone createNestModule + NestFactory.create
    const nestModule = createNestModule({
      services: createModule().value("prefix", "mod"),
      appBindings: ["prefix"],
      bindings: [],
      exposeApplication: (access) =>
        new AppServicesFacade(access.get("prefix").unwrapOrThrow() as string),
    });
    @Module({ imports: [nestModule], controllers: [FacadeController] })
    class StandaloneModule {}
    const nativeApp = await NestFactory.create(StandaloneModule, new FastifyAdapter(), {
      logger: false,
    });
    await nativeApp.init();
    const resolved = getAppServices<AppServicesFacade>(nativeApp);
    expect(resolved).toBeInstanceOf(AppServicesFacade);
    expect(resolved?.upper).toBe("MOD");
    expect(resolved?.format("items")).toBe("mod:items");
    await nativeApp.close();
  });
});
