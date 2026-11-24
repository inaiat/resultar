import type { ServerResponse } from "node:http";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
import { err, ResultTaskCauseError, tryResult, type Result } from "resultar";
import { useServiceAccess, type ServiceAccess } from "resultar-di";

import { hasFailure, startSession, type RuntimeTask, type ServiceSession } from "./session.js";

const SYNC_PLAN_BRIDGE = Symbol.for("resultar-di/sync-plan-bridge");
const EMPTY_SERVICES: Readonly<Record<string, unknown>> = Object.freeze({});

export type RuntimeServices = Readonly<Record<string, unknown>>;
export type UseServices = (
  keys: readonly string[],
  hold: (services: RuntimeServices) => RuntimeTask,
) => RuntimeTask;

export interface RuntimeScope {
  readonly use: UseServices;
  readonly useSingletons: UseServices;
  readonly withServices: (locals: object) => RuntimeScope;
  readonly close: () => RuntimeTask;
}

interface CompiledSyncPlan {
  readonly tier: 0 | 1;
  readonly resolve: (rootCache: Map<string, unknown>, locals: RuntimeServices) => RuntimeServices;
}

interface SyncPlanBridge {
  readonly isClosed: () => boolean;
  readonly beginChild: () => void;
  readonly endChild: () => void;
  readonly getPlan: (
    keys: readonly string[],
    localKeys: readonly string[],
  ) => CompiledSyncPlan | undefined;
  readonly rootCache: Map<string, unknown>;
}

interface RequestState {
  readonly controller: AbortController;
  readonly cleanup: () => void;
  session?: ServiceSession;
  completion?: ServiceSession["completion"];
  exposed: boolean;
}

export interface RequestHookConfig {
  readonly root: RuntimeScope;
  readonly bindings: readonly string[];
  readonly requestHook: "onRequest" | "preHandler";
  readonly locals?: (request: FastifyRequest) => object | Promise<object>;
  readonly exposeRequest?: (access: ServiceAccess, request: FastifyRequest) => object;
  readonly mapError: (error: unknown) => unknown;
}

const preserveNativeError = (error: unknown): unknown => error;

const isPromiseLike = (value: unknown): value is PromiseLike<object | undefined> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

const getSyncPlanBridge = (scope: object): SyncPlanBridge | undefined =>
  (scope as Record<symbol, SyncPlanBridge | undefined>)[SYNC_PLAN_BRIDGE];

const requestScopeDisabled = (request: FastifyRequest): boolean =>
  request.routeOptions.config?.resultar?.requestScope === false;

const getSignalAbortReason = (request: FastifyRequest): unknown => {
  const signal = request.signal;
  if (!signal.aborted) {
    return undefined;
  }
  const reason: unknown = signal.reason;
  // Fastify 5.12 emits a generic abort on IncomingMessage.close, including a fully
  // received body. The response close/error listeners own disconnects after upload.
  if (request.raw.complete && reason instanceof DOMException && reason.name === "AbortError") {
    return undefined;
  }
  return reason === undefined
    ? new DOMException("This operation was aborted", "AbortError")
    : reason;
};

const getRequestAbortReason = (
  request: FastifyRequest,
  reply: FastifyReply,
  checkNativeSignal = false,
): unknown => {
  if (reply.raw.destroyed && !reply.raw.writableFinished) {
    return new Error("Response connection closed");
  }
  // Fastify 5 lazily creates an AbortController and registers raw.on('close', onAbort) on
  // the first read of request.signal, which allocates a DOMException stack trace on every
  // completed POST body. Only read request.signal when Fastify already created it (e.g.
  // handlerTimeout > 0), Tier 2 already attached it, or an own override was installed;
  // otherwise Fastify's built-in signal only aborts on raw close, which is reflected by
  // raw.destroyed / raw.closed when !raw.complete.
  if (checkNativeSignal || Object.hasOwn(request, "signal")) {
    const signalReason = getSignalAbortReason(request);
    if (signalReason !== undefined) {
      return signalReason;
    }
  }
  if ((request.raw.destroyed || request.raw.closed) && !request.raw.complete) {
    return new DOMException("This operation was aborted", "AbortError");
  }
  return undefined;
};

const createClosedScopeError = (): ResultTaskCauseError =>
  new ResultTaskCauseError({
    _tag: "Die",
    defect: new TypeError("Cannot create a child from a closed service scope"),
  });

const matchesLocalKeys = (
  locals: RuntimeServices,
  expected: readonly string[] | undefined,
): boolean => {
  if (expected === undefined) return false;
  let count = 0;
  for (const key in locals) {
    if (Object.hasOwn(locals, key)) {
      if (expected[count] !== key) return false;
      count += 1;
    }
  }
  return count === expected.length;
};

const finishRequest = async (state: RequestState): Promise<void> => {
  await state.session?.finish();
  await state.completion;
  state.cleanup();
};

const attachRequest = (request: FastifyRequest, reply: FastifyReply): RequestState => {
  const controller = new AbortController();
  const abort = () => {
    const reason: unknown = request.signal.reason;
    if (request.raw.complete && reason instanceof DOMException && reason.name === "AbortError")
      return;
    controller.abort(reason);
  };
  const disconnect = () => {
    if (!reply.raw.writableFinished) controller.abort(new Error("Response connection closed"));
  };
  const transportError = (error: Error) => controller.abort(error);
  request.signal.addEventListener("abort", abort, { once: true });
  reply.raw.once("close", disconnect);
  reply.raw.once("error", transportError);
  const reason = getRequestAbortReason(request, reply, true);
  if (reason !== undefined) controller.abort(reason);
  return {
    controller,
    exposed: false,
    cleanup: () => {
      request.signal.removeEventListener("abort", abort);
      reply.raw.removeListener("close", disconnect);
      reply.raw.removeListener("error", transportError);
    },
  };
};

interface FastExecutionContext {
  readonly plan: CompiledSyncPlan;
  readonly bridge: SyncPlanBridge;
  readonly fastActiveKey: symbol;
  readonly onRawReplyClose: (this: ServerResponse) => void;
  readonly mapError: (error: unknown) => unknown;
}

interface Tier2RequestContext {
  readonly config: RequestHookConfig;
  readonly track: (request: FastifyRequest, state: RequestState) => void;
  readonly release: (request: FastifyRequest) => void;
}

interface HookInvocation {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly done: HookHandlerDoneFunction;
  readonly checkNativeSignal: boolean;
}

const startTier2Session = (
  config: RequestHookConfig,
  state: RequestState,
  target: { readonly request: FastifyRequest; readonly locals: RuntimeServices },
): ServiceSession => {
  const { request, locals } = target;
  state.controller.signal.throwIfAborted();
  const scope = config.root.withServices(locals);
  const { exposeRequest, bindings } = config;
  const session = startSession(
    (hold) =>
      exposeRequest === undefined
        ? scope.use(bindings, hold)
        : useServiceAccess(
            scope,
            (access) => hold(exposeRequest(access, request) as RuntimeServices),
            { initialize: bindings },
          ),
    state.controller.signal,
  );
  state.session = session;
  state.completion = session.completion.then((exit) => {
    state.cleanup();
    if (state.exposed && exit._tag === "Failure" && hasFailure(exit.cause)) {
      request.log.error(
        { err: new ResultTaskCauseError(exit.cause) },
        "Request service cleanup failed",
      );
    }
    return exit;
  });
  return session;
};

const runTier2WithLocals = async (
  ctx: Tier2RequestContext,
  request: FastifyRequest,
  replyAndLocals: { readonly reply: FastifyReply; readonly locals: RuntimeServices },
): Promise<void> => {
  const { config, track, release } = ctx;
  const { reply, locals } = replyAndLocals;
  const state = attachRequest(request, reply);
  track(request, state);
  const finishAndRelease = (): void => {
    finishRequest(state)
      .finally(() => {
        release(request);
      })
      .catch(() => {
        /* Disconnect cleanup must not surface an unhandled rejection. */
      });
  };
  const onRawClose = (): void => {
    if (!reply.raw.writableFinished) {
      finishAndRelease();
    }
  };
  reply.raw.once("close", onRawClose);
  const outcome = await startAndExposeTier2(config, state, { request, locals });
  if (outcome.isErr()) {
    reply.raw.removeListener("close", onRawClose);
    try {
      await finishRequest(state);
    } finally {
      release(request);
    }
    err(config.mapError(outcome.error)).unwrapOrThrow();
  }
  if (reply.raw.closed && !reply.raw.writableFinished) {
    reply.raw.removeListener("close", onRawClose);
    finishAndRelease();
  }
};

const startAndExposeTier2 = async (
  config: RequestHookConfig,
  state: RequestState,
  target: { readonly request: FastifyRequest; readonly locals: RuntimeServices },
): Promise<Result<void, unknown>> => {
  const started = tryResult(() => startTier2Session(config, state, target), preserveNativeError);
  if (started.isErr()) return err(started.error);
  const ready = await started.value.ready;
  if (ready.isErr()) return err(ready.error);
  return tryResult(() => {
    (target.request as unknown as { services: unknown }).services = ready.value;
    state.exposed = true;
  }, preserveNativeError);
};

const createRawReplyCloseHandler = (
  bridge: SyncPlanBridge,
  fastActiveKey: symbol,
): ((this: ServerResponse) => void) =>
  function onRawReplyClose(this: ServerResponse): void {
    const flagged = this as unknown as Record<symbol, boolean | undefined>;
    if (flagged[fastActiveKey] === true) {
      flagged[fastActiveKey] = false;
      bridge.endChild();
    }
  };

const finishFastReply = (
  rawReply: ServerResponse,
  bridge: SyncPlanBridge,
  fastActiveKey: symbol,
  onRawReplyClose: (this: ServerResponse) => void,
): void => {
  const flagged = rawReply as unknown as Record<symbol, boolean | undefined>;
  if (flagged[fastActiveKey] === true) {
    flagged[fastActiveKey] = false;
    rawReply.removeListener("close", onRawReplyClose);
    bridge.endChild();
  }
};

const finishFastRequestAbort = (
  request: FastifyRequest,
  bridge: SyncPlanBridge,
  fastActiveKey: symbol,
  onRawReplyClose: (this: ServerResponse) => void,
): void => {
  const flaggedRequest = request as unknown as Record<symbol, ServerResponse | undefined>;
  const rawReply = flaggedRequest[fastActiveKey];
  if (rawReply !== undefined) {
    flaggedRequest[fastActiveKey] = undefined;
    finishFastReply(rawReply, bridge, fastActiveKey, onRawReplyClose);
  }
};

const addCallbackRequestHook = (
  app: FastifyInstance,
  hook: "onRequest" | "preHandler",
  handler: (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void,
): void => {
  if (hook === "onRequest") {
    app.addHook("onRequest", handler);
  } else {
    app.addHook("preHandler", handler);
  }
};

const failHook = (
  done: HookHandlerDoneFunction,
  reason: unknown,
  mapError: (error: unknown) => unknown = preserveNativeError,
): void => {
  let error: unknown = reason;
  try {
    error = mapError(reason);
  } catch (mappingError) {
    error = mappingError;
  }
  // Fastify advances to the next hook on any falsy callback argument.
  const stopsHookChain = Boolean(error);
  done(
    stopsHookChain ? (error as Error) : new Error("Request service hook failed", { cause: error }),
  );
};

const settleIntoDone = (promise: PromiseLike<unknown>, done: HookHandlerDoneFunction): void => {
  promise.then(
    () => done(),
    (error: unknown) => failHook(done, error),
  );
};

const executeFastPlan = (
  ctx: FastExecutionContext,
  locals: RuntimeServices,
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void => {
  const { plan, bridge, fastActiveKey, onRawReplyClose, mapError } = ctx;
  if (bridge.isClosed()) {
    failHook(done, createClosedScopeError(), mapError);
    return;
  }
  let services: RuntimeServices = EMPTY_SERVICES;
  try {
    services = plan.resolve(bridge.rootCache, locals);
  } catch (error) {
    failHook(done, new ResultTaskCauseError({ _tag: "Die", defect: error }), mapError);
    return;
  }
  const rawReply = reply.raw;
  if (!rawReply.closed) {
    bridge.beginChild();
    (rawReply as unknown as Record<symbol, boolean | undefined>)[fastActiveKey] = true;
    (request as unknown as Record<symbol, ServerResponse | undefined>)[fastActiveKey] = rawReply;
    rawReply.on("close", onRawReplyClose);
  }
  (request as unknown as { services: unknown }).services = services;
  done();
};

const registerStaticFastHooks = (
  app: FastifyInstance,
  config: RequestHookConfig,
  fast: { readonly bridge: SyncPlanBridge; readonly staticPlan: CompiledSyncPlan },
): void => {
  const { bridge, staticPlan } = fast;
  const fastActiveKey = Symbol("resultar.fastify.active");
  const onRawReplyClose = createRawReplyCloseHandler(bridge, fastActiveKey);
  app.decorateRequest(fastActiveKey);
  const execCtx: FastExecutionContext = {
    plan: staticPlan,
    bridge,
    fastActiveKey,
    onRawReplyClose,
    mapError: config.mapError,
  };

  addCallbackRequestHook(app, config.requestHook, (request, reply, done) => {
    const routeOptions = request.routeOptions;
    if (routeOptions.config?.resultar?.requestScope === false) {
      done();
      return;
    }
    const abortReason = getRequestAbortReason(request, reply, routeOptions.handlerTimeout > 0);
    if (abortReason !== undefined) {
      failHook(done, abortReason, config.mapError);
      return;
    }
    executeFastPlan(execCtx, EMPTY_SERVICES, request, reply, done);
  });

  app.addHook("onResponse", (_request, reply, done) => {
    finishFastReply(reply.raw, bridge, fastActiveKey, onRawReplyClose);
    done();
  });

  app.addHook("onRequestAbort", (request, done) => {
    finishFastRequestAbort(request, bridge, fastActiveKey, onRawReplyClose);
    done();
  });
};

const registerDynamicFastHooks = (
  app: FastifyInstance,
  config: RequestHookConfig,
  dynamic: {
    readonly bridge: SyncPlanBridge;
    readonly getLocals: (request: FastifyRequest) => object | Promise<object>;
  },
): void => {
  const { bridge, getLocals } = dynamic;
  const fastActiveKey = Symbol("resultar.fastify.active");
  const onRawReplyClose = createRawReplyCloseHandler(bridge, fastActiveKey);
  const requests = new WeakMap<FastifyRequest, RequestState>();
  let activeTier2Count = 0;
  app.decorateRequest(fastActiveKey);

  const trackTier2Request = (request: FastifyRequest, state: RequestState): void => {
    if (!requests.has(request)) {
      activeTier2Count += 1;
    }
    requests.set(request, state);
  };

  const releaseTier2Tracking = (request: FastifyRequest): void => {
    if (requests.delete(request)) {
      activeTier2Count -= 1;
    }
  };

  const tier2Ctx: Tier2RequestContext = {
    config,
    track: trackTier2Request,
    release: releaseTier2Tracking,
  };

  const localCache: { keys?: readonly string[]; execCtx?: FastExecutionContext } = {};

  const resolveExecCtxForLocals = (locals: RuntimeServices): FastExecutionContext | undefined => {
    if (matchesLocalKeys(locals, localCache.keys)) {
      return localCache.execCtx;
    }
    const keys = Object.keys(locals);
    const plan = bridge.getPlan(config.bindings, keys);
    localCache.keys = keys;
    localCache.execCtx =
      plan === undefined
        ? undefined
        : { plan, bridge, fastActiveKey, onRawReplyClose, mapError: config.mapError };
    return localCache.execCtx;
  };

  const runWithResolvedLocals = (
    rawLocals: object | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void => {
    const locals = (rawLocals ?? EMPTY_SERVICES) as RuntimeServices;
    const execCtx = resolveExecCtxForLocals(locals);
    if (execCtx !== undefined) {
      executeFastPlan(execCtx, locals, request, reply, done);
      return;
    }
    settleIntoDone(runTier2WithLocals(tier2Ctx, request, { reply, locals }), done);
  };

  addCallbackRequestHook(app, config.requestHook, (request, reply, done) => {
    const routeOptions = request.routeOptions;
    if (routeOptions.config?.resultar?.requestScope === false) {
      done();
      return;
    }
    const hasHandlerTimeout = routeOptions.handlerTimeout > 0;
    const reason = getRequestAbortReason(request, reply, hasHandlerTimeout);
    if (reason !== undefined) {
      failHook(done, reason, config.mapError);
      return;
    }
    let localsOrPromise: object | Promise<object> = EMPTY_SERVICES;
    try {
      localsOrPromise = getLocals(request);
    } catch (error) {
      failHook(done, error, config.mapError);
      return;
    }
    if (isPromiseLike(localsOrPromise)) {
      const invocation: HookInvocation = {
        request,
        reply,
        done,
        checkNativeSignal: hasHandlerTimeout,
      };
      localsOrPromise.then(
        (resolved) => {
          const abortReason = getRequestAbortReason(
            invocation.request,
            invocation.reply,
            invocation.checkNativeSignal,
          );
          if (abortReason !== undefined) {
            failHook(invocation.done, abortReason, config.mapError);
            return;
          }
          runWithResolvedLocals(resolved, invocation.request, invocation.reply, invocation.done);
        },
        (error: unknown) => failHook(invocation.done, error, config.mapError),
      );
      return;
    }
    runWithResolvedLocals(localsOrPromise, request, reply, done);
  });

  app.addHook("onResponse", (request, reply, done) => {
    finishFastReply(reply.raw, bridge, fastActiveKey, onRawReplyClose);
    if (activeTier2Count === 0) {
      done();
      return;
    }
    const state = requests.get(request);
    if (state === undefined) {
      done();
      return;
    }
    settleIntoDone(
      finishRequest(state)
        .finally(() => {
          releaseTier2Tracking(request);
        })
        .catch((error: unknown) => err(config.mapError(error)).unwrapOrThrow()),
      done,
    );
  });

  app.addHook("onRequestAbort", (request, done) => {
    finishFastRequestAbort(request, bridge, fastActiveKey, onRawReplyClose);
    if (activeTier2Count === 0) {
      done();
      return;
    }
    const state = requests.get(request);
    if (state === undefined) {
      done();
      return;
    }
    settleIntoDone(
      finishRequest(state)
        .finally(() => {
          releaseTier2Tracking(request);
        })
        .catch(() => {
          /* Abort cleanup must not surface an unhandled rejection. */
        }),
      done,
    );
  });
};

const registerTier2Hooks = (app: FastifyInstance, config: RequestHookConfig): void => {
  const requests = new WeakMap<FastifyRequest, RequestState>();

  app.addHook(config.requestHook, async (request, reply) => {
    if (requestScopeDisabled(request)) return;
    const state = attachRequest(request, reply);
    requests.set(request, state);
    const resolveAndExpose = async (): Promise<Result<void, unknown>> => {
      let locals: RuntimeServices = EMPTY_SERVICES;
      try {
        state.controller.signal.throwIfAborted();
        locals = ((await config.locals?.(request)) ?? EMPTY_SERVICES) as RuntimeServices;
      } catch (error) {
        return err(error);
      }
      return startAndExposeTier2(config, state, { request, locals });
    };
    const outcome = await resolveAndExpose();
    if (outcome.isErr()) {
      await finishRequest(state);
      err(config.mapError(outcome.error)).unwrapOrThrow();
    }
  });

  app.addHook("onResponse", async (request) => {
    const state = requests.get(request);
    if (state !== undefined) {
      try {
        await finishRequest(state);
        requests.delete(request);
      } catch (error) {
        err(config.mapError(error)).unwrapOrThrow();
      }
    }
  });
};

/**
 * Registers Fastify request lifecycle hooks, automatically selecting the compiled Tier 0 / Tier 1
 * synchronous resolver when no request-scoped resources, async tasks, or dynamic `ServiceAccess`
 * exposures are involved.
 */
export const registerRequestHooks = (app: FastifyInstance, config: RequestHookConfig): void => {
  const bridge = config.exposeRequest === undefined ? getSyncPlanBridge(config.root) : undefined;
  if (bridge !== undefined && config.locals === undefined) {
    const staticPlan = bridge.getPlan(config.bindings, []);
    if (staticPlan !== undefined) {
      registerStaticFastHooks(app, config, { bridge, staticPlan });
      return;
    }
  }
  if (bridge !== undefined && config.locals !== undefined) {
    registerDynamicFastHooks(app, config, { bridge, getLocals: config.locals });
    return;
  }
  registerTier2Hooks(app, config);
};
