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

/** Adds DI to a native Hono router without replacing its bindings or response types. */
export function createHonoServices<S extends object, E, R, G extends ServiceGraph>(
  services: ServiceModule<S, E, R, G>,
): HonoServices<S, R, G> {
  const root = services.scope();
  const active = new WeakSet<object>();
  let closing: Promise<Result<void, ServiceScopeError<R>>> | undefined = undefined;
  return {
    middleware: (keys, options) => async (context, next) => {
      // A native middleware lifecycle violation is reported through Hono's error handler.
      // resultar-check-disable-next-line prefer-tagged-error
      if (closing !== undefined) throw new Error("Hono services are closed");
      if (active.has(context) || context.get("services") !== undefined)
        throw new TypeError("Only one services middleware may run per request");
      active.add(context);
      const getLocals = options?.locals;
      // Hono Context is invariant in its environment; this context only adds the services variable.
      const locals =
        getLocals === undefined
          ? {}
          : await getLocals(context as unknown as Parameters<typeof getLocals>[0]);
      // The public selection checks requirements; only the adapter erases dispatch types.
      const scope = root.withServices(locals);
      const dispatch = scope.fetch as unknown as (
        keys: readonly string[],
        handle: (values: Readonly<Record<string, unknown>>, request: Request) => Promise<Response>,
      ) => (request: Request) => Promise<Response>;
      context.res = await dispatch(keys, async (values) => {
        context.set("services", values as never);
        await next();
        return context.res;
      })(context.req.raw);
    },
    close: () => {
      closing ??= ResultTask.runResult(root.close());
      return closing;
    },
  };
}
