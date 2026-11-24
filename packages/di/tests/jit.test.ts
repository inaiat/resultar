import { ResultTask } from "resultar";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createModule, service } from "../src/index.js";

const initialJitEnv = process.env.RESULTAR_JIT;

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
  if (initialJitEnv === undefined) {
    delete process.env.RESULTAR_JIT;
  } else {
    process.env.RESULTAR_JIT = initialJitEnv;
  }
});

describe("resultar-di static subgraph JIT tiers and dual-mode parity", () => {
  test.each([true, false])("preserves fetch failure causes with JIT %s", async (enabled) => {
    await withJitMode(enabled, async () => {
      const defect = new TypeError("factory");
      const scope = createModule()
        .value("value", 1)
        .scoped("broken", [], () => {
          throw defect;
        })
        .scope();
      const request = new Request("https://example.test");
      const execute = scope.fetch(["value"], () => Promise.reject(defect));
      await expect(execute(request)).rejects.toMatchObject({
        cause: { _tag: "Fail", error: defect },
      });
      await expect(scope.fetch(["broken"], () => new Response())(request)).rejects.toMatchObject({
        cause: { _tag: "Die", defect },
      });
      await scope.close().runPromise();
      await expect(execute(request)).rejects.toMatchObject({ cause: { _tag: "Die" } });
    });
  });

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

      const tier0FirstText = await tier0First.text();
      const tier0SecondText = await tier0Second.text();
      const tier1Json = (await tier1Response.json()) as Record<string, unknown>;
      const tier1SecondText = await tier1Second.text();

      await ResultTask.runPromise(root.close());

      return {
        tier0First: tier0FirstText,
        tier0Second: tier0SecondText,
        scopedUseLabel,
        tier1: tier1Json,
        tier1Second: tier1SecondText,
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
        expect(await response.text()).toBe("fast");
        await closing;
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

  test("does not collide plan cache keys when service names contain NUL or control delimiters", async () => {
    const joinedKey = "a\0b";
    const ctrlKey = "a\u0001b";
    const readJson = async (
      handler: (req: Request) => Response | Promise<Response>,
      path: string,
    ): Promise<Record<string, unknown>> => {
      const response = await handler(new Request(`https://example.test${path}`));
      return (await response.json()) as Record<string, unknown>;
    };

    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const makeMod = () =>
          createModule()
            .value("a", "val-a")
            .value("b", "val-b")
            .value(joinedKey, "val-joined")
            .value(ctrlKey, "val-ctrl");

        // Order 1: ["a", "b"] then ["a\0b"], plus locals boundary check
        const scopeForward = makeMod().scope();
        const fetchAB = scopeForward.fetch(["a", "b"], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );
        const fetchJoined = scopeForward.fetch([joinedKey], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );
        const fetchCtrl = scopeForward.fetch([ctrlKey], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );
        const withLocalB = scopeForward.withServices({ localKey: "loc-val" });
        const fetchWithLocal = withLocalB.fetch(["a", "localKey"], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );

        expect(await readJson(fetchAB, "/ab")).toEqual({
          keys: ["a", "b"],
          values: { a: "val-a", b: "val-b" },
        });
        expect(await readJson(fetchJoined, "/joined")).toEqual({
          keys: [joinedKey],
          values: { [joinedKey]: "val-joined" },
        });
        expect(await readJson(fetchCtrl, "/ctrl")).toEqual({
          keys: [ctrlKey],
          values: { [ctrlKey]: "val-ctrl" },
        });
        expect(await readJson(fetchWithLocal, "/local")).toEqual({
          keys: ["a", "localKey"],
          values: { a: "val-a", localKey: "loc-val" },
        });
        await ResultTask.runPromise(scopeForward.close());

        // Order 2 (reverse): ["a\0b"] first, then ["a", "b"] on the same scope
        const scopeReverse = makeMod().scope();
        const revJoined = scopeReverse.fetch([joinedKey], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );
        const revAB = scopeReverse.fetch(["a", "b"], (services) =>
          Response.json({ keys: Object.keys(services), values: services }),
        );

        expect(await readJson(revJoined, "/rev-joined")).toEqual({
          keys: [joinedKey],
          values: { [joinedKey]: "val-joined" },
        });
        expect(await readJson(revAB, "/rev-ab")).toEqual({
          keys: ["a", "b"],
          values: { a: "val-a", b: "val-b" },
        });
        await ResultTask.runPromise(scopeReverse.close());
      });
    }
  });

  test("propagates request.signal abort after fast-path fetch delivers sync or async Response", async () => {
    for (const jitEnabled of [true, false]) {
      for (const asyncHandler of [false, true]) {
        // eslint-disable-next-line no-await-in-loop
        await withJitMode(jitEnabled, async () => {
          const root = createModule().value("tag", "stream").scope();

          let cancelCount = 0;
          let cancelReason: unknown = undefined;
          const canceled = Promise.withResolvers<void>();

          const makeResponse = () =>
            new Response(
              new ReadableStream<Uint8Array>({
                cancel(reason) {
                  cancelCount += 1;
                  cancelReason = reason;
                  canceled.resolve();
                },
              }),
            );

          const handle = root.fetch(["tag"], () =>
            asyncHandler ? Promise.resolve().then(makeResponse) : makeResponse(),
          );

          const controller = new AbortController();
          const response = await handle(
            new Request("https://example.test/stream", { signal: controller.signal }),
          );

          expect(cancelCount).toBe(0);
          const closing = ResultTask.runPromise(root.close());

          const reason = new Error("client-aborted-after-delivery");
          controller.abort(reason);
          await canceled.promise;

          expect(cancelCount).toBe(1);
          expect(cancelReason).toBe(reason);
          await expect(response.text()).rejects.toThrow("Request scope failed");
          await response.body?.cancel("second-cancel").catch(() => undefined);
          expect(cancelCount).toBe(1);
          await closing;

          // Verify normal completion removes the abort listener so later aborts do not trigger cancel.
          const root2 = createModule().value("tag", "normal").scope();
          let completedCancelCount = 0;
          const handleNormal = root2.fetch(["tag"], ({ tag }) => {
            const build = () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(streamController) {
                    streamController.enqueue(new TextEncoder().encode(tag));
                    streamController.close();
                  },
                  cancel() {
                    completedCancelCount += 1;
                  },
                }),
              );
            return asyncHandler ? Promise.resolve().then(build) : build();
          });

          const controller2 = new AbortController();
          const normalResponse = await handleNormal(
            new Request("https://example.test/normal", { signal: controller2.signal }),
          );
          expect(await normalResponse.text()).toBe("normal");
          controller2.abort("after-complete");
          await Promise.resolve();
          expect(completedCancelCount).toBe(0);
          await ResultTask.runPromise(root2.close());
        });
      }
    }
  });

  test("preserves service named __proto__ as an own property in compiled and interpreted DI plans", async () => {
    const protoKey = "__proto__";

    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const root = createModule()
          .value(protoKey, 7)
          .scoped("derived", [protoKey], (deps) => ({
            hasOwn: Object.hasOwn(deps, protoKey),
            value: (deps as Record<string, unknown>)[protoKey],
            isPlainProto: Object.getPrototypeOf(deps) === Object.prototype,
          }))
          .scope();

        const handleDirect = root.fetch([protoKey, "derived"], (services) =>
          Response.json({
            hasOwn: Object.hasOwn(services, protoKey),
            value: (services as Record<string, unknown>)[protoKey],
            isPlainProto: Object.getPrototypeOf(services) === Object.prototype,
            derived: services.derived,
          }),
        );

        const directResponse = await handleDirect(new Request("https://example.test/proto"));
        expect(await directResponse.json()).toEqual({
          hasOwn: true,
          value: 7,
          isPlainProto: true,
          derived: { hasOwn: true, value: 7, isPlainProto: true },
        });

        const useResult = await ResultTask.runPromise(
          root.use([protoKey], (services) =>
            ResultTask.ok({
              hasOwn: Object.hasOwn(services, protoKey),
              value: (services as Record<string, unknown>)[protoKey],
            }),
          ),
        );
        expect(useResult).toEqual({ hasOwn: true, value: 7 });

        await ResultTask.runPromise(root.close());

        // Also check __proto__ provided as a local via withServices()
        const localRoot = createModule().value("other", 1).scope();
        const locals = Object.defineProperty({}, protoKey, {
          value: 7,
          enumerable: true,
          configurable: true,
          writable: true,
        }) as Record<string, number>;
        const scopedWithLocal = localRoot.withServices(locals);
        const handleLocal = scopedWithLocal.fetch(["other", protoKey], (services) =>
          Response.json({
            hasOwn: Object.hasOwn(services, protoKey),
            value: (services as Record<string, unknown>)[protoKey],
            other: services.other,
          }),
        );
        const localResponse = await handleLocal(new Request("https://example.test/proto-local"));
        expect(await localResponse.json()).toEqual({ hasOwn: true, value: 7, other: 1 });
        await ResultTask.runPromise(localRoot.close());
      });
    }
  });

  test("keeps fetch scope open until asynchronous producer cancel finishes with a pending read", async () => {
    for (const jitEnabled of [true, false]) {
      for (const useScopedResource of [false, true]) {
        // eslint-disable-next-line no-await-in-loop
        await withJitMode(jitEnabled, async () => {
          const events: string[] = [];
          let poolReleases = 0;
          const cancelStarted = Promise.withResolvers<void>();
          const cancelGate = Promise.withResolvers<void>();

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
                  poolReleases += 1;
                  events.push("release-pool");
                }),
            })
            .resource("tx", [], {
              acquire: () => ResultTask.ok({ id: 1 }),
              release: () =>
                ResultTask.sync(() => {
                  events.push("release-tx");
                }),
            })
            .value("tag", "stream")
            .scope();

          await ResultTask.runPromise(root.use(["pool"], () => ResultTask.ok(undefined)));

          const makeStreamResponse = () =>
            new Response(
              new ReadableStream<Uint8Array>({
                async cancel() {
                  events.push("producer-cancel-start");
                  cancelStarted.resolve();
                  await cancelGate.promise;
                  events.push("producer-cancel-done");
                },
              }),
            );

          const handle = useScopedResource
            ? root.fetch(["tx"], makeStreamResponse)
            : root.fetch(["tag"], makeStreamResponse);

          const response = await handle(new Request("https://example.test/async-cancel"));
          const reader = response.body?.getReader();
          if (reader === undefined) throw new Error("Expected response body");

          const pendingRead = reader.read();
          const pendingCancel = reader.cancel("consumer-cancel");
          await cancelStarted.promise;

          let closed = false;
          const closing = ResultTask.runPromise(root.close()).then(() => {
            closed = true;
          });

          await Promise.resolve();
          await new Promise((resolve) => {
            setTimeout(resolve, 15);
          });

          expect(closed).toBe(false);
          expect(poolReleases).toBe(0);
          expect(events).toEqual(["acquire-pool", "producer-cancel-start"]);

          cancelGate.resolve();
          await pendingCancel;
          await pendingRead;
          await closing;

          expect(closed).toBe(true);
          expect(poolReleases).toBe(1);
          expect(events).toEqual(
            useScopedResource
              ? [
                  "acquire-pool",
                  "producer-cancel-start",
                  "producer-cancel-done",
                  "release-tx",
                  "release-pool",
                ]
              : ["acquire-pool", "producer-cancel-start", "producer-cancel-done", "release-pool"],
          );
        });
      }
    }
  });

  test("rejects already-locked response bodies consistently across fast-path and resource fetch", async () => {
    for (const jitEnabled of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      await withJitMode(jitEnabled, async () => {
        const events: string[] = [];
        let poolReleases = 0;
        let txReleases = 0;
        const holdStarted = Promise.withResolvers<void>();
        const holdGate = Promise.withResolvers<void>();

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
                poolReleases += 1;
                events.push("release-pool");
              }),
          })
          .resource("tx", [], {
            acquire: () =>
              ResultTask.sync(() => {
                events.push("acquire-tx");
                return { id: 1 };
              }),
            release: () =>
              ResultTask.sync(() => {
                txReleases += 1;
                events.push("release-tx");
              }),
          })
          .value("tag", "fast")
          .scope();

        await ResultTask.runPromise(root.use(["pool"], () => ResultTask.ok(undefined)));

        // Keep an unrelated request active to prove locked-body rejection decrements activeChildren exactly once.
        const handleHold = root.fetch(["tag"], async ({ tag }) => {
          holdStarted.resolve();
          await holdGate.promise;
          return new Response(tag);
        });
        const pendingHold = handleHold(new Request("https://example.test/hold"));
        await holdStarted.promise;

        const makeLockedResponse = () => {
          const response = new Response(new ReadableStream<Uint8Array>());
          response.body?.getReader();
          return response;
        };

        const handleLockedFast = root.fetch(["tag"], makeLockedResponse);
        const handleLockedTier2 = root.fetch(["tx"], makeLockedResponse);

        await Promise.all(
          [handleLockedFast, handleLockedTier2].map((handle) =>
            expect(handle(new Request("https://example.test/locked"))).rejects.toMatchObject({
              message: "Request scope failed",
              cause: { _tag: "Fail", error: expect.any(TypeError) as unknown },
            }),
          ),
        );

        expect(txReleases).toBe(1);

        let closed = false;
        const closing = ResultTask.runPromise(root.close()).then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(poolReleases).toBe(0);

        holdGate.resolve();
        const holdResponse = await pendingHold;
        expect(await holdResponse.text()).toBe("fast");
        await closing;

        expect(closed).toBe(true);
        expect(poolReleases).toBe(1);
        expect(txReleases).toBe(1);
      });
    }
  });

  test("coordinates overlapping and re-entrant request abort with reader.cancel across fast and resource fetch", async () => {
    for (const jitEnabled of [true, false]) {
      for (const useScopedResource of [false, true]) {
        for (const abortMode of ["while-pending", "reentrant-inside-cancel"] as const) {
          // eslint-disable-next-line no-await-in-loop
          await withJitMode(jitEnabled, async () => {
            const events: string[] = [];
            let poolReleases = 0;
            let txReleases = 0;
            let producerCancelCalls = 0;
            const cancelStarted = Promise.withResolvers<void>();
            const cancelGate = Promise.withResolvers<void>();
            const controller = new AbortController();

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
                    poolReleases += 1;
                    events.push("release-pool");
                  }),
              })
              .resource("tx", [], {
                acquire: () => ResultTask.ok({ id: 1 }),
                release: () =>
                  ResultTask.sync(() => {
                    txReleases += 1;
                    events.push("release-tx");
                  }),
              })
              .value("tag", "stream")
              .scope();

            await ResultTask.runPromise(root.use(["pool"], () => ResultTask.ok(undefined)));

            const makeStreamResponse = () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel() {
                    producerCancelCalls += 1;
                    events.push("producer-cancel-start");
                    cancelStarted.resolve();
                    if (abortMode === "reentrant-inside-cancel") {
                      // Trigger request abort synchronously BEFORE returning the cancel Promise.
                      controller.abort(new Error("reentrant-abort"));
                    }
                    return cancelGate.promise.then(() => {
                      events.push("producer-cancel-done");
                    });
                  },
                }),
              );

            const handle = useScopedResource
              ? root.fetch(["tx"], makeStreamResponse)
              : root.fetch(["tag"], makeStreamResponse);

            const response = await handle(
              new Request("https://example.test/overlapping-cancel", { signal: controller.signal }),
            );
            const reader = response.body?.getReader();
            if (reader === undefined) throw new Error("Expected response body");

            const pendingRead = reader.read();
            const pendingCancel = reader.cancel("consumer-cancel");
            await cancelStarted.promise;

            if (abortMode === "while-pending") {
              controller.abort(new Error("overlapping-abort"));
            }

            let closed = false;
            const closing = ResultTask.runPromise(root.close()).then(() => {
              closed = true;
            });

            await Promise.resolve();
            await new Promise((resolve) => {
              setTimeout(resolve, 15);
            });

            expect(closed).toBe(false);
            expect(poolReleases).toBe(0);
            expect(txReleases).toBe(0);
            expect(producerCancelCalls).toBe(1);
            expect(events).toEqual(["acquire-pool", "producer-cancel-start"]);

            cancelGate.resolve();
            await pendingCancel;
            await pendingRead.catch(() => undefined);
            await closing;

            expect(closed).toBe(true);
            expect(poolReleases).toBe(1);
            expect(txReleases).toBe(useScopedResource ? 1 : 0);
            expect(producerCancelCalls).toBe(1);
            expect(events).toEqual(
              useScopedResource
                ? [
                    "acquire-pool",
                    "producer-cancel-start",
                    "producer-cancel-done",
                    "release-tx",
                    "release-pool",
                  ]
                : ["acquire-pool", "producer-cancel-start", "producer-cancel-done", "release-pool"],
            );
          });
        }
      }
    }
  });

  test("resolves Tier 0 and Tier 1 sync plans using pure JS closures without calling Function", async () => {
    const functionSpy = vi.spyOn(globalThis, "Function").mockImplementation(() => {
      throw new Error("Dynamic code generation must not be invoked by resultar-di");
    });
    try {
      const root = createModule()
        .value("cfg", { env: "prod" })
        .singleton("db", ["cfg"], ({ cfg }) => ({ env: cfg.env }))
        .scoped("a", ["db"], ({ db }) => `${db.env}:a`)
        .scoped("b", ["db", "a"], ({ db, a }) => `${db.env}:${a}:b`)
        .scoped("c", ["a", "b"], ({ a, b }) => `${a}|${b}`)
        .scoped("d", ["a", "b", "c"], ({ a, b, c }) => `${a}+${b}+${c}`)
        .scoped("e", ["a", "b", "c", "d"], ({ a, b, c, d }) => `${a}/${b}/${c}/${d}`)
        .transient("nonce", [], () => 7)
        .scope();

      const tier0 = root.fetch(["db"], ({ db }) => new Response(db.env));
      const tier0Response = await tier0(new Request("https://example.test/t0"));
      expect(await tier0Response.text()).toBe("prod");

      const tier1 = root
        .withServices({ trace: "t-1" })
        .fetch(["a", "b", "c", "d", "e", "nonce", "trace"], (services) => Response.json(services));
      const tier1Response = await tier1(new Request("https://example.test/t1"));
      const payload = (await tier1Response.json()) as Record<string, unknown>;
      expect(payload.a).toBe("prod:a");
      expect(payload.nonce).toBe(7);
      expect(payload.trace).toBe("t-1");

      await ResultTask.runPromise(root.close());
      expect(functionSpy).not.toHaveBeenCalled();
    } finally {
      functionSpy.mockRestore();
    }
  });

  test("defines own service bindings even when Object.prototype has an inherited setter for the same key", async () => {
    const setterKey = "__resultarDiInheritedSetterTestKey__";
    let setterCalls = 0;
    // eslint-disable-next-line no-extend-native -- Regression test verifying inherited Object.prototype setters are bypassed.
    Object.defineProperty(Object.prototype, setterKey, {
      configurable: true,
      enumerable: false,
      // eslint-disable-next-line accessor-pairs -- Intentionally defines a setter-only inherited accessor.
      set() {
        setterCalls += 1;
      },
    });
    try {
      const root = createModule()
        .value(setterKey, "registered-value")
        .value("k2", 2)
        .value("k3", 3)
        .value("k4", 4)
        .scoped("derived", [setterKey], (deps) => ({
          hasOwn: Object.hasOwn(deps, setterKey),
          val: deps[setterKey],
        }))
        .scope();

      // 1-key Tier 0 via scope.use()
      const single = await ResultTask.runPromise(
        root.use([setterKey], (services) =>
          ResultTask.ok({ hasOwn: Object.hasOwn(services, setterKey), val: services[setterKey] }),
        ),
      );
      expect(single).toEqual({ hasOwn: true, val: "registered-value" });

      const inspect = (services: { readonly derived: unknown } & Record<string, unknown>) =>
        Response.json({
          hasOwn: Object.hasOwn(services, setterKey),
          val: services[setterKey],
          derived: services.derived,
        });

      // 2-key, 3-key, and 5-key Tier 1 via scope.fetch()
      const handlers = [
        root.fetch([setterKey, "derived"], inspect),
        root.fetch([setterKey, "k2", "derived"], inspect),
        root.fetch([setterKey, "k2", "k3", "k4", "derived"], inspect),
      ];
      const responses = await Promise.all(
        handlers.map((handler) => handler(new Request("https://example.test/setter"))),
      );
      const bodies = (await Promise.all(responses.map((response) => response.json()))) as Record<
        string,
        unknown
      >[];
      for (const body of bodies) {
        expect(body).toEqual({
          hasOwn: true,
          val: "registered-value",
          derived: { hasOwn: true, val: "registered-value" },
        });
      }

      expect(setterCalls).toBe(0);
      await ResultTask.runPromise(root.close());
    } finally {
      Reflect.deleteProperty(Object.prototype, setterKey);
    }
  });
});
