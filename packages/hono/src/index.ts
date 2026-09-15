import { Hono } from "hono";
import { ResultTask, type Result } from "resultar";
import {
  inspectModule,
  type ServiceModule,
  type HttpServiceSelection,
  type ServiceGraph,
  type ServiceScopeError,
} from "resultar-di";

export { createModule, Service, service, resource } from "resultar-di";
export type {
  HttpApplication,
  ServiceClass,
  ServiceLifetime,
  ServiceModule,
  ServiceScope,
} from "resultar-di";

export { createHonoServices } from "./middleware.js";
export type { HonoServices } from "./middleware.js";

export interface HonoApplication<CloseError = never, RequestServices extends object = object> {
  /** Inference only; no runtime metadata is installed. */
  readonly serviceTypes?: { readonly request: RequestServices };
  readonly fetch: (request: Request) => Promise<Response>;
  readonly request: (input: string | Request, init?: RequestInit) => Promise<Response>;
  readonly close: () => Promise<Result<void, CloseError>>;
}

/** Infers selected bindings from an application or its factory. */
export type InferRequestServices<Source> = Source extends {
  readonly serviceTypes?: { readonly request: infer Services };
}
  ? Services
  : Source extends (...args: never[]) => infer Created
    ? InferRequestServices<Created>
    : never;

type SelectedServices<S extends object, Keys> = Keys extends readonly (keyof S)[]
  ? Readonly<Pick<S, Keys[number]>>
  : Readonly<S>;

/** Configures one Hono router. Omitted bindings select all services; [] selects none. */
export function createHonoApp<
  S extends object,
  E,
  R,
  G extends ServiceGraph,
  const Keys extends readonly Extract<keyof S, string>[] | undefined = undefined,
>(
  options: {
    readonly services: ServiceModule<S, E, R, G>;
    readonly bindings?: Keys & HttpServiceSelection<S, R, G, Exclude<Keys, undefined>>;
  } & (undefined extends Keys
    ? HttpServiceSelection<S, R, G, undefined>
    : { readonly bindings: Keys }),
  configure: (app: Hono<{ Bindings: SelectedServices<S, Keys> }>) => void,
): HonoApplication<ServiceScopeError<R>, SelectedServices<S, Keys>> {
  const router = new Hono<{ Bindings: SelectedServices<S, Keys> }>();
  configure(router);
  const root = options.services.scope();
  // The public selection already checks missing requirements. Erasure is confined to dispatch.
  const bind = root.fetch as unknown as (
    keys: readonly string[],
    handler: (
      services: SelectedServices<S, Keys>,
      request: Request,
    ) => Response | Promise<Response>,
  ) => (request: Request) => Promise<Response>;
  const keys = options.bindings ?? inspectModule(options.services).map(({ name }) => name);
  const dispatch = bind(keys, (bindings, request) => router.fetch(request, bindings));
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
