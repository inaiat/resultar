import "reflect-metadata";

import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import {
  Catch,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
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

const initialJitEnv = process.env.RESULTAR_JIT;

afterEach(() => {
  if (initialJitEnv === undefined) {
    delete process.env.RESULTAR_JIT;
  } else {
    process.env.RESULTAR_JIT = initialJitEnv;
  }
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

  const disconnectAfterFirstChunk = (url: string, body: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(body, "utf8");
      let firstChunk = "";
      let disconnected = false;
      const client = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(payload.byteLength),
            connection: "close",
          },
        },
        (response) => {
          response.once("data", (chunk: Buffer | string) => {
            firstChunk = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            disconnected = true;
            response.destroy();
            client.destroy();
          });
          response.once("close", () => {
            if (disconnected) resolve(firstChunk);
          });
        },
      );
      client.once("close", () => {
        if (disconnected) resolve(firstChunk);
      });
      client.once("error", (error) => {
        if (!disconnected) reject(error);
      });
      client.end(payload);
    });

  const awaitWithTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> => {
    const handle: { id?: ReturnType<typeof setTimeout> } = {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          handle.id = setTimeout(() => {
            reject(new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${label}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (handle.id !== undefined) clearTimeout(handle.id);
    }
  };

  test.each([
    { mode: "static" as const, jitEnabled: true },
    { mode: "static" as const, jitEnabled: false },
    { mode: "dynamic" as const, jitEnabled: true },
    { mode: "dynamic" as const, jitEnabled: false },
  ])(
    "closes cleanly after streaming client disconnect without releasing singleton early ($mode, jit=$jitEnabled)",
    async ({ mode, jitEnabled }) => {
      await withJitMode(jitEnabled, async () => {
        const events: string[] = [];
        let poolReleases = 0;
        const openStream = new PassThrough();
        const holdStarted = Promise.withResolvers<void>();
        const releaseHold = Promise.withResolvers<void>();
        const streamReplyClosed = Promise.withResolvers<void>();

        const Tenant = ResultTask.service<string, "tenant">("tenant");
        const Pool = resource("pool", {
          acquire: ResultTask.sync(() => {
            events.push("acquire-pool");
            return { ready: true };
          }),
          release: () =>
            ResultTask.sync(() => {
              poolReleases += 1;
              events.push("release-pool");
            }),
        });

        const services = createModule()
          .singleton(Pool)
          .value("tag", "fast")
          .scoped(service("greeting", { tenant: Tenant }, ({ tenant }) => `hi:${tenant}`));

        const expectedVal = mode === "static" ? "fast" : "hi:alpha";

        @Controller()
        class StreamController {
          @Post("/stream")
          @HttpCode(200)
          stream(
            @Services() reqServices: { readonly tag?: string; readonly greeting?: string },
            @Res()
            res: {
              status: (code: number) => void;
              raw: NodeJS.WritableStream & { once: (event: string, listener: () => void) => void };
            },
          ) {
            expect(reqServices.tag ?? reqServices.greeting).toBe(expectedVal);
            res.status(200);
            res.raw.once("close", () => {
              events.push("stream-closed");
              streamReplyClosed.resolve();
            });
            openStream.write("chunk-1\n");
            openStream.pipe(res.raw);
          }

          @Get("/ping")
          ping(@Services() reqServices: { readonly tag?: string; readonly greeting?: string }) {
            return { ok: true, value: reqServices.tag ?? reqServices.greeting };
          }

          @Get("/hold")
          async hold(
            @Services() reqServices: { readonly tag?: string; readonly greeting?: string },
          ) {
            const value = reqServices.tag ?? reqServices.greeting;
            events.push("hold-start");
            holdStarted.resolve();
            await releaseHold.promise;
            events.push("hold-end");
            return { ok: true, value };
          }
        }

        const app =
          mode === "static"
            ? createNestApp({
                services,
                appBindings: ["pool"],
                bindings: ["tag"],
                controllers: [StreamController],
              })
            : createNestApp({
                services,
                appBindings: ["pool"],
                bindings: ["greeting"],
                locals: (request: NestRequest) => ({
                  tenant: request.headers["x-tenant"] === "beta" ? "beta" : "alpha",
                }),
                controllers: [StreamController],
              });

        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address() as AddressInfo;
        const url = `http://127.0.0.1:${String(address.port)}`;

        try {
          const holdFetch = fetch(`${url}/hold`, { headers: { connection: "close" } });
          await holdStarted.promise;

          const pingResponse = await fetch(`${url}/ping`, { headers: { connection: "close" } });
          const pingBody = (await pingResponse.json()) as {
            readonly ok: boolean;
            readonly value: string;
          };
          expect(pingBody).toEqual({ ok: true, value: expectedVal });
          expect(poolReleases).toBe(0);

          const chunk = await disconnectAfterFirstChunk(
            `${url}/stream`,
            JSON.stringify({ uploaded: true }),
          );
          expect(chunk).toBe("chunk-1\n");
          await awaitWithTimeout(streamReplyClosed.promise, 2000, "server reply.raw close");
          expect(poolReleases).toBe(0);

          const closing = app.close();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 30);
          });
          expect(poolReleases).toBe(0);

          releaseHold.resolve();
          const holdResponse = await holdFetch;
          const holdBody = (await holdResponse.json()) as {
            readonly ok: boolean;
            readonly value: string;
          };
          expect(holdBody).toEqual({ ok: true, value: expectedVal });

          await awaitWithTimeout(closing, 2000, "NestJS app.close() after streaming disconnect");
          expect(poolReleases).toBe(1);
          expect(events).toEqual([
            "acquire-pool",
            "hold-start",
            "stream-closed",
            "hold-end",
            "release-pool",
          ]);
        } finally {
          openStream.destroy();
        }
      });
    },
  );

  test("keeps Fastify request.signal lazy on Tier 0 routes while respecting own signal getters on routes without handlerTimeout", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        let signalMaterializedPlain = true;
        let signalMaterializedAfterRead = false;
        const hasFastifySignalSymbol = (request: object): boolean =>
          Object.getOwnPropertySymbols(request).some(
            (symbol) => symbol.description === "fastify.request.signal",
          );

        @Controller()
        class LazySignalController {
          @Get("/plain")
          plain(@Req() request: NestRequest, @Services() reqServices: { readonly tag: string }) {
            signalMaterializedPlain = hasFastifySignalSymbol(request);
            return reqServices.tag;
          }

          @Get("/signal")
          withSignal(
            @Req() request: NestRequest,
            @Services() reqServices: { readonly tag: string },
          ) {
            const isSignal = request.signal instanceof AbortSignal;
            signalMaterializedAfterRead = hasFastifySignalSymbol(request);
            return { tag: reqServices.tag, isSignal };
          }
        }

        const lazyApp = createNestApp({
          services: createModule().value("tag", "ok"),
          bindings: ["tag"],
          controllers: [LazySignalController],
        });

        const plainRes = await lazyApp.inject("/plain");
        expect(plainRes.statusCode).toBe(200);
        expect(plainRes.body).toBe("ok");
        expect(signalMaterializedPlain).toBe(false);

        const signalRes = await lazyApp.inject("/signal");
        expect(signalRes.statusCode).toBe(200);
        expect(signalRes.json()).toEqual({ tag: "ok", isSignal: true });
        expect(signalMaterializedAfterRead).toBe(true);
        await lazyApp.close();

        // A hook installing an own getter for request.signal with an already-aborted signal
        // must abort BEFORE initializing services or invoking the controller even without handlerTimeout.
        let serviceInitialized = 0;
        let controllerCalled = 0;
        const abortReason = new Error("hook-getter-aborted");
        const capturedErrors: unknown[] = [];

        @Catch()
        class AbortCaptureFilter implements ExceptionFilter {
          catch(exception: unknown, host: ArgumentsHost) {
            capturedErrors.push(exception);
            const reply = host
              .switchToHttp()
              .getResponse<{ code: (status: number) => { send: (body: unknown) => void } }>();
            reply.code(500).send({ aborted: true });
          }
        }

        @Controller()
        class AbortedGetterController {
          @Get("/aborted")
          aborted(@Services() reqServices: { readonly item: number }) {
            controllerCalled += 1;
            return { item: reqServices.item };
          }
        }

        const getterApp = createNestApp(
          {
            services: createModule().scoped("item", [], () => {
              serviceInitialized += 1;
              return serviceInitialized;
            }),
            bindings: ["item"],
            controllers: [AbortedGetterController],
          },
          (instance) => {
            instance.useGlobalFilters(new AbortCaptureFilter());
            const fastify = instance.getHttpAdapter().getInstance() as {
              addHook: (
                name: string,
                fn: (req: object, reply: unknown, done: () => void) => void,
              ) => void;
            };
            fastify.addHook("onRequest", (req, _reply, done) => {
              const abortedSignal = AbortSignal.abort(abortReason);
              Object.defineProperty(req, "signal", {
                configurable: true,
                enumerable: true,
                get: () => abortedSignal,
              });
              done();
            });
          },
        );

        const abortedRes = await getterApp.inject("/aborted");
        expect(abortedRes.statusCode).toBe(500);
        expect(serviceInitialized).toBe(0);
        expect(controllerCalled).toBe(0);
        expect(capturedErrors[0]).toBe(abortReason);
        await getterApp.close();
      });
    }
  });

  test("registers the child scope before plan resolution so app.close() from a sync factory waits for the controller", async () => {
    let poolReleased = 0;
    const closeState: { trigger?: () => void; promise?: Promise<void> } = {};
    const handlerEntered = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();
    const Pool = resource("pool", {
      acquire: ResultTask.ok("pool"),
      release: () =>
        ResultTask.sync(() => {
          poolReleased += 1;
        }),
    });
    const services = createModule()
      .singleton(Pool)
      .scoped("trigger", [], () => {
        closeState.trigger?.();
        return "triggered";
      });

    @Controller()
    class ShutdownController {
      @Get("/work")
      async work(@Services() reqServices: { readonly trigger: string }) {
        handlerEntered.resolve();
        await releaseHandler.promise;
        return { trigger: reqServices.trigger };
      }
    }

    const app = createNestApp({
      services,
      appBindings: ["pool"],
      bindings: ["trigger"],
      controllers: [ShutdownController],
    });

    let closed = false;
    closeState.trigger = () => {
      closeState.promise = app.close().then(() => {
        closed = true;
      });
    };

    const pendingResponse = app.inject("/work");
    await handlerEntered.promise;
    expect(closeState.promise).toBeDefined();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    expect(closed).toBe(false);
    expect(poolReleased).toBe(0);

    releaseHandler.resolve();
    const response = await pendingResponse;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ trigger: "triggered" });
    await closeState.promise;
    expect(closed).toBe(true);
    expect(poolReleased).toBe(1);
  });
});
