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

  const resDescriptor = findPropertyDescriptor(context, "res");
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

  const errorDescriptor = findPropertyDescriptor(context, "error");
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
      const handlers = new WeakMap<Request, Handle>();
      const sharedDispatch =
        getLocals === undefined
          ? bind(root, (values, request) => {
              const handle = handlers.get(request);
              if (handle === undefined) throw new TypeError("Missing Hono request context");
              return handle(values, request);
            })
          : undefined;
      return async (context, next) => {
        // A native middleware lifecycle violation is reported through Hono's error handler.
        // resultar-check-disable-next-line prefer-tagged-error
        if (closing !== undefined) throw new Error("Hono services are closed");
        if (active.has(context) || context.get("services") !== undefined)
          throw new TypeError("Only one services middleware may run per request");
        active.add(context);
        // Avoid allocating a child ServiceScope with empty locals when no locals factory is provided.
        let scope = root;
        if (getLocals !== undefined) {
          const raw = getLocals(context as unknown as Parameters<typeof getLocals>[0]);
          const localValues =
            typeof (raw as Partial<PromiseLike<object>> | null)?.then === "function"
              ? await raw
              : raw;
          scope = withLocals(localValues);
        }
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
    },
    close: () => {
      closing ??= ResultTask.runResult(root.close());
      return closing;
    },
  };
}
