import { Hono } from "hono";
import { ResultTask, type Result } from "resultar";
import type { ServiceModule } from "resultar-di";
import type { HttpServiceSelection, ServiceGraph, ServiceScopeError } from "resultar-di/advanced";

export interface HonoApplication<CloseError = never> {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  readonly close: () => Promise<Result<void, CloseError>>;
}

/** Configures one Hono router and owns one DI root, with a child scope per response. */
export function createHonoApp<
  S extends object,
  E,
  R,
  G extends ServiceGraph,
  const Keys extends readonly Extract<keyof S, string>[],
>(
  options: {
    readonly services: ServiceModule<S, E, R, G>;
    readonly bindings: HttpServiceSelection<S, R, G, Keys>;
  },
  configure: (app: Hono<{ Bindings: Readonly<Pick<S, Keys[number]>> }>) => void,
): HonoApplication<ServiceScopeError<R>> {
  const router = new Hono<{ Bindings: Readonly<Pick<S, Keys[number]>> }>();
  configure(router);
  const root = options.services.scope();
  // The public selection already checks missing requirements. Erasure is confined to dispatch.
  const bind = root.fetch as unknown as (
    keys: Keys,
    handler: (
      services: Readonly<Pick<S, Keys[number]>>,
      request: Request,
    ) => Response | Promise<Response>,
  ) => (request: Request) => Promise<Response>;
  const dispatch = bind(options.bindings, (bindings, request) => router.fetch(request, bindings));
  let closing: Promise<Result<void, ServiceScopeError<R>>> | undefined = undefined;
  const fetch = (request: Request): Promise<Response> =>
    closing === undefined
      ? dispatch(request)
      : Promise.reject(new Error("Hono application is closed"));
  return {
    fetch,
    request: (input, init) =>
      fetch(
        new Request(typeof input === "string" ? new URL(input, "http://localhost") : input, init),
      ),
    close: () => {
      closing ??= ResultTask.runResult(root.close());
      return closing;
    },
  };
}
