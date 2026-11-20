import Fastify, { type FastifyRequest } from "fastify";
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

afterEach(() => {
  delete process.env.RESULTAR_JIT;
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
});
