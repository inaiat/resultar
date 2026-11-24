import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ResultTask, ResultTaskCauseError } from "resultar";
import { createModule, resource, service } from "resultar-di";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { createFastifyApp, createFastifyPlugin, type InferRequestServices } from "../src/index.js";

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

describe("resultar-fastify Tier 0 / Tier 1 compiled request hooks and dual-mode parity", () => {
  const runParitySuite = (jitEnabled: boolean) =>
    withJitMode(jitEnabled, async () => {
      let singletons = 0;
      let scoped = 0;
      let transients = 0;
      const hostileKey = 'a"]; throw new Error("fastify-injection"); //';

      const Tenant = ResultTask.service<string, "tenant">("tenant");
      const module = createModule()
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

      const staticApp = createFastifyApp(
        { services: module, bindings: ["repo", "left", "right", "nonce", hostileKey] },
        (instance) => {
          instance.get("/", (request) => {
            const services =
              request.getDecorator<InferRequestServices<typeof staticApp>>("services");
            return {
              frozen: Object.isFrozen(services),
              sameScoped: services.left === services.right,
              scopedId: services.left.id,
              repoLabel: services.repo.label,
              nonce: services.nonce,
              hostile: services[hostileKey],
            };
          });
        },
      );

      const firstStaticRes = await staticApp.inject("/");
      const secondStaticRes = await staticApp.inject("/");
      const firstStatic = firstStaticRes.json<Record<string, unknown>>();
      const secondStatic = secondStaticRes.json<Record<string, unknown>>();
      await staticApp.close();

      let useAsyncLocal = false;
      const dynamicApp = createFastifyApp(
        {
          services: module,
          bindings: ["greeting", "nonce"],
          locals: (
            request: FastifyRequest,
          ):
            | { readonly tenant: string; readonly extra?: string }
            | Promise<{ readonly tenant: string; readonly extra?: string }> => {
            const tenant = request.headers["x-tenant"] === "beta" ? "beta" : "alpha";
            if (useAsyncLocal) {
              return Promise.resolve({ tenant, extra: "v2" });
            }
            return { tenant };
          },
        },
        (instance) => {
          instance.get("/", (request) => {
            const { greeting, nonce } =
              request.getDecorator<InferRequestServices<typeof dynamicApp>>("services");
            return { greeting, nonce };
          });
        },
      );

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

      return {
        firstStatic,
        secondStatic,
        syncLocalFirst,
        syncLocalSecond,
        asyncLocalRes,
        singletons,
      };
    });

  test("produces identical behavior in RESULTAR_JIT=1 and RESULTAR_JIT=0 across Tier 0, Tier 1, and dynamic locals", async () => {
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

        const app = createFastifyApp(
          {
            services: createModule().singleton(Pool).value("tag", "fast"),
            appBindings: ["pool"],
            bindings: ["tag"],
          },
          (instance) => {
            instance.get("/slow", async (request) => {
              const { tag } = request.getDecorator<InferRequestServices<typeof app>>("services");
              events.push("handler-start");
              started.resolve();
              await releaseHandler.promise;
              events.push("handler-end");
              return tag;
            });
          },
        );

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

  test("preserves ResultTaskCauseError on sync factory failures and Tier 2 fallback on duplicate locals", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const boom = new Error("sync-factory-boom");
        const failingApp = Fastify();
        await failingApp.register(
          createFastifyPlugin({
            services: createModule().scoped("broken", [], () => {
              throw boom;
            }),
            bindings: ["broken"],
          }),
        );
        let capturedError: unknown = "";
        failingApp.setErrorHandler((error, _request, reply) => {
          capturedError = error;
          return reply.code(500).send({ ok: false });
        });
        failingApp.get("/", () => "unreachable");
        const failingRes = await failingApp.inject("/");
        expect(failingRes.statusCode).toBe(500);
        expect(capturedError).toBeInstanceOf(ResultTaskCauseError);
        await failingApp.close();

        // Duplicate local key must fall back cleanly and reject via error handler
        const duplicateApp = Fastify();
        await duplicateApp.register(
          createFastifyPlugin({
            services: createModule().value("existing", "ok"),
            bindings: ["existing"],
            locals: (() => ({ existing: "conflict" })) as unknown as () => {
              readonly other: string;
            },
          }),
        );
        let duplicateError: unknown = "";
        duplicateApp.setErrorHandler((error, _request, reply) => {
          duplicateError = error;
          return reply.code(500).send({ conflict: true });
        });
        duplicateApp.get("/", () => "unreachable");
        const dupRes = await duplicateApp.inject("/");
        expect(dupRes.statusCode).toBe(500);
        expect(duplicateError).toBeInstanceOf(ResultTaskCauseError);
        await duplicateApp.close();
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
            if (disconnected) {
              resolve(firstChunk);
            }
          });
        },
      );
      client.once("close", () => {
        if (disconnected) {
          resolve(firstChunk);
        }
      });
      client.once("error", (error) => {
        if (!disconnected) {
          reject(error);
        }
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
      if (handle.id !== undefined) {
        clearTimeout(handle.id);
      }
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
        const expectedValue = mode === "static" ? "fast" : "hi:alpha";
        let poolReleases = 0;
        let requestComplete = false;
        let requestAborted = true;
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

        const configureRoutes = (
          instance: FastifyInstance,
          readValue: (request: FastifyRequest) => string,
        ): void => {
          instance.post("/stream", (request, reply) => {
            expect(readValue(request)).toBe(expectedValue);
            requestComplete = request.raw.complete;
            requestAborted = request.raw.destroyed && !request.raw.complete;
            reply.raw.once("close", () => {
              events.push("stream-closed");
              streamReplyClosed.resolve();
            });
            openStream.write("chunk-1\n");
            return reply.type("text/plain").send(openStream);
          });
          instance.get("/ping", (request) => ({ ok: true, value: readValue(request) }));
          instance.get("/hold", async (request) => {
            const value = readValue(request);
            events.push("hold-start");
            holdStarted.resolve();
            await releaseHold.promise;
            events.push("hold-end");
            return { ok: true, value };
          });
        };

        const app =
          mode === "static"
            ? createFastifyApp(
                { services, appBindings: ["pool"], bindings: ["tag"] },
                (instance) => {
                  configureRoutes(
                    instance,
                    (request) => request.getDecorator<{ readonly tag: string }>("services").tag,
                  );
                },
              )
            : createFastifyApp(
                {
                  services,
                  appBindings: ["pool"],
                  bindings: ["greeting"],
                  locals: (request: FastifyRequest) => ({
                    tenant: request.headers["x-tenant"] === "beta" ? "beta" : "alpha",
                  }),
                },
                (instance) => {
                  configureRoutes(
                    instance,
                    (request) =>
                      request.getDecorator<{ readonly greeting: string }>("services").greeting,
                  );
                },
              );

        const url = await app.listen({ port: 0, host: "127.0.0.1" });
        try {
          const holdFetch = fetch(`${url}/hold`, { headers: { connection: "close" } });
          await holdStarted.promise;

          const pingResponse = await fetch(`${url}/ping`, { headers: { connection: "close" } });
          const pingBody = (await pingResponse.json()) as {
            readonly ok: boolean;
            readonly value: string;
          };
          expect(pingBody).toEqual({ ok: true, value: mode === "static" ? "fast" : "hi:alpha" });
          expect(poolReleases).toBe(0);

          const chunk = await disconnectAfterFirstChunk(
            `${url}/stream`,
            JSON.stringify({ uploaded: true }),
          );
          expect(chunk).toBe("chunk-1\n");
          await awaitWithTimeout(streamReplyClosed.promise, 2000, "server reply.raw close");
          expect(requestComplete).toBe(true);
          expect(requestAborted).toBe(false);
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
          expect(holdBody).toEqual({ ok: true, value: mode === "static" ? "fast" : "hi:alpha" });

          await awaitWithTimeout(closing, 2000, "app.close() after streaming disconnect");
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

  test("does not eagerly materialize request.signal on Tier 0/1 POST or GET requests", async () => {
    const Tenant = ResultTask.service<string, "tenant">("tenant");
    const services = createModule()
      .value("tag", "fast")
      .scoped(service("greeting", { tenant: Tenant }, ({ tenant }) => `hi:${tenant}`));

    let closeListenerNamesInHandler: string[] = [];
    let closeListenerNamesAfterSignalRead: string[] = [];

    const app = createFastifyApp(
      {
        services,
        bindings: ["greeting"],
        locals: (request: FastifyRequest) => ({
          tenant: String(request.headers["x-tenant"] ?? "alpha"),
        }),
      },
      (instance) => {
        instance.post("/items", (request) => {
          closeListenerNamesInHandler = request.raw
            .listeners("close")
            .map((listener) => (listener as { readonly name?: string }).name ?? "");
          expect(request.signal.aborted).toBe(false);
          closeListenerNamesAfterSignalRead = request.raw
            .listeners("close")
            .map((listener) => (listener as { readonly name?: string }).name ?? "");
          const { greeting } = request.getDecorator<InferRequestServices<typeof app>>("services");
          return { greeting, body: request.body };
        });
      },
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/items",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        greeting: "hi:alpha",
        body: { url: "https://example.com" },
      });
      // Reading request.signal lazily registers Fastify's onAbort listener on request.raw.
      expect(closeListenerNamesInHandler).not.toContain("onAbort");
      expect(closeListenerNamesAfterSignalRead).toContain("onAbort");
    } finally {
      await app.close();
    }
  });

  test.each([true, false])(
    "does not initialize request services after Fastify handlerTimeout responds 503 during async locals (jit=%s)",
    async (jitEnabled) => {
      await withJitMode(jitEnabled, async () => {
        let initialized = 0;
        const releaseLocals = Promise.withResolvers<void>();
        const Tenant = ResultTask.service<string, "tenant">("tenant");
        const services = createModule().scoped(
          service("greeting", { tenant: Tenant }, ({ tenant }) => {
            initialized += 1;
            return `hi:${tenant}`;
          }),
        );

        const app = createFastifyApp(
          {
            services,
            bindings: ["greeting"],
            locals: async () => {
              await releaseLocals.promise;
              return { tenant: "late" };
            },
          },
          (instance) => {
            instance.get("/slow", { handlerTimeout: 20 }, (request) => ({
              greeting: request.getDecorator<InferRequestServices<typeof app>>("services").greeting,
            }));
          },
        );

        try {
          const response = await app.inject("/slow");
          expect(response.statusCode).toBe(503);
          expect(initialized).toBe(0);

          releaseLocals.resolve();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          });
          expect(initialized).toBe(0);
        } finally {
          releaseLocals.resolve();
          await app.close();
        }
      });
    },
  );
});
