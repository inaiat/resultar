import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  err,
  fromSafePromise,
  ResultTask,
  ResultTaskCauseError,
  tryResult,
  tryResultAsync,
  unit,
  unitAsync,
  type ResultAsync,
} from "resultar";
import type { ServiceScope } from "resultar-di";
import {
  useServiceAccess,
  type ServiceAccess,
  type HttpServiceSelection,
} from "resultar-di/advanced";

import { hasFailure, startSession, type RuntimeTask, type ServiceSession } from "./session.js";

export interface FastifyServicesPlugin<
  App extends object,
  Request extends object,
> extends FastifyPluginAsync {
  /** Inference only; no runtime metadata or global Fastify augmentation is installed. */
  readonly serviceTypes?: { readonly app: App; readonly request: Request };
}

export type InferAppServices<Plugin> = Plugin extends {
  readonly serviceTypes?: { readonly app: infer App };
}
  ? App
  : never;

export type InferRequestServices<Plugin> = Plugin extends {
  readonly serviceTypes?: { readonly request: infer Request };
}
  ? Request
  : never;

type RuntimeServices = Readonly<Record<string, unknown>>;
type UseServices = (
  keys: readonly string[],
  hold: (services: RuntimeServices) => RuntimeTask,
) => RuntimeTask;
interface RuntimeScope {
  readonly use: UseServices;
  readonly useSingletons: UseServices;
  readonly withServices: (locals: object) => RuntimeScope;
  readonly close: () => RuntimeTask;
}

type ModuleShape = { readonly scope: () => unknown };
type ModuleSource = ModuleShape | ((app: FastifyInstance) => ModuleShape | Promise<ModuleShape>);
type ModuleOf<M> = M extends (app: FastifyInstance) => infer Module ? Awaited<Module> : M;
type ModuleInfo<M> =
  ModuleOf<M> extends { readonly scope: () => ServiceScope<infer S, infer _E, infer R, infer G> }
    ? { readonly services: S; readonly requirements: R; readonly graph: G }
    : never;
type ServicesOf<M> = ModuleInfo<M>["services"];
type Selection<
  M,
  Local extends object,
  Keys extends readonly string[],
> = Keys extends readonly Extract<keyof ServicesOf<M>, string>[]
  ? HttpServiceSelection<
      ServicesOf<M> & Local,
      ModuleInfo<M>["requirements"],
      ModuleInfo<M>["graph"],
      Keys
    >
  : Keys & { readonly unknownServices: Exclude<Keys[number], keyof ServicesOf<M>> };

interface RequestState {
  readonly controller: AbortController;
  readonly cleanup: () => void;
  session?: ServiceSession;
  completion?: ServiceSession["completion"];
  exposed: boolean;
}

// Fastify owns the external error contract; retain identity, status codes and attached metadata.
const preserveNativeError = (error: unknown): unknown => error;

function closeApplication(
  root: RuntimeScope,
  session?: ServiceSession,
): ResultAsync<void, AggregateError> {
  // Acquisition failures are reported through ready; singleton finalizers belong to the root.
  const finished: ResultAsync<unknown, never> = session?.finish() ?? unitAsync();
  return finished
    .andThen(() => fromSafePromise(ResultTask.runExit(root.close())))
    .andThen((exit) =>
      exit._tag === "Failure"
        ? err(
            new AggregateError(
              [new ResultTaskCauseError(exit.cause)],
              "Application service cleanup failed",
            ),
          )
        : unit(),
    );
}

function finishRequest(state: RequestState): ResultAsync<void, never> {
  const finished: ResultAsync<unknown, never> = state.session?.finish() ?? unitAsync();
  return finished.andThen(() => state.completion ?? unitAsync()).map(() => state.cleanup());
}

function attachRequest(request: FastifyRequest, reply: FastifyReply): RequestState {
  const controller = new AbortController();
  const abort = () => {
    const reason: unknown = request.signal.reason;
    // Fastify 5.12 emits a generic abort on IncomingMessage.close, including a fully
    // received body. The response close/error listeners own disconnects after upload.
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
}

type LocalsFactory = (request: FastifyRequest) => object | Promise<object>;

export interface FastifyServicesOptions {
  readonly name?: string;
  readonly services: ModuleSource;
  readonly bindings: readonly string[];
  readonly appBindings?: readonly string[];
  readonly locals?: LocalsFactory;
  /** Framework facades can expose lazy services before validation. Defaults to preHandler. */
  readonly requestHook?: "onRequest" | "preHandler";
  readonly exposeApplication?: (access: ServiceAccess, app: FastifyInstance) => object;
  readonly exposeRequest?: (access: ServiceAccess, request: FastifyRequest) => object;
  /** Adapt native lifecycle failures at a framework facade boundary. */
  readonly mapError?: (error: unknown) => unknown;
  /** Defaults to true. Facades can report rollback errors only at the failed startup boundary. */
  readonly rethrowRollbackOnClose?: boolean;
}

type LocalValues<O> = O extends { readonly locals: infer Local extends LocalsFactory }
  ? Awaited<ReturnType<Local>>
  : Record<never, never>;
type Exposed<O, Key extends PropertyKey, Fallback> =
  O extends Record<Key, (...args: never[]) => infer Value extends object> ? Value : Fallback;
type AppBindings<O> = O extends { readonly appBindings: infer Keys extends readonly string[] }
  ? Keys
  : readonly [];
type CheckedOptions<O extends FastifyServicesOptions> = {
  readonly bindings: Selection<O["services"], LocalValues<O>, O["bindings"]> &
    ([ModuleInfo<O["services"]>] extends [never]
      ? { readonly invalidModule: "Expected a Resultar service module" }
      : unknown) &
    (Extract<keyof LocalValues<O>, keyof ServicesOf<O["services"]>> extends never
      ? unknown
      : {
          readonly duplicateServices: Extract<
            keyof LocalValues<O>,
            keyof ServicesOf<O["services"]>
          >;
        });
  readonly appBindings?: Selection<O["services"], Record<never, never>, AppBindings<O>>;
};

/** Registers native Fastify services backed by one Resultar DI root. */
export function createFastifyPlugin<const Options extends FastifyServicesOptions>(
  options: Options & CheckedOptions<NoInfer<Options>>,
): FastifyServicesPlugin<
  Exposed<
    Options,
    "exposeApplication",
    Readonly<
      Pick<
        ServicesOf<Options["services"]>,
        Extract<AppBindings<Options>[number], keyof ServicesOf<Options["services"]>>
      >
    >
  >,
  Exposed<
    Options,
    "exposeRequest",
    Readonly<
      Pick<
        ServicesOf<Options["services"]>,
        Extract<Options["bindings"][number], keyof ServicesOf<Options["services"]>>
      >
    >
  >
> {
  const { exposeApplication, exposeRequest } = options;
  const plugin: FastifyPluginAsync = async (app) => {
    if (app.hasDecorator("services") || app.hasRequestDecorator("services"))
      throw new TypeError("The services decorator is already registered in this Fastify context");
    const source: ModuleSource = options.services;
    const module = typeof source === "function" ? await source(app) : source;
    // Selections and local requirements are checked at the public boundary above.
    const root = module.scope() as RuntimeScope;
    const requests = new WeakMap<FastifyRequest, RequestState>();
    const application: {
      session?: ServiceSession;
      closing?: ResultAsync<void, AggregateError>;
      rolledBack?: boolean;
    } = {};
    const close = () => {
      application.closing ??= closeApplication(root, application.session);
      return application.closing;
    };
    // Register ownership before awaiting providers, including Fastify plugin-timeout failures.
    app.addHook("onClose", async () => {
      if (application.rolledBack === true && options.rethrowRollbackOnClose === false) return;
      await close()
        .mapErr(options.mapError ?? preserveNativeError)
        .unwrapOrThrow();
    });
    return (
      tryResult(() => {
        application.session = startSession((hold) =>
          exposeApplication === undefined
            ? root.useSingletons(options.appBindings ?? [], hold)
            : useServiceAccess(
                root,
                (access) => hold(exposeApplication(access, app) as RuntimeServices),
                { application: true, initialize: options.appBindings },
              ),
        );
        return application.session;
      }, preserveNativeError)
        .asyncAndThen((session) => session.ready)
        .andThen((appServices) =>
          tryResult(() => {
            if (application.closing !== undefined)
              // Native plugin initialization failure, not a domain Result error.
              // resultar-check-disable-next-line prefer-tagged-error
              throw new Error("Fastify services closed during initialization");
            app.decorate("services", appServices);
            app.decorateRequest("services");

            app.addHook(options.requestHook ?? "preHandler", async (request, reply) => {
              const state = attachRequest(request, reply);
              requests.set(request, state);
              return (
                tryResultAsync(
                  async () => (await options.locals?.(request)) ?? {},
                  preserveNativeError,
                )
                  .andThen((locals) =>
                    tryResult(() => {
                      state.controller.signal.throwIfAborted();
                      const scope = root.withServices(locals);
                      const session = startSession(
                        (hold) =>
                          exposeRequest === undefined
                            ? scope.use(options.bindings, hold)
                            : useServiceAccess(
                                scope,
                                (access) => hold(exposeRequest(access, request) as RuntimeServices),
                                { initialize: options.bindings },
                              ),
                        state.controller.signal,
                      );
                      state.session = session;
                      state.completion = session.completion
                        .map((exit) => {
                          state.cleanup();
                          return exit;
                        })
                        .tap((exit) => {
                          if (state.exposed && exit._tag === "Failure" && hasFailure(exit.cause)) {
                            request.log.error(
                              { err: new ResultTaskCauseError(exit.cause) },
                              "Request service cleanup failed",
                            );
                          }
                        });
                      return session;
                    }, preserveNativeError),
                  )
                  .andThen((session) => session.ready)
                  .andThen((services) =>
                    tryResult(() => {
                      request.setDecorator("services", services);
                      state.exposed = true;
                    }, preserveNativeError),
                  )
                  .orElse((error) => finishRequest(state).andThen(() => err(error)))
                  // Fastify's native error handler receives the original failure after cleanup.
                  .mapErr(options.mapError ?? preserveNativeError)
                  .unwrapOrThrow()
              );
            });

            app.addHook("onResponse", async (request) => {
              const state = requests.get(request);
              if (state !== undefined) {
                await finishRequest(state)
                  .map(() => requests.delete(request))
                  .mapErr(options.mapError ?? preserveNativeError)
                  .unwrapOrThrow();
              }
            });
          }, preserveNativeError),
        )
        .orElse((error) =>
          // Rollback is awaited and its failure is retained alongside the initialization failure.
          close()
            .mapErr((cleanupError) => {
              application.rolledBack = true;
              return new AggregateError(
                [error, cleanupError],
                "Service initialization and cleanup failed",
                { cause: cleanupError },
              );
            })
            .andThen(() => {
              application.rolledBack = true;
              return err(error);
            }),
        )
        .mapErr(options.mapError ?? preserveNativeError)
        // Plugin registration deliberately rejects at the Fastify boundary.
        .unwrapOrThrow()
    );
  };
  return fp(plugin, { name: options.name ?? "resultar-fastify", fastify: "5.x" });
}
