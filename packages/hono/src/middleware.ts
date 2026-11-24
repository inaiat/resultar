import type { Context, Env, MiddlewareHandler } from "hono";
import { ResultTask, type Result } from "resultar";
import type {
  ServiceModule,
  HttpServiceSelection,
  ServiceGraph,
  ServiceScopeError,
} from "resultar-di";

export interface HonoServices<S extends object, R, G extends ServiceGraph> {
  readonly middleware: <
    const Keys extends readonly Extract<keyof S, string>[],
    // eslint-disable-next-line typescript/no-generated-empty-object-type -- The default contributes no local service keys.
    Local extends object = Record<never, never>,
    Environment extends Env = Env,
  >(
    keys: Keys & HttpServiceSelection<S & NoInfer<Local>, R, G, Keys>,
    options?: {
      readonly locals?: ((context: Context<Environment>) => Local | Promise<Local>) &
        (Extract<keyof NoInfer<Local>, keyof S> extends never
          ? unknown
          : { readonly duplicateServices: Extract<keyof Local, keyof S> });
    },
  ) => MiddlewareHandler<
    Environment & { Variables: { services: Readonly<Pick<S, Keys[number]>> } }
  >;
  readonly close: () => Promise<Result<void, ServiceScopeError<R>>>;
}

const SYNC_PLAN_BRIDGE = Symbol.for("resultar-di/sync-plan-bridge");
const EMPTY_SERVICES: Readonly<Record<string, unknown>> = Object.freeze({});

type RuntimeServices = Readonly<Record<string, unknown>>;

interface CompiledSyncPlan {
  readonly tier: 0 | 1;
  readonly resolve: (rootCache: Map<string, unknown>, locals: RuntimeServices) => RuntimeServices;
}

interface SyncPlanBridge {
  readonly isClosed: () => boolean;
  readonly beginChild: () => void;
  readonly endChild: () => void;
  readonly settleResponse?: (signal: AbortSignal, response: Response) => Promise<Response>;
  readonly getPlan: (
    keys: readonly string[],
    localKeys: readonly string[],
  ) => CompiledSyncPlan | undefined;
  readonly rootCache: Map<string, unknown>;
}

const getSyncPlanBridge = (scope: object): SyncPlanBridge | undefined =>
  (scope as Record<symbol, SyncPlanBridge | undefined>)[SYNC_PLAN_BRIDGE];

const isPromiseLike = (value: unknown): value is PromiseLike<object | undefined> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

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

const createInterruptScopeError = (signal: AbortSignal): Error => {
  const reason: unknown = signal.reason;
  // resultar-check-disable-next-line prefer-tagged-error
  return new Error("Request scope failed", { cause: { _tag: "Interrupt", reason } });
};

const createClosedScopeError = (): Error =>
  // resultar-check-disable-next-line prefer-tagged-error
  new Error("Request scope failed", {
    cause: {
      _tag: "Die",
      defect: new TypeError("Cannot create a child from a closed service scope"),
    },
  });

const createDefectScopeError = (defect: unknown): Error =>
  // resultar-check-disable-next-line prefer-tagged-error
  new Error("Request scope failed", { cause: { _tag: "Die", defect } });

const assertMiddlewareReady = (
  closing: Promise<unknown> | undefined,
  active: WeakSet<object>,
  context: Context,
): void => {
  // A native middleware lifecycle violation is reported through Hono's error handler.
  // resultar-check-disable-next-line prefer-tagged-error
  if (closing !== undefined) throw new Error("Hono services are closed");
  if (active.has(context) || context.get("services") !== undefined)
    throw new TypeError("Only one services middleware may run per request");
  active.add(context);
};

const runFastMiddleware = async (
  plan: CompiledSyncPlan,
  bridge: SyncPlanBridge,
  locals: RuntimeServices,
  context: Context,
  next: () => Promise<void>,
): Promise<void> => {
  if (bridge.isClosed()) throw createClosedScopeError();
  const signal = context.req.raw.signal;
  if (signal.aborted) throw createInterruptScopeError(signal);
  let services: RuntimeServices = EMPTY_SERVICES;
  try {
    services = plan.resolve(bridge.rootCache, locals);
  } catch (defect) {
    throw createDefectScopeError(defect);
  }
  bridge.beginChild();
  let response: Response | undefined = undefined;
  try {
    context.set("services", services as never);
    await next();
    response = context.res;
  } catch (error) {
    bridge.endChild();
    throw error;
  }
  const settleResponse = bridge.settleResponse;
  if (settleResponse === undefined) {
    bridge.endChild();
    return;
  }
  const wrapped = await settleResponse(signal, response);
  context.res = wrapped;
  watchReplacedResponse(context, wrapped);
};

interface CachedContextDescriptors {
  readonly res: PropertyDescriptor | undefined;
  readonly error: PropertyDescriptor | undefined;
}

const contextDescriptorCache = new WeakMap<object, CachedContextDescriptors>();

const findPropertyDescriptor = (
  target: object,
  key: PropertyKey,
): PropertyDescriptor | undefined => {
  let current: unknown = target;
  // eslint-disable-next-line unicorn/no-null -- Prototype chains terminate at null.
  while (typeof current === "object" && current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const getCachedDescriptors = (context: Context): CachedContextDescriptors => {
  const proto = Object.getPrototypeOf(context) as object | null;
  // eslint-disable-next-line unicorn/no-null -- Objects with null prototypes cannot be WeakMap keys.
  if (proto === null) {
    return {
      res: findPropertyDescriptor(context, "res"),
      error: findPropertyDescriptor(context, "error"),
    };
  }
  const cached = contextDescriptorCache.get(proto);
  if (cached !== undefined && !Object.hasOwn(context, "res")) {
    return cached;
  }
  const resolved: CachedContextDescriptors = {
    res: findPropertyDescriptor(context, "res"),
    error: findPropertyDescriptor(proto, "error"),
  };
  if (!Object.hasOwn(context, "res")) {
    contextDescriptorCache.set(proto, resolved);
  }
  return resolved;
};

const watchReplacedResponse = (context: Context, wrapped: Response): void => {
  const initialBody = wrapped.body;
  // eslint-disable-next-line unicorn/no-null -- Fetch Response.body is null when there is no body stream.
  if (initialBody === null) return;

  let trackedBody: ReadableStream<Uint8Array> | undefined = initialBody;
  const cancelTrackedBody = (reason: unknown): void => {
    const body = trackedBody;
    if (body === undefined) return;
    trackedBody = undefined;
    if (!body.locked) {
      body.cancel(reason).catch(() => {
        /* Replacement or outer error cleanup must not surface an unhandled rejection. */
      });
    }
  };

  const descriptors = getCachedDescriptors(context);
  const resDescriptor = descriptors.res;
  if (
    resDescriptor !== undefined &&
    resDescriptor.get !== undefined &&
    resDescriptor.set !== undefined
  ) {
    Object.defineProperty(context, "res", {
      configurable: true,
      enumerable: resDescriptor.enumerable ?? false,
      get(this: Context): Response {
        return resDescriptor.get?.call(this) as Response;
      },
      set(this: Context, nextResponse: Response | undefined) {
        resDescriptor.set?.call(this, nextResponse);
        if (nextResponse?.body !== trackedBody) {
          // resultar-check-disable-next-line prefer-tagged-error
          cancelTrackedBody(new Error("Hono response replaced"));
        }
      },
    });
  }

  const errorDescriptor = Object.getOwnPropertyDescriptor(context, "error") ?? descriptors.error;
  if (errorDescriptor === undefined || errorDescriptor.configurable !== false) {
    let currentError: unknown = context.error;
    Object.defineProperty(context, "error", {
      configurable: true,
      enumerable: errorDescriptor?.enumerable ?? true,
      get(this: Context): unknown {
        return errorDescriptor?.get === undefined ? currentError : errorDescriptor.get.call(this);
      },
      set(this: Context, nextError: unknown) {
        if (errorDescriptor?.set === undefined) {
          currentError = nextError;
        } else {
          errorDescriptor.set.call(this, nextError);
        }
        if (nextError !== undefined) {
          cancelTrackedBody(nextError);
        }
      },
    });
  }
};

/** Adds DI to a native Hono router without replacing its bindings or response types. */
export function createHonoServices<S extends object, E, R, G extends ServiceGraph>(
  services: ServiceModule<S, E, R, G>,
): HonoServices<S, R, G> {
  const root = services.scope();
  const bridge = getSyncPlanBridge(root);
  const active = new WeakSet<object>();
  let closing: Promise<Result<void, ServiceScopeError<R>>> | undefined = undefined;
  return {
    middleware: (keys, options) => {
      const selectedKeys = Object.freeze([...keys]);
      const getLocals = options?.locals;
      const withLocals = root.withServices as unknown as (values: object) => typeof root;
      type Handle = (
        values: Readonly<Record<string, unknown>>,
        request: Request,
      ) => Promise<Response>;
      const bind = (scope: typeof root, handle: Handle) =>
        (
          scope.fetch as unknown as (
            keys: readonly string[],
            handler: Handle,
          ) => (request: Request) => Promise<Response>
        )(selectedKeys, handle);

      if (getLocals === undefined && bridge !== undefined) {
        const staticPlan = bridge.getPlan(selectedKeys, []);
        if (staticPlan !== undefined) {
          return async (context, next) => {
            assertMiddlewareReady(closing, active, context);
            await runFastMiddleware(staticPlan, bridge, EMPTY_SERVICES, context, next);
          };
        }
      }

      const handlers = new WeakMap<Request, Handle>();
      const sharedDispatch =
        getLocals === undefined
          ? bind(root, (values, request) => {
              const handle = handlers.get(request);
              if (handle === undefined) throw new TypeError("Missing Hono request context");
              return handle(values, request);
            })
          : undefined;
      const localCache: { keys?: readonly string[]; plan?: CompiledSyncPlan } = {};
      const resolveDynamicPlan = (locals: RuntimeServices): CompiledSyncPlan | undefined => {
        if (bridge === undefined) return undefined;
        if (matchesLocalKeys(locals, localCache.keys)) {
          return localCache.plan;
        }
        const localKeys = Object.keys(locals);
        const plan = bridge.getPlan(selectedKeys, localKeys);
        localCache.keys = localKeys;
        localCache.plan = plan;
        return plan;
      };
      const runTier2Middleware = async (
        scope: typeof root,
        context: Context,
        next: () => Promise<void>,
      ): Promise<void> => {
        const handle: Handle = async (values) => {
          context.set("services", values as never);
          await next();
          return context.res;
        };
        const request = context.req.raw;
        let wrapped: Response | undefined = undefined;
        if (sharedDispatch === undefined || handlers.has(request)) {
          wrapped = await bind(scope, handle)(request);
        } else {
          handlers.set(request, handle);
          try {
            wrapped = await sharedDispatch(request);
          } finally {
            handlers.delete(request);
          }
        }
        context.res = wrapped;
        watchReplacedResponse(context, wrapped);
      };

      return async (context, next) => {
        assertMiddlewareReady(closing, active, context);
        if (getLocals === undefined) {
          await runTier2Middleware(root, context, next);
          return;
        }
        const signal = context.req.raw.signal;
        if (signal.aborted) throw createInterruptScopeError(signal);
        const raw = getLocals(context as unknown as Parameters<typeof getLocals>[0]);
        const resolved = isPromiseLike(raw) ? await raw : raw;
        const localValues = (resolved ?? EMPTY_SERVICES) as RuntimeServices;
        const plan = resolveDynamicPlan(localValues);
        if (plan !== undefined && bridge !== undefined) {
          await runFastMiddleware(plan, bridge, localValues, context, next);
          return;
        }
        await runTier2Middleware(withLocals(localValues), context, next);
      };
    },
    close: () => {
      closing ??= ResultTask.runResult(root.close());
      return closing;
    },
  };
}
