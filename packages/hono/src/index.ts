import { Hono } from "hono";
import {
  AbortError,
  err,
  errAsync,
  fromSafePromise,
  ResultTask,
  ResultTaskCauseError,
  unitAsync,
  unit,
  ok,
  type Exit,
  type Result,
  type ResultAsync,
} from "resultar";
import {
  inspectModule,
  startServiceTask,
  type ServiceTaskSession,
  type ServiceModule,
  type HttpServiceSelection,
  type ServiceGraph,
  type ServiceScopeError,
  type ServiceTaskRequirements,
} from "resultar-di";

export { createModule, Service, service, resource } from "resultar-di";
export type {
  HttpApplication,
  ServiceClass,
  ServiceLifetime,
  ServiceModule,
  ServiceScope,
  ServiceTaskRequirements,
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
type StartupRequirements<S extends object, Startup, G extends ServiceGraph, R> = [
  Exclude<Startup, undefined>,
] extends [never]
  ? unknown
  : Exclude<Startup, undefined> extends ResultTask<unknown, unknown, infer StartupR>
    ? ServiceTaskRequirements<S, StartupR, G, R>
    : unknown;

/** Configures one Hono router. Omitted bindings select all services; [] selects none. */
export function createHonoApp<
  S extends object,
  E,
  R,
  G extends ServiceGraph,
  const Keys extends readonly Extract<keyof S, string>[] | undefined = undefined,
  const Startup extends ResultTask<void, unknown, unknown> | undefined = undefined,
>(
  options: {
    readonly services: ServiceModule<S, E, R, G>;
    readonly startup?: Startup;
    readonly bindings?: Keys & HttpServiceSelection<S, R, G, Exclude<Keys, undefined>>;
  } & (undefined extends Keys
    ? HttpServiceSelection<S, R, G, undefined>
    : { readonly bindings: Keys }) &
    StartupRequirements<S, Startup, G, R>,
  configure: (app: Hono<{ Bindings: SelectedServices<S, Keys> }>) => void,
): HonoApplication<ServiceScopeError<R>, SelectedServices<S, Keys>> & {
  /** Runs the optional one-time application task and shares its result across requests. */
  readonly ready: () => ResultAsync<void, ResultTaskCauseError>;
} {
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
  let resourcesClosing: ResultAsync<Exit<void, ServiceScopeError<R>>, never> | undefined =
    undefined;
  let session: ServiceTaskSession | undefined = undefined;
  let startupResult: ResultAsync<void, ResultTaskCauseError> | undefined = undefined;
  let startupFailed = false;
  const closeResources = () => {
    resourcesClosing ??= (session?.close() ?? unitAsync())
      .map((): ResultTaskCauseError | undefined => undefined)
      .orElse((error) => ok(error))
      .andThen((error) =>
        fromSafePromise(ResultTask.runExit(root.close())).map(
          (exit): Exit<void, ServiceScopeError<R>> => {
            if (error === undefined) return exit;
            const cause = { _tag: "Die", defect: error } as const;
            return {
              _tag: "Failure",
              cause:
                exit._tag === "Failure"
                  ? { _tag: "Sequential", left: cause, right: exit.cause }
                  : cause,
            };
          },
        ),
      );
    return resourcesClosing;
  };
  const ready = (): ResultAsync<void, ResultTaskCauseError> => {
    if (closing !== undefined && !startupFailed)
      return errAsync(
        new ResultTaskCauseError({ _tag: "Die", defect: new Error("Hono application is closed") }),
      );
    if (startupResult !== undefined) return startupResult;
    const startup = options.startup;
    if (startup === undefined) {
      startupResult = unitAsync();
      return startupResult;
    }
    const useSingletons = root.useSingletons as unknown as (
      keys: readonly string[],
      use: () => ResultTask<unknown, unknown, never>,
    ) => ResultTask<unknown, unknown, never>;
    session = startServiceTask(
      (task) =>
        useSingletons([], () => task as ResultTask<void, unknown>) as ResultTask<void, unknown>,
      startup,
    );
    startupResult = session.ready.orElse((error) => {
      startupFailed = true;
      return closeResources().andThen((exit) =>
        errAsync(
          exit._tag === "Failure"
            ? new ResultTaskCauseError({ _tag: "Sequential", left: error.cause, right: exit.cause })
            : error,
        ),
      );
    });
    return startupResult;
  };
  const fetch = (request: Request): Promise<Response> => {
    if (closing !== undefined && !startupFailed)
      return Promise.reject(new Error("Hono application is closed"));
    if (options.startup === undefined) return dispatch(request);
    return Promise.resolve(ready()).then((result) =>
      result.match(
        () =>
          closing === undefined
            ? dispatch(request)
            : Promise.reject(new Error("Hono application is closed")),
        (error) => Promise.reject(error),
      ),
    );
  };
  return {
    fetch,
    request: (input, init) =>
      fetch(
        new Request(typeof input === "string" ? new URL(input, "http://localhost") : input, init),
      ),
    ready,
    close: () => {
      if (options.startup === undefined) {
        closing ??= ResultTask.runResult(root.close());
        return closing;
      }
      closing ??= closeResources().match(
        (exit): Result<void, ServiceScopeError<R>> => {
          if (exit._tag === "Success") return unit();
          if (exit.cause._tag === "Fail") return err(exit.cause.error);
          if (exit.cause._tag === "Die") throw exit.cause.defect;
          if (exit.cause._tag === "Interrupt")
            throw new AbortError("ResultTask execution interrupted", { cause: exit.cause.reason });
          throw new ResultTaskCauseError(exit.cause);
        },
        (error: never) => error,
      );
      return closing;
    },
  };
}
