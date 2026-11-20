import { ResultTask } from "resultar";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { createModule, service } from "../src/index.js";

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

describe("resultar-di static subgraph JIT tiers and dual-mode parity", () => {
  const runTierSuite = (jitEnabled: boolean) =>
    withJitMode(jitEnabled, async () => {
      let singletonCreations = 0;
      let scopedCreations = 0;
      let transientCreations = 0;

      const ConfigService = service("configSvc", {}, () => ({ env: "prod" }));
      const module = createModule()
        .value("prefix", "api")
        .singleton(ConfigService)
        .singleton("repo", ["prefix", "configSvc"], ({ prefix, configSvc }) => {
          singletonCreations += 1;
          return { label: `${prefix}:${configSvc.env}:${String(singletonCreations)}` };
        })
        .scoped("requestCtx", ["repo"], ({ repo }) => {
          scopedCreations += 1;
          return { id: scopedCreations, repoLabel: repo.label };
        })
        .scoped("left", ["requestCtx"], ({ requestCtx }) => requestCtx)
        .scoped("right", ["requestCtx"], ({ requestCtx }) => requestCtx)
        .transient("nonce", [], () => {
          transientCreations += 1;
          return transientCreations;
        });

      const root = module.scope();

      // Tier 0: pure singleton/value fetch
      const handleTier0 = root.fetch(["repo"], ({ repo }) => new Response(repo.label));
      const tier0First = await handleTier0(new Request("https://example.test/t0"));
      const tier0Second = await handleTier0(new Request("https://example.test/t0"));

      // Tier 0 via scopedUse
      const scopedUseLabel = await ResultTask.runPromise(
        root.use(["repo"], ({ repo }) => ResultTask.ok(repo.label)),
      );

      // Tier 1: scoped diamond + transient + locals
      const withLocals = root.withServices({ traceId: "trace-42" });
      const handleTier1 = withLocals.fetch(
        ["left", "right", "nonce", "traceId"],
        ({ left, right, nonce, traceId }) =>
          Response.json({
            sameScoped: left === right,
            scopedId: left.id,
            repoLabel: left.repoLabel,
            nonce,
            traceId,
          }),
      );
      const tier1Response = await handleTier1(new Request("https://example.test/t1"));

      const handleTier1Second = withLocals.fetch(
        ["left", "nonce"],
        ({ left, nonce }) => new Response(`${String(left.id)}:${String(nonce)}`),
      );
      const tier1Second = await handleTier1Second(new Request("https://example.test/t1"));

      await ResultTask.runPromise(root.close());

      return {
        tier0First: await tier0First.text(),
        tier0Second: await tier0Second.text(),
        scopedUseLabel,
        tier1: (await tier1Response.json()) as Record<string, unknown>,
        tier1Second: await tier1Second.text(),
        singletonCreations,
        scopedCreations,
        transientCreations,
      };
    });

  test("produces identical behavior in RESULTAR_JIT=1 and RESULTAR_JIT=0 across Tier 0 and Tier 1", async () => {
    const jit = await runTierSuite(true);
    const fallback = await runTierSuite(false);

    expect(jit).toEqual(fallback);
    expect(jit.tier0First).toBe("api:prod:1");
    expect(jit.tier0Second).toBe("api:prod:1");
    expect(jit.scopedUseLabel).toBe("api:prod:1");
    expect(jit.tier1).toEqual({
      sameScoped: true,
      scopedId: 1,
      repoLabel: "api:prod:1",
      nonce: 1,
      traceId: "trace-42",
    });
    expect(jit.tier1Second).toBe("2:2");
    expect(jit.singletonCreations).toBe(1);
  });

  test("waits for in-flight Tier 0/1 fetch handlers before root.close() releases singletons", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const events: string[] = [];
        const gate = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const root = createModule()
          .resource("pool", [], {
            lifetime: "singleton",
            acquire: () =>
              ResultTask.sync(() => {
                events.push("acquire-pool");
                return { ok: true };
              }),
            release: () =>
              ResultTask.sync(() => {
                events.push("release-pool");
              }),
          })
          .value("tag", "fast")
          .scope();

        await ResultTask.runPromise(root.use(["pool"], () => ResultTask.ok(undefined)));

        const handleSlow = root.fetch(["tag"], async ({ tag }) => {
          events.push("handler-start");
          started.resolve();
          await gate.promise;
          events.push("handler-end");
          return new Response(tag);
        });
        const pending = handleSlow(new Request("https://example.test/slow"));

        await started.promise;
        const closing = ResultTask.runPromise(root.close());
        await Promise.resolve();
        expect(events).toEqual(["acquire-pool", "handler-start"]);

        gate.resolve();
        const response = await pending;
        await closing;
        expect(await response.text()).toBe("fast");
        expect(events).toEqual(["acquire-pool", "handler-start", "handler-end", "release-pool"]);
      });
    }
  });

  test("preserves request abort, handler error wrapping, and hostile service key safety", async () => {
    const hostileKey = 'a"]; throw new Error("di-injection"); //';

    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const root = createModule()
          .value(hostileKey, "safe-value")
          .scoped("derived", [hostileKey], (deps) => `derived:${deps[hostileKey]}`)
          .scope();

        const handleHostile = root.fetch(
          [hostileKey, "derived"],
          (deps) => new Response(`${deps[hostileKey]}|${deps.derived}`),
        );
        const okResponse = await handleHostile(new Request("https://example.test/hostile"));
        expect(await okResponse.text()).toBe("safe-value|derived:safe-value");

        const controller = new AbortController();
        controller.abort(new Error("client-gone"));
        const handleAborted = root.fetch([hostileKey], () => new Response("unreachable"));
        await expect(
          handleAborted(new Request("https://example.test/aborted", { signal: controller.signal })),
        ).rejects.toThrow("Request scope failed");

        const handleCrash = root.fetch([hostileKey], () => {
          throw new Error("handler-crash");
        });
        await expect(handleCrash(new Request("https://example.test/boom"))).rejects.toThrow(
          "Request scope failed",
        );

        await ResultTask.runPromise(root.close());
      });
    }
  });

  test("falls back cleanly to Tier 2 for streaming responses and request-scoped resources", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const events: string[] = [];
        const root = createModule()
          .resource("tx", [], {
            acquire: () =>
              ResultTask.sync(() => {
                events.push("acquire-tx");
                return { id: 1 };
              }),
            release: () =>
              ResultTask.sync(() => {
                events.push("release-tx");
              }),
          })
          .scope();

        const handleStream = root.fetch(
          ["tx"],
          ({ tx }) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  events.push(`stream-chunk-${String(tx.id)}`);
                  controller.enqueue(new TextEncoder().encode("ok"));
                  controller.close();
                },
              }),
            ),
        );
        const response = await handleStream(new Request("https://example.test/stream"));

        expect(await response.text()).toBe("ok");
        await ResultTask.runPromise(root.close());
        expect(events).toEqual(["acquire-tx", "stream-chunk-1", "release-tx"]);
      });
    }
  });
});
