import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutionContext } from "@nestjs/common";
import { err, ResultTaskCauseError } from "resultar";

import type { NestRequest, NestRequestLogger } from "./index.js";

const SYNC_PLAN_BRIDGE = Symbol.for("resultar-di/sync-plan-bridge");
const REQUEST_HELPERS_KEY = Symbol("resultar.nestjs.helpers");
const EMPTY_SERVICES: Readonly<Record<string, unknown>> = Object.freeze({});

export type RuntimeServices = Readonly<Record<string, unknown>>;

export interface CompiledSyncPlan {
  readonly tier: 0 | 1;
  readonly resolve: (rootCache: Map<string, unknown>, locals: RuntimeServices) => RuntimeServices;
}

export interface SyncPlanBridge {
  readonly isClosed: () => boolean;
  readonly beginChild: () => void;
  readonly endChild: () => void;
  readonly getPlan: (
    keys: readonly string[],
    localKeys: readonly string[],
  ) => CompiledSyncPlan | undefined;
  readonly rootCache: Map<string, unknown>;
}

interface FastifyLikeInstance {
  readonly addHook?: (name: string, handler: (...args: readonly unknown[]) => void) => unknown;
  readonly decorateRequest?: (name: PropertyKey, value?: unknown) => unknown;
  readonly hasRequestDecorator?: (name: PropertyKey) => boolean;
}

export interface FastRequestDispatcher {
  readonly tryFastInitialize: (
    context: ExecutionContext,
    fallback: (locals?: RuntimeServices) => Promise<void>,
  ) => void | Promise<void>;
}

interface FastDispatcherConfig {
  readonly bridge: SyncPlanBridge;
  readonly bindings: readonly string[];
  readonly locals?: (request: NestRequest) => object | Promise<object>;
  readonly mapError: (error: unknown) => unknown;
  readonly nextRequestId: () => string;
  readonly requestIdHeader?: string;
  readonly fastifyInstance?: unknown;
}

const noopLog = (): void => {
  /* No-op fallback when a custom HTTP adapter omits request.log. */
};

const noopAbortListener = (): void => {
  /* Observes request abort during locals evaluation; removed immediately upon settlement. */
};

const fallbackRequestLogger: NestRequestLogger = {
  info: noopLog,
  error: noopLog,
  warn: noopLog,
  debug: noopLog,
  trace: noopLog,
  fatal: noopLog,
};

function getRequestDecorator<T = unknown>(
  this: Record<PropertyKey, unknown>,
  name: PropertyKey,
): T {
  return this[name] as T;
}

function setRequestDecorator(
  this: Record<PropertyKey, unknown>,
  name: PropertyKey,
  value: unknown,
): void {
  this[name] = value;
}

export const ensureRequestHelpersFast = (
  request: NestRequest,
  nextRequestId: () => string,
  requestIdHeader?: string,
): void => {
  const requestRecord = request as unknown as Record<PropertyKey, unknown>;
  if (requestRecord[REQUEST_HELPERS_KEY] === true) return;
  requestRecord[REQUEST_HELPERS_KEY] = true;

  const headerValue =
    requestIdHeader === undefined ? undefined : request.headers[requestIdHeader.toLowerCase()];
  if (typeof headerValue === "string" && headerValue.length > 0) {
    request.id = headerValue;
  } else if (Array.isArray(headerValue) && typeof headerValue[0] === "string") {
    request.id = headerValue[0];
  } else if (typeof request.id !== "string" || request.id.length === 0) {
    request.id = nextRequestId();
  }
  if (typeof requestRecord.log !== "object" || requestRecord.log === null) {
    requestRecord.log = fallbackRequestLogger;
  }
  if (!Object.hasOwn(requestRecord, "getDecorator")) {
    Object.defineProperty(requestRecord, "getDecorator", {
      value: getRequestDecorator,
      writable: true,
      configurable: true,
    });
  }
  if (!Object.hasOwn(requestRecord, "setDecorator")) {
    Object.defineProperty(requestRecord, "setDecorator", {
      value: setRequestDecorator,
      writable: true,
      configurable: true,
    });
  }
};

export const getSyncPlanBridge = (scope: object): SyncPlanBridge | undefined =>
  (scope as Record<symbol, SyncPlanBridge | undefined>)[SYNC_PLAN_BRIDGE];

const getRawRequest = (request: NestRequest): IncomingMessage =>
  (request as { readonly raw?: IncomingMessage }).raw ?? request;

const getRawResponse = (response: ServerResponse): ServerResponse =>
  (response as { readonly raw?: ServerResponse }).raw ?? response;

const isPromiseLike = (value: unknown): value is PromiseLike<object | undefined> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

const createClosedScopeError = (): ResultTaskCauseError =>
  new ResultTaskCauseError({
    _tag: "Die",
    defect: new TypeError("Cannot create a child from a closed service scope"),
  });

export const requestControllers = new WeakMap<NestRequest, AbortController>();

export const ensureRequestSignal = (
  request: NestRequest,
  rawRequest: IncomingMessage,
  rawResponse: ServerResponse,
): AbortSignal => {
  if (Object.hasOwn(request, "signal") && request.signal instanceof AbortSignal)
    return request.signal;
  const rawSignal = (rawRequest as { readonly signal?: unknown }).signal;
  let signal: AbortSignal | undefined = undefined;
  if (rawSignal instanceof AbortSignal) {
    signal = rawSignal;
  } else if (request.signal instanceof AbortSignal) {
    return request.signal;
  } else {
    const controller = new AbortController();
    requestControllers.set(request, controller);
    signal = controller.signal;
    const onAborted = () => controller.abort(new Error("Request aborted"));
    const onClose = () => {
      if (!rawResponse.writableFinished) controller.abort(new Error("Response connection closed"));
      cleanup();
    };
    const cleanup = () => {
      rawRequest.removeListener("aborted", onAborted);
      rawResponse.removeListener("close", onClose);
      rawResponse.removeListener("finish", cleanup);
    };
    rawRequest.once("aborted", onAborted);
    rawResponse.once("close", onClose);
    rawResponse.once("finish", cleanup);
    if (rawRequest.destroyed && !rawRequest.complete) onAborted();
    if (rawResponse.destroyed) onClose();
  }
  Object.defineProperty(request, "signal", {
    value: signal,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return signal;
};

const isBenignFastifyBodyCloseAbort = (rawRequest: IncomingMessage, reason: unknown): boolean =>
  rawRequest.complete && reason instanceof DOMException && reason.name === "AbortError";

const getRequestAbortReason = (
  externalSignal: AbortSignal | undefined,
  rawRequest: IncomingMessage,
  rawResponse: ServerResponse,
): unknown => {
  if (rawResponse.destroyed && !rawResponse.writableFinished) {
    return new Error("Response connection closed");
  }
  if (rawRequest.destroyed && !rawRequest.complete) {
    return new Error("Request aborted");
  }
  if (externalSignal?.aborted !== true) return undefined;
  const reason: unknown = externalSignal.reason;
  // Fastify 5.12 emits a generic abort on IncomingMessage.close, including a fully
  // received body. The response close/error listeners own disconnects after upload.
  if (isBenignFastifyBodyCloseAbort(rawRequest, reason)) {
    return undefined;
  }
  return reason === undefined
    ? new DOMException("This operation was aborted", "AbortError")
    : reason;
};

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

type FastRequestFinalizer = () => void;

const installFastifyDrainHooks = (fastifyInstance: unknown, fastActiveKey: symbol): boolean => {
  if (typeof fastifyInstance !== "object" || fastifyInstance === null) return false;
  const candidate = fastifyInstance as FastifyLikeInstance;
  if (typeof candidate.addHook !== "function") return false;
  if (
    typeof candidate.decorateRequest === "function" &&
    candidate.hasRequestDecorator?.(fastActiveKey) !== true
  ) {
    candidate.decorateRequest(fastActiveKey);
  }
  const finish = (request: unknown): void => {
    const record = request as Record<symbol, FastRequestFinalizer | undefined>;
    const finalize = record[fastActiveKey];
    if (finalize !== undefined) {
      finalize();
    }
  };
  candidate.addHook("onResponse", (request, _reply, done) => {
    finish(request);
    (done as () => void)();
  });
  candidate.addHook("onRequestAbort", (request, done) => {
    finish(request);
    (done as () => void)();
  });
  return true;
};

const attachFallbackDrain = (rawResponse: ServerResponse, bridge: SyncPlanBridge): void => {
  let done = false;
  const onDone = (): void => {
    if (done) return;
    done = true;
    rawResponse.removeListener("finish", onDone);
    rawResponse.removeListener("close", onDone);
    bridge.endChild();
  };
  rawResponse.once("finish", onDone);
  rawResponse.once("close", onDone);
  if (rawResponse.closed) {
    onDone();
  }
};

interface ResolvedPlanContext {
  readonly request: NestRequest;
  readonly rawRequest: IncomingMessage;
  readonly rawResponse: ServerResponse;
  readonly externalSignal: AbortSignal | undefined;
}

const createFastTracker = (
  bridge: SyncPlanBridge,
  fastifyInstance: unknown,
): ((request: NestRequest, rawResponse: ServerResponse) => void) => {
  const fastActiveKey = Symbol("resultar.nestjs.active");
  const usesFastifyHooks = installFastifyDrainHooks(fastifyInstance, fastActiveKey);
  return (request: NestRequest, rawResponse: ServerResponse): void => {
    bridge.beginChild();
    if (usesFastifyHooks) {
      const record = request as unknown as Record<symbol, FastRequestFinalizer | undefined>;
      const finalize: FastRequestFinalizer = () => {
        if (record[fastActiveKey] !== finalize) return;
        record[fastActiveKey] = undefined;
        rawResponse.removeListener("close", finalize);
        bridge.endChild();
      };
      record[fastActiveKey] = finalize;
      rawResponse.once("close", finalize);
      if (rawResponse.closed) {
        finalize();
      }
    } else {
      attachFallbackDrain(rawResponse, bridge);
    }
  };
};

const rejectMapped = (mappedError: unknown): Promise<never> =>
  Promise.resolve().then(() => err(mappedError).unwrapOrThrow());

const executeCompiledPlan = (
  plan: CompiledSyncPlan,
  state: {
    readonly bridge: SyncPlanBridge;
    readonly mapError: (error: unknown) => unknown;
    readonly trackActive: (request: NestRequest, rawResponse: ServerResponse) => void;
  },
  target: { readonly ctx: ResolvedPlanContext; readonly locals: RuntimeServices },
): void | Promise<void> => {
  const { bridge, mapError, trackActive } = state;
  const { ctx, locals } = target;
  const abortReason = getRequestAbortReason(ctx.externalSignal, ctx.rawRequest, ctx.rawResponse);
  if (abortReason !== undefined) {
    return rejectMapped(mapError(abortReason));
  }
  if (bridge.isClosed()) {
    return rejectMapped(mapError(createClosedScopeError()));
  }
  let services: RuntimeServices = EMPTY_SERVICES;
  try {
    services = plan.resolve(bridge.rootCache, locals);
  } catch (error) {
    return rejectMapped(mapError(new ResultTaskCauseError({ _tag: "Die", defect: error })));
  }
  trackActive(ctx.request, ctx.rawResponse);
  ctx.request.services = services;
  return undefined;
};

const createStaticDispatcher = (
  config: FastDispatcherConfig,
  staticPlan: CompiledSyncPlan,
): FastRequestDispatcher => {
  const trackActive = createFastTracker(config.bridge, config.fastifyInstance);
  const execState = { bridge: config.bridge, mapError: config.mapError, trackActive };

  return {
    tryFastInitialize: (context) => {
      const http = context.switchToHttp();
      const request = http.getRequest<NestRequest>();
      ensureRequestHelpersFast(request, config.nextRequestId, config.requestIdHeader);
      if (request.services !== undefined) return undefined;
      const response = http.getResponse<ServerResponse>();
      const rawRequest = getRawRequest(request);
      const rawResponse = getRawResponse(response);
      const externalSignal = ensureRequestSignal(request, rawRequest, rawResponse);
      return executeCompiledPlan(staticPlan, execState, {
        ctx: { request, rawRequest, rawResponse, externalSignal },
        locals: EMPTY_SERVICES,
      });
    },
  };
};

const createDynamicDispatcher = (
  config: FastDispatcherConfig,
  getLocals: (request: NestRequest) => object | Promise<object>,
): FastRequestDispatcher => {
  const trackActive = createFastTracker(config.bridge, config.fastifyInstance);
  const execState = { bridge: config.bridge, mapError: config.mapError, trackActive };
  const localCache: { keys?: readonly string[]; plan?: CompiledSyncPlan } = {};

  const resolvePlan = (locals: RuntimeServices): CompiledSyncPlan | undefined => {
    if (matchesLocalKeys(locals, localCache.keys)) {
      return localCache.plan;
    }
    const keys = Object.keys(locals);
    const plan = config.bridge.getPlan(config.bindings, keys);
    localCache.keys = keys;
    localCache.plan = plan;
    return plan;
  };

  const applyLocals = (
    rawLocals: object | undefined,
    ctx: ResolvedPlanContext,
    fallback: (locals?: RuntimeServices) => Promise<void>,
  ): void | Promise<void> => {
    const locals = (rawLocals ?? EMPTY_SERVICES) as RuntimeServices;
    const plan = resolvePlan(locals);
    if (plan === undefined) {
      return fallback(locals);
    }
    return executeCompiledPlan(plan, execState, { ctx, locals });
  };

  return {
    tryFastInitialize: (context, fallback) => {
      const http = context.switchToHttp();
      const request = http.getRequest<NestRequest>();
      ensureRequestHelpersFast(request, config.nextRequestId, config.requestIdHeader);
      if (request.services !== undefined) return undefined;
      const response = http.getResponse<ServerResponse>();
      const rawRequest = getRawRequest(request);
      const rawResponse = getRawResponse(response);
      const externalSignal = ensureRequestSignal(request, rawRequest, rawResponse);
      const ctx: ResolvedPlanContext = { request, rawRequest, rawResponse, externalSignal };

      externalSignal?.addEventListener("abort", noopAbortListener, { once: true });

      let localsOrPromise: object | Promise<object> = EMPTY_SERVICES;
      try {
        localsOrPromise = getLocals(request);
      } catch (error) {
        externalSignal?.removeEventListener("abort", noopAbortListener);
        return rejectMapped(config.mapError(error));
      }

      if (isPromiseLike(localsOrPromise)) {
        return Promise.resolve(localsOrPromise).then(
          (resolved) => {
            externalSignal?.removeEventListener("abort", noopAbortListener);
            return applyLocals(resolved, ctx, fallback);
          },
          (error: unknown) => {
            externalSignal?.removeEventListener("abort", noopAbortListener);
            throw config.mapError(error);
          },
        );
      }

      externalSignal?.removeEventListener("abort", noopAbortListener);
      return applyLocals(localsOrPromise, ctx, fallback);
    },
  };
};

/**
 * Creates a fast synchronous Tier 0 / Tier 1 NestJS request dispatcher when eligible,
 * or returns `undefined` to stay on the full Tier 2 `startSession` path.
 */
export const createFastRequestDispatcher = (
  config: FastDispatcherConfig,
): FastRequestDispatcher | undefined => {
  if (config.locals === undefined) {
    const staticPlan = config.bridge.getPlan(config.bindings, []);
    return staticPlan === undefined ? undefined : createStaticDispatcher(config, staticPlan);
  }
  return createDynamicDispatcher(config, config.locals);
};
