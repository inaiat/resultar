import "reflect-metadata";

import {
  Catch,
  Controller,
  Get,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ResultTask, ResultTaskCauseError } from "resultar";
import { createModule, resource, service } from "resultar-di";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { createNestApp, Services, type NestRequest } from "../src/index.js";

const withJitMode = async <T>(enabled: boolean, run: () => Promise<T>): Promise<T> => {
  const previous = process.env.RESULTAR_JIT;
  process.env.RESULTAR_JIT = enabled ? "1" : "0";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.RESULTAR_JIT;
    } else {
      process.env.RESULTAR_JIT = previous;
    }
  }
};

afterEach(() => {
  delete process.env.RESULTAR_JIT;
});

describe("resultar-nestjs Tier 0 / Tier 1 compiled request dispatcher and dual-mode parity", () => {
  const runParitySuite = (jitEnabled: boolean) =>
    withJitMode(jitEnabled, async () => {
      let singletons = 0;
      let scoped = 0;
      let transients = 0;
      const hostileKey = 'a"]; throw new Error("nestjs-injection"); //';

      const Tenant = ResultTask.service<string, "tenant">("tenant");
      const services = createModule()
        .value(hostileKey, "safe")
        .singleton("repo", [hostileKey], (deps) => {
          singletons += 1;
          return { label: `${deps[hostileKey]}:${String(singletons)}` };
        })
        .scoped("ctx", ["repo"], ({ repo }) => {
          scoped += 1;
          return { id: scoped, repoLabel: repo.label };
        })
        .scoped("left", ["ctx"], ({ ctx }) => ctx)
        .scoped("right", ["ctx"], ({ ctx }) => ctx)
        .transient("nonce", [], () => {
          transients += 1;
          return transients;
        })
        .scoped(service("greeting", { tenant: Tenant }, ({ tenant }) => `hi:${tenant}`));

      @Controller()
      class StaticController {
        @Get("/")
        get(
          @Services()
          reqServices: {
            readonly repo: { readonly label: string };
            readonly left: { readonly id: number; readonly repoLabel: string };
            readonly right: { readonly id: number; readonly repoLabel: string };
            readonly nonce: number;
            readonly [key: string]: unknown;
          },
        ) {
          return {
            frozen: Object.isFrozen(reqServices),
            sameScoped: reqServices.left === reqServices.right,
            scopedId: reqServices.left.id,
            repoLabel: reqServices.repo.label,
            nonce: reqServices.nonce,
            hostile: reqServices[hostileKey],
          };
        }
      }

      const staticApp = createNestApp({
        services,
        bindings: ["repo", "left", "right", "nonce", hostileKey],
        controllers: [StaticController],
      });

      const firstStaticRes = await staticApp.inject("/");
      const secondStaticRes = await staticApp.inject("/");
      const firstStatic = firstStaticRes.json<Record<string, unknown>>();
      const secondStatic = secondStaticRes.json<Record<string, unknown>>();
      await staticApp.close();

      @Controller()
      class DynamicController {
        @Get("/")
        get(@Services() reqServices: { readonly greeting: string; readonly nonce: number }) {
          return { greeting: reqServices.greeting, nonce: reqServices.nonce };
        }
      }

      let useAsyncLocal = false;
      const dynamicApp = createNestApp({
        services,
        bindings: ["greeting", "nonce"],
        locals: (
          request: NestRequest,
        ):
          | { readonly tenant: string; readonly extra?: string }
          | Promise<{ readonly tenant: string; readonly extra?: string }> => {
          const tenant = request.headers["x-tenant"] === "beta" ? "beta" : "alpha";
          if (useAsyncLocal) {
            return Promise.resolve({ tenant, extra: "v2" });
          }
          return { tenant };
        },
        controllers: [DynamicController],
      });

      const syncLocalFirstRes = await dynamicApp.inject("/");
      const syncLocalSecondRes = await dynamicApp.inject({
        url: "/",
        headers: { "x-tenant": "beta" },
      });
      useAsyncLocal = true;
      const asyncLocalResRaw = await dynamicApp.inject("/");
      const syncLocalFirst = syncLocalFirstRes.json<Record<string, unknown>>();
      const syncLocalSecond = syncLocalSecondRes.json<Record<string, unknown>>();
      const asyncLocalRes = asyncLocalResRaw.json<Record<string, unknown>>();
      await dynamicApp.close();

      let guardAsync = false;
      const guardApp = createNestApp({
        services,
        bindings: ["greeting", "nonce"],
        requestHook: "guard",
        locals: (request: NestRequest) => {
          const tenant = request.headers["x-tenant"] === "gamma" ? "gamma" : "alpha";
          return guardAsync ? Promise.resolve({ tenant }) : { tenant };
        },
        controllers: [DynamicController],
      });

      const guardSyncRes = await guardApp.inject("/");
      guardAsync = true;
      const guardAsyncRes = await guardApp.inject({ url: "/", headers: { "x-tenant": "gamma" } });
      const guardSync = guardSyncRes.json<Record<string, unknown>>();
      const guardAsyncBody = guardAsyncRes.json<Record<string, unknown>>();
      await guardApp.close();

      return {
        firstStatic,
        secondStatic,
        syncLocalFirst,
        syncLocalSecond,
        asyncLocalRes,
        guardSync,
        guardAsyncBody,
        singletons,
      };
    });

  test("produces identical behavior in RESULTAR_JIT=1 and RESULTAR_JIT=0 across interceptor, guard, Tier 0/1, and locals", async () => {
    const jit = await runParitySuite(true);
    const fallback = await runParitySuite(false);

    expect(jit).toEqual(fallback);
    expect(jit.firstStatic).toEqual({
      frozen: true,
      sameScoped: true,
      scopedId: 1,
      repoLabel: "safe:1",
      nonce: 1,
      hostile: "safe",
    });
    expect(jit.secondStatic).toEqual({
      frozen: true,
      sameScoped: true,
      scopedId: 2,
      repoLabel: "safe:1",
      nonce: 2,
      hostile: "safe",
    });
    expect(jit.syncLocalFirst).toEqual({ greeting: "hi:alpha", nonce: 3 });
    expect(jit.syncLocalSecond).toEqual({ greeting: "hi:beta", nonce: 4 });
    expect(jit.asyncLocalRes).toEqual({ greeting: "hi:alpha", nonce: 5 });
    expect(jit.guardSync).toEqual({ greeting: "hi:alpha", nonce: 6 });
    expect(jit.guardAsyncBody).toEqual({ greeting: "hi:gamma", nonce: 7 });
    expect(jit.singletons).toBe(1);
  });

  test("waits for in-flight Tier 0/1 route handlers before app.close() releases singleton resources", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const events: string[] = [];
        const started = Promise.withResolvers<void>();
        const releaseHandler = Promise.withResolvers<void>();

        const Pool = resource("pool", {
          acquire: ResultTask.sync(() => {
            events.push("acquire-pool");
            return { ready: true };
          }),
          release: () =>
            ResultTask.sync(() => {
              events.push("release-pool");
            }),
        });

        @Controller()
        class SlowController {
          @Get("/slow")
          async slow(@Services() reqServices: { readonly tag: string }) {
            events.push("handler-start");
            started.resolve();
            await releaseHandler.promise;
            events.push("handler-end");
            return reqServices.tag;
          }
        }

        const app = createNestApp({
          services: createModule().singleton(Pool).value("tag", "fast"),
          appBindings: ["pool"],
          bindings: ["tag"],
          controllers: [SlowController],
        });

        await app.ready();
        const pending = app.inject("/slow");
        await started.promise;

        const closing = app.close();
        await Promise.resolve();
        expect(events).toEqual(["acquire-pool", "handler-start"]);

        releaseHandler.resolve();
        const response = await pending;
        await closing;
        expect(response.body).toBe("fast");
        expect(events).toEqual(["acquire-pool", "handler-start", "handler-end", "release-pool"]);
      });
    }
  });

  test("preserves ResultTaskCauseError on sync factory failures, duplicate locals fallback, and signal aborts", async () => {
    const captureFilter = (captured: unknown[]): ExceptionFilter => {
      @Catch()
      class CaptureFilter implements ExceptionFilter {
        catch(exception: unknown, host: ArgumentsHost) {
          captured.push(exception);
          const reply = host
            .switchToHttp()
            .getResponse<{
              code?: (status: number) => { send: (body: unknown) => void };
              status?: (status: number) => { send: (body: unknown) => void };
            }>();
          const responder = reply.code ? reply.code(500) : reply.status?.(500);
          responder?.send({ ok: false });
        }
      }
      return new CaptureFilter();
    };

    @Controller()
    class UnreachableController {
      @Get("/")
      get(@Services() reqServices: { readonly value?: string }) {
        return reqServices.value ?? "ok";
      }
    }

    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const boom = new Error("sync-factory-boom");
        const factoryErrors: unknown[] = [];
        const failingApp = createNestApp(
          {
            services: createModule().scoped("broken", [], () => {
              throw boom;
            }),
            bindings: ["broken"],
            controllers: [UnreachableController],
          },
          (instance) => {
            instance.useGlobalFilters(captureFilter(factoryErrors));
          },
        );
        const failingRes = await failingApp.inject("/");
        expect(failingRes.statusCode).toBe(500);
        expect(factoryErrors[0]).toBeInstanceOf(ResultTaskCauseError);
        await failingApp.close();

        // Duplicate local key must fall back cleanly to Tier 2 and reject
        const duplicateErrors: unknown[] = [];
        const duplicateApp = createNestApp(
          {
            services: createModule().value("existing", "ok"),
            bindings: ["existing"],
            locals: (() => ({ existing: "conflict" })) as unknown as () => {
              readonly other: string;
            },
            controllers: [UnreachableController],
          },
          (instance) => {
            instance.useGlobalFilters(captureFilter(duplicateErrors));
          },
        );
        const dupRes = await duplicateApp.inject("/");
        expect(dupRes.statusCode).toBe(500);
        expect(duplicateErrors[0]).toBeInstanceOf(ResultTaskCauseError);
        await duplicateApp.close();

        // Pre-aborted signal with custom reason rejects before controller execution
        const abortErrors: unknown[] = [];
        let controllerReached = false;
        @Controller()
        class AbortCheckController {
          @Get("/")
          get(@Services() reqServices: { readonly value: string }) {
            controllerReached = true;
            return reqServices.value;
          }

          @Post("/benign")
          post(@Services() reqServices: { readonly value: string }) {
            controllerReached = true;
            return reqServices.value;
          }
        }
        const abortApp = createNestApp(
          {
            services: createModule().value("value", "ok"),
            bindings: ["value"],
            controllers: [AbortCheckController],
          },
          (instance) => {
            instance.useGlobalFilters(captureFilter(abortErrors));
            instance.useGlobalGuards({
              canActivate(context) {
                const req = context
                  .switchToHttp()
                  .getRequest<{ readonly url?: string; readonly raw?: { complete: boolean } }>();
                if (req.url === "/benign" && req.raw !== undefined) {
                  req.raw.complete = true;
                }
                return true;
              },
            });
          },
        );
        const customAbort = new AbortController();
        const abortReason = new Error("client-cancelled");
        customAbort.abort(abortReason);
        const abortRes = await abortApp.inject({ url: "/", signal: customAbort.signal });
        expect(abortRes.statusCode).toBe(500);
        expect(controllerReached).toBe(false);
        expect(abortErrors[0]).toBe(abortReason);

        // Benign Fastify body-close AbortError after body upload completes does NOT reject
        const benignAbort = new AbortController();
        benignAbort.abort(new DOMException("This operation was aborted", "AbortError"));
        const benignRes = await abortApp.inject({
          method: "POST",
          url: "/benign",
          payload: { ok: true },
          signal: benignAbort.signal,
        });
        expect(benignRes.statusCode).toBe(201);
        expect(benignRes.body).toBe("ok");
        expect(controllerReached).toBe(true);
        await abortApp.close();

        // Sync throw and async rejection in locals() both forward to the exception filter
        const localErrors: unknown[] = [];
        const syncLocalBoom = new Error("sync-locals-boom");
        const asyncLocalBoom = new Error("async-locals-boom");
        let asyncLocalFail = false;
        const localsFailApp = createNestApp(
          {
            services: createModule().value("value", "ok"),
            bindings: ["value"],
            locals: () => {
              if (asyncLocalFail) {
                return Promise.reject(asyncLocalBoom);
              }
              throw syncLocalBoom;
            },
            controllers: [UnreachableController],
          },
          (instance) => {
            instance.useGlobalFilters(captureFilter(localErrors));
          },
        );
        const syncLocalErrRes = await localsFailApp.inject("/");
        expect(syncLocalErrRes.statusCode).toBe(500);
        expect(localErrors[0]).toBe(syncLocalBoom);
        asyncLocalFail = true;
        const asyncLocalErrRes = await localsFailApp.inject("/");
        expect(asyncLocalErrRes.statusCode).toBe(500);
        expect(localErrors[1]).toBe(asyncLocalBoom);
        await localsFailApp.close();
      });
    }
  });
});
