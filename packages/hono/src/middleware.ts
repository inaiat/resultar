import type { Context, Env, MiddlewareHandler } from "hono";
import { ResultTask, type ResultAsync } from "resultar";
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
  readonly close: () => ResultAsync<void, ServiceScopeError<R>>;
}

/** Adds DI to a native Hono router without replacing its bindings or response types. */
export function createHonoServices<S extends object, E, R, G extends ServiceGraph>(
  services: ServiceModule<S, E, R, G>,
): HonoServices<S, R, G> {
  const root = services.scope();
  const active = new WeakSet<object>();
  let closing: ResultAsync<void, ServiceScopeError<R>> | undefined = undefined;
  return {
    middleware: (keys, options) => {
      const selectedKeys = Object.freeze([...keys]);
      const getLocals = options?.locals;
      const withLocals = root.withServices as unknown as (values: object) => typeof root;
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
            typeof raw === "object" &&
            raw !== null &&
            "then" in raw &&
            typeof (raw as PromiseLike<object>).then === "function"
              ? await raw
              : raw;
          scope = withLocals(localValues);
        }
        const dispatch = scope.fetch as unknown as (
          keys: readonly string[],
          handle: (
            values: Readonly<Record<string, unknown>>,
            request: Request,
          ) => Promise<Response>,
        ) => (request: Request) => Promise<Response>;
        context.res = await dispatch(selectedKeys, async (values) => {
          context.set("services", values as never);
          await next();
          return context.res;
        })(context.req.raw);
      };
    },
    close: () => {
      closing ??= ResultTask.runResult(root.close());
      return closing;
    },
  };
}
