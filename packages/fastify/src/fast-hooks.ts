import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";
// Lifecycle sessions retain their eager ResultAsync compatibility boundary.
/* eslint-disable typescript/no-deprecated */
import {
  err,
  ResultTaskCauseError,
  tryResult,
  tryResultAsync,
  unitAsync,
  type ResultAsync,
} from "resultar";
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

const getRequestAbortReason = (request: FastifyRequest, reply: FastifyReply): unknown => {
  if (reply.raw.destroyed && !reply.raw.writableFinished) {
    return new Error("Response connection closed");
  }
  if (!request.signal.aborted) return undefined;
  const reason: unknown = request.signal.reason;
  // Fastify 5.12 emits a generic abort on IncomingMessage.close, including a fully
  // received body. The response close/error listeners own disconnects after upload.
  if (request.raw.complete && reason instanceof DOMException && reason.name === "AbortError") {
    return undefined;
  }
  return reason ?? new DOMException("This operation was aborted", "AbortError");
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

const finishRequest = (state: RequestState): ResultAsync<void, never> => {
  const finished: ResultAsync<unknown, never> = state.session?.finish() ?? unitAsync();
  return finished.andThen(() => state.completion ?? unitAsync()).map(() => state.cleanup());
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
  if (request.signal.aborted) abort();
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
  readonly mapError: (error: unknown) => unknown;
}

interface Tier2RequestContext {
  readonly config: RequestHookConfig;
  readonly requests: WeakMap<FastifyRequest, RequestState>;
}

interface HookInvocation {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly done: HookHandlerDoneFunction;
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
  state.completion = session.completion
    .map((exit) => {
      state.cleanup();
      return exit;
    })
    .inspect((exit) => {
      if (state.exposed && exit._tag === "Failure" && hasFailure(exit.cause)) {
        request.log.error(
          { err: new ResultTaskCauseError(exit.cause) },
          "Request service cleanup failed",
        );
      }
    });
  return session;
};

const runTier2WithLocals = (
  ctx: Tier2RequestContext,
  request: FastifyRequest,
  replyAndLocals: { readonly reply: FastifyReply; readonly locals: RuntimeServices },
): Promise<void> => {
  const { config, requests } = ctx;
  const { reply, locals } = replyAndLocals;
  const state = attachRequest(request, reply);
  requests.set(request, state);
  return tryResult(() => startTier2Session(config, state, { request, locals }), preserveNativeError)
    .asyncAndThen((session) => session.ready)
    .andThen((services) =>
      tryResult(() => {
        (request as unknown as { services: unknown }).services = services;
        state.exposed = true;
      }, preserveNativeError),
    )
    .orElse((error) => finishRequest(state).andThen(() => err(error)))
    .mapErr(config.mapError)
    .unwrapOrThrow();
};

type FastRequestFinalizer = () => void;

const finishFastRequest = (request: FastifyRequest, fastActiveKey: symbol): void => {
  const flagged = request as unknown as Record<symbol, FastRequestFinalizer | undefined>;
  const finalize = flagged[fastActiveKey];
  if (finalize !== undefined) {
    finalize();
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

const settleIntoDone = (promise: PromiseLike<unknown>, done: HookHandlerDoneFunction): void => {
  promise.then(
    () => done(),
    (error: unknown) => done(error as Error),
  );
};

const executeFastPlan = (
  ctx: FastExecutionContext,
  locals: RuntimeServices,
  invocation: HookInvocation,
): void => {
  const { plan, bridge, fastActiveKey, mapError } = ctx;
  const { request, reply, done } = invocation;
  if (bridge.isClosed()) {
    done(mapError(createClosedScopeError()) as Error);
    return;
  }
  let services: RuntimeServices = EMPTY_SERVICES;
  try {
    services = plan.resolve(bridge.rootCache, locals);
  } catch (error) {
    done(mapError(new ResultTaskCauseError({ _tag: "Die", defect: error })) as Error);
    return;
  }
  bridge.beginChild();
  const flagged = request as unknown as Record<symbol, FastRequestFinalizer | undefined>;
  const rawReply = reply.raw;
  const finalize: FastRequestFinalizer = () => {
    if (flagged[fastActiveKey] !== finalize) return;
    flagged[fastActiveKey] = undefined;
    rawReply.removeListener("close", finalize);
    bridge.endChild();
  };
  flagged[fastActiveKey] = finalize;
  rawReply.once("close", finalize);
  if (rawReply.closed) {
    finalize();
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
  app.decorateRequest(fastActiveKey);
  const execCtx: FastExecutionContext = {
    plan: staticPlan,
    bridge,
    fastActiveKey,
    mapError: config.mapError,
  };

  addCallbackRequestHook(app, config.requestHook, (request, reply, done) => {
    const abortReason = getRequestAbortReason(request, reply);
    if (abortReason !== undefined) {
      done(config.mapError(abortReason) as Error);
      return;
    }
    executeFastPlan(execCtx, EMPTY_SERVICES, { request, reply, done });
  });

  app.addHook("onResponse", (request, _reply, done) => {
    finishFastRequest(request, fastActiveKey);
    done();
  });

  app.addHook("onRequestAbort", (request, done) => {
    finishFastRequest(request, fastActiveKey);
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
  const requests = new WeakMap<FastifyRequest, RequestState>();
  const tier2Ctx: Tier2RequestContext = { config, requests };
  app.decorateRequest(fastActiveKey);

  const localCache: { keys?: readonly string[]; plan?: CompiledSyncPlan } = {};

  const resolvePlanForLocals = (locals: RuntimeServices): CompiledSyncPlan | undefined => {
    if (matchesLocalKeys(locals, localCache.keys)) {
      return localCache.plan;
    }
    const keys = Object.keys(locals);
    const plan = bridge.getPlan(config.bindings, keys);
    localCache.keys = keys;
    localCache.plan = plan;
    return plan;
  };

  const applyResolvedLocals = (rawLocals: object | undefined, invocation: HookInvocation): void => {
    const { request, reply, done } = invocation;
    const locals = (rawLocals ?? EMPTY_SERVICES) as RuntimeServices;
    const plan = resolvePlanForLocals(locals);
    if (plan !== undefined) {
      const abortReason = getRequestAbortReason(request, reply);
      if (abortReason !== undefined) {
        done(config.mapError(abortReason) as Error);
        return;
      }
      executeFastPlan(
        { plan, bridge, fastActiveKey, mapError: config.mapError },
        locals,
        invocation,
      );
      return;
    }
    settleIntoDone(runTier2WithLocals(tier2Ctx, request, { reply, locals }), done);
  };

  addCallbackRequestHook(app, config.requestHook, (request, reply, done) => {
    let localsOrPromise: object | Promise<object> = EMPTY_SERVICES;
    try {
      localsOrPromise = getLocals(request);
    } catch (error) {
      done(config.mapError(error) as Error);
      return;
    }
    const invocation: HookInvocation = { request, reply, done };
    if (isPromiseLike(localsOrPromise)) {
      localsOrPromise.then(
        (resolved) => applyResolvedLocals(resolved, invocation),
        (error: unknown) => done(config.mapError(error) as Error),
      );
      return;
    }
    applyResolvedLocals(localsOrPromise, invocation);
  });

  app.addHook("onResponse", (request, _reply, done) => {
    finishFastRequest(request, fastActiveKey);
    const state = requests.get(request);
    if (state === undefined) {
      done();
      return;
    }
    settleIntoDone(
      finishRequest(state)
        .map(() => requests.delete(request))
        .mapErr(config.mapError)
        .unwrapOrThrow(),
      done,
    );
  });

  app.addHook("onRequestAbort", (request, done) => {
    finishFastRequest(request, fastActiveKey);
    done();
  });
};

const registerTier2Hooks = (app: FastifyInstance, config: RequestHookConfig): void => {
  const requests = new WeakMap<FastifyRequest, RequestState>();

  app.addHook(config.requestHook, async (request, reply) => {
    const state = attachRequest(request, reply);
    requests.set(request, state);
    return tryResultAsync(
      async () => (await config.locals?.(request)) ?? EMPTY_SERVICES,
      preserveNativeError,
    )
      .andThen((locals) =>
        tryResult(
          () => startTier2Session(config, state, { request, locals: locals as RuntimeServices }),
          preserveNativeError,
        ),
      )
      .andThen((session) => session.ready)
      .andThen((services) =>
        tryResult(() => {
          (request as unknown as { services: unknown }).services = services;
          state.exposed = true;
        }, preserveNativeError),
      )
      .orElse((error) => finishRequest(state).andThen(() => err(error)))
      .mapErr(config.mapError)
      .unwrapOrThrow();
  });

  app.addHook("onResponse", async (request) => {
    const state = requests.get(request);
    if (state !== undefined) {
      await finishRequest(state)
        .map(() => requests.delete(request))
        .mapErr(config.mapError)
        .unwrapOrThrow();
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
