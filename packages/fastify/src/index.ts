import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { err, ResultTask, ResultTaskCauseError, tryResultAsync } from "resultar";
import type { ServiceScope } from "resultar-di";
import type { HttpServiceSelection } from "resultar-di/advanced";

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
  exposed: boolean;
}

// Fastify owns the external error contract; retain identity, status codes and attached metadata.
const preserveNativeError = (error: unknown): unknown => error;

async function closeApplication(root: RuntimeScope, session?: ServiceSession): Promise<void> {
  const errors: Error[] = [];
  if (session !== undefined) {
    // Acquisition failures are reported through ready; singleton finalizers belong to the root.
    await session.finish();
  }
  const exit = await ResultTask.runExit(root.close());
  if (exit._tag === "Failure") errors.push(new ResultTaskCauseError(exit.cause));
  if (errors.length > 0) throw new AggregateError(errors, "Application service cleanup failed");
}

function attachRequest(request: FastifyRequest, reply: FastifyReply): RequestState {
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
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
}

type LocalValues<O> = O extends { readonly locals: infer Local extends LocalsFactory }
  ? Awaited<ReturnType<Local>>
  : Record<never, never>;
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
  Readonly<
    Pick<
      ServicesOf<Options["services"]>,
      Extract<AppBindings<Options>[number], keyof ServicesOf<Options["services"]>>
    >
  >,
  Readonly<
    Pick<
      ServicesOf<Options["services"]>,
      Extract<Options["bindings"][number], keyof ServicesOf<Options["services"]>>
    >
  >
> {
  const plugin: FastifyPluginAsync = async (app) => {
    if (app.hasDecorator("services") || app.hasRequestDecorator("services"))
      throw new TypeError("The services decorator is already registered in this Fastify context");
    const source: ModuleSource = options.services;
    const module = typeof source === "function" ? await source(app) : source;
    // Selections and local requirements are checked at the public boundary above.
    const root = module.scope() as RuntimeScope;
    const requests = new WeakMap<FastifyRequest, RequestState>();
    const application: { session?: ServiceSession; closing?: Promise<void> } = {};
    const close = () => {
      application.closing ??= closeApplication(root, application.session);
      return application.closing;
    };
    // Register ownership before awaiting providers, including Fastify plugin-timeout failures.
    app.addHook("onClose", close);
    return (
      tryResultAsync(async () => {
        application.session = startSession((hold) =>
          root.useSingletons(options.appBindings ?? [], hold),
        );
        const appServices = await application.session.ready;
        if (application.closing !== undefined)
          // Native plugin initialization failure, not a domain Result error.
          // resultar-check-disable-next-line prefer-tagged-error
          throw new Error("Fastify services closed during initialization");
        app.decorate("services", appServices);
        app.decorateRequest("services");

        app.addHook("preHandler", async (request, reply) => {
          const state = attachRequest(request, reply);
          requests.set(request, state);
          return (
            tryResultAsync(async () => {
              const locals = (await options.locals?.(request)) ?? {};
              state.controller.signal.throwIfAborted();
              const scope = root.withServices(locals);
              const session = startSession(
                (hold) => scope.use(options.bindings, hold),
                state.controller.signal,
              );
              state.session = session;
              // eslint-disable-next-line no-void
              void session.completion.then((exit) => {
                state.cleanup();
                if (state.exposed && exit._tag === "Failure" && hasFailure(exit.cause)) {
                  request.log.error(
                    { err: new ResultTaskCauseError(exit.cause) },
                    "Request service cleanup failed",
                  );
                }
              });
              const services: RuntimeServices = await session.ready;
              request.setDecorator("services", services);
              state.exposed = true;
            }, preserveNativeError)
              .orElse((error) =>
                tryResultAsync(async () => {
                  await state.session?.finish();
                  state.cleanup();
                }, preserveNativeError).andThen(() => err(error)),
              )
              // Fastify's native error handler receives the original failure after cleanup.
              .unwrapOrThrow()
          );
        });

        app.addHook("onResponse", async (request) => {
          const state = requests.get(request);
          if (state !== undefined) {
            await state.session?.finish();
            state.cleanup();
            requests.delete(request);
          }
        });
      }, preserveNativeError)
        .orElse((error) =>
          // Rollback is awaited and its failure is retained alongside the initialization failure.
          tryResultAsync(close, preserveNativeError)
            .mapErr(
              (cleanupError) =>
                new AggregateError(
                  [error, cleanupError],
                  "Service initialization and cleanup failed",
                  { cause: cleanupError },
                ),
            )
            .andThen(() => err(error)),
        )
        // Plugin registration deliberately rejects at the Fastify boundary.
        .unwrapOrThrow()
    );
  };
  return fp(plugin, { name: options.name ?? "resultar-fastify", fastify: "5.x" });
}
