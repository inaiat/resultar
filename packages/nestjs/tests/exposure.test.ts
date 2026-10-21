import { BadRequestException, Controller, Get, Query, type PipeTransform } from "@nestjs/common";
import { ResultTask } from "resultar";
import { createModule, withProvider } from "resultar-di";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  createNestApp,
  createNestModule,
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
});
