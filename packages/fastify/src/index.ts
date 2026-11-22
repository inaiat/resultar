import Fastify, {
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyRequest,
  type RawServerDefault,
} from "fastify";
import fp from "fastify-plugin";
import { err, ResultTask, ResultTaskCauseError, tryResult, unit, type Result } from "resultar";
import {
  useServiceAccess,
  inspectModule,
  startServiceTask,
  type ServiceTaskSession,
  type ServiceScope,
  type ServiceAccess,
  type HttpServiceSelection,
  type ServiceTaskRequirements,
} from "resultar-di";

import { registerRequestHooks, type RuntimeScope, type RuntimeServices } from "./fast-hooks.js";
import { startSession, type RuntimeTask, type ServiceSession } from "./session.js";

export { createModule, Service, service, resource } from "resultar-di";
export type {
  HttpApplication,
  ServiceClass,
  ServiceLifetime,
  ServiceModule,
  ServiceScope,
  ServiceTaskRequirements,
} from "resultar-di";

export interface FastifyServicesPlugin<
  App extends object,
  Request extends object,
> extends FastifyPluginAsync {
  /** Inference only; no runtime metadata or global Fastify augmentation is installed. */
  readonly serviceTypes?: { readonly app: App; readonly request: Request };
}

export interface FastifyServicesApplication<
  App extends object,
  Request extends object,
> extends FastifyInstance {
  /** Inference only; no runtime metadata or global Fastify augmentation is installed. */
  readonly serviceTypes?: { readonly app: App; readonly request: Request };
}

export type InferAppServices<Source> = Source extends {
  readonly serviceTypes?: { readonly app: infer App };
}
  ? App
  : Source extends (...args: never[]) => infer Created
    ? InferAppServices<Created>
    : never;

export type InferRequestServices<Source> = Source extends {
  readonly serviceTypes?: { readonly request: infer Request };
}
  ? Request
  : Source extends (...args: never[]) => infer Created
    ? InferRequestServices<Created>
    : never;

type ModuleShape = { readonly scope: () => unknown };
type ModuleSource = ModuleShape | ((app: FastifyInstance) => ModuleShape | Promise<ModuleShape>);
type ModuleOf<M> = M extends (app: FastifyInstance) => infer Module ? Awaited<Module> : M;
type ModuleInfo<M> =
  ModuleOf<M> extends { readonly scope: () => ServiceScope<infer S, infer _E, infer R, infer G> }
    ? { readonly services: S; readonly requirements: R; readonly graph: G }
    : never;
type ServicesOf<M> = ModuleInfo<M>["services"];
type Selection<M, Local extends object, Keys extends readonly string[]> = [Keys] extends [
  readonly Extract<keyof ServicesOf<M>, string>[],
]
  ? HttpServiceSelection<
      ServicesOf<M> & Local,
      ModuleInfo<M>["requirements"],
      ModuleInfo<M>["graph"],
      Keys
    >
  : Keys & { readonly unknownServices: Exclude<Keys[number], keyof ServicesOf<M>> };

// Fastify owns the external error contract; retain identity, status codes and attached metadata.
const preserveNativeError = (error: unknown): unknown => error;

async function closeApplication(
  root: RuntimeScope,
  session?: ServiceSession,
  startup?: ServiceTaskSession,
): Promise<Result<void, AggregateError>> {
  // Acquisition failures are reported through ready; singleton finalizers belong to the root.
  const errors: unknown[] = [];
  if (startup !== undefined) {
    const startupClose = await startup.close();
    if (startupClose.isErr()) errors.push(startupClose.error);
  }
  if (session !== undefined) {
    await session.finish();
  }
  const exit = await ResultTask.runExit(root.close());
  if (exit._tag === "Failure") errors.push(new ResultTaskCauseError(exit.cause));
  return errors.length > 0
    ? err(new AggregateError(errors, "Application service cleanup failed"))
    : unit();
}

type LocalsFactory = (request: FastifyRequest) => object | Promise<object>;

export interface FastifyServicesOptions {
  readonly name?: string;
  readonly services: ModuleSource;
  /** Defaults to all registered services; [] selects none. Resolved before each handler. */
  readonly bindings?: readonly string[];
  readonly appBindings?: readonly string[];
  /** A one-time application task, run in onReady after plugin loading. */
  readonly startup?:
    | ResultTask<void, unknown, unknown>
    | ((app: FastifyInstance) => ResultTask<void, unknown, unknown>);
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

export interface FastifyAppOptions
  extends FastifyServicesOptions, FastifyHttpOptions<RawServerDefault> {}

type LocalValues<O> = O extends { readonly locals: infer Local extends LocalsFactory }
  ? Awaited<ReturnType<Local>>
  : // eslint-disable-next-line typescript/no-generated-empty-object-type -- No locals contributes no keys to the service intersection.
    Record<never, never>;
type Exposed<O, Key extends PropertyKey, Fallback> =
  O extends Record<Key, (...args: never[]) => infer Value extends object> ? Value : Fallback;
type AppBindings<O> = O extends { readonly appBindings: infer Keys extends readonly string[] }
  ? Keys
  : readonly [];
type RequestBindings<O> = "bindings" extends keyof O ? O["bindings"] : undefined;
type ExplicitBindings<O> = Extract<RequestBindings<O>, readonly string[]>;
type RequestServices<M, Keys> = Keys extends readonly string[]
  ? Readonly<Pick<ServicesOf<M>, Extract<Keys[number], keyof ServicesOf<M>>>>
  : Readonly<ServicesOf<M>>;
type StartupTask<Startup> = Startup extends (...args: never[]) => infer Task ? Task : Startup;
type StartupRequirements<O extends FastifyServicesOptions> = [
  StartupTask<Exclude<O["startup"], undefined>>,
] extends [never]
  ? unknown
  : StartupTask<Exclude<O["startup"], undefined>> extends ResultTask<
        unknown,
        unknown,
        infer StartupR
      >
    ? ServiceTaskRequirements<
        ServicesOf<O["services"]>,
        StartupR,
        ModuleInfo<O["services"]>["graph"],
        ModuleInfo<O["services"]>["requirements"]
      >
    : unknown;
type CheckedOptions<O extends FastifyServicesOptions> = {
  readonly bindings?: Selection<O["services"], LocalValues<O>, ExplicitBindings<O>>;
  // eslint-disable-next-line typescript/no-generated-empty-object-type -- Application bindings have no request-local services.
  readonly appBindings?: Selection<O["services"], Record<never, never>, AppBindings<O>>;
} & StartupRequirements<O> &
  (undefined extends RequestBindings<O>
    ? HttpServiceSelection<
        ServicesOf<O["services"]> & LocalValues<O>,
        ModuleInfo<O["services"]>["requirements"],
        ModuleInfo<O["services"]>["graph"],
        undefined
      >
    : unknown) &
  ([ModuleInfo<O["services"]>] extends [never]
    ? { readonly invalidModule: "Expected a Resultar service module" }
    : unknown) &
  (Extract<keyof LocalValues<O>, keyof ServicesOf<O["services"]>> extends never
    ? unknown
    : {
        readonly duplicateServices: Extract<keyof LocalValues<O>, keyof ServicesOf<O["services"]>>;
      });

/** Creates a native Fastify instance and configures its routes before initialization. */
export function createFastifyApp<const Options extends FastifyAppOptions>(
  options: Options & CheckedOptions<NoInfer<Options>>,
  configure: (app: FastifyInstance) => void,
): FastifyServicesApplication<
  InferAppServices<ReturnType<typeof createFastifyPlugin<Options>>>,
  InferRequestServices<ReturnType<typeof createFastifyPlugin<Options>>>
> {
  const appOptions: FastifyAppOptions = options;
  const {
    name,
    services,
    bindings,
    appBindings,
    startup,
    locals,
    requestHook,
    exposeApplication,
    exposeRequest,
    mapError,
    rethrowRollbackOnClose,
    ...serverOptions
  } = appOptions;
  const app = Fastify(serverOptions);
  app.register(
    buildFastifyPlugin({
      name,
      services,
      bindings,
      appBindings,
      startup,
      locals,
      requestHook,
      exposeApplication,
      exposeRequest,
      mapError,
      rethrowRollbackOnClose,
    }),
  );
  configure(app);
  return app;
}

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
  Exposed<Options, "exposeRequest", RequestServices<Options["services"], RequestBindings<Options>>>
> {
  return buildFastifyPlugin(options);
}

function buildFastifyPlugin(options: FastifyServicesOptions): FastifyPluginAsync {
  const { exposeApplication, exposeRequest } = options;
  const plugin: FastifyPluginAsync = async (app) => {
    if (app.hasDecorator("services") || app.hasRequestDecorator("services"))
      throw new TypeError("The services decorator is already registered in this Fastify context");
    const source: ModuleSource = options.services;
    const module = typeof source === "function" ? await source(app) : source;
    const bindings = options.bindings ?? inspectModule(module).map(({ name }) => name);
    // Selections and local requirements are checked at the public boundary above.
    const root = module.scope() as RuntimeScope;
    const application: {
      session?: ServiceSession;
      startup?: ServiceTaskSession;
      closing?: Promise<Result<void, AggregateError>>;
      rolledBack?: boolean;
    } = {};
    const close = (): Promise<Result<void, AggregateError>> => {
      application.closing ??= closeApplication(root, application.session, application.startup);
      return application.closing;
    };
    const rollback = async (error: unknown): Promise<Result<never, unknown>> => {
      const cleanup = await close();
      application.rolledBack = true;
      if (cleanup.isErr()) {
        return err(
          new AggregateError([error, cleanup.error], "Service initialization and cleanup failed", {
            cause: cleanup.error,
          }),
        );
      }
      return err(error);
    };
    const mapError = options.mapError ?? preserveNativeError;
    // Register ownership before awaiting providers, including Fastify plugin-timeout failures.
    app.addHook("onClose", async () => {
      if (application.rolledBack === true && options.rethrowRollbackOnClose === false) return;
      const closed = await close();
      closed.mapErr(mapError).unwrapOrThrow();
    });
    const init = async (): Promise<Result<void, unknown>> => {
      const started = tryResult(() => {
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
      }, preserveNativeError);
      if (started.isErr()) return err(started.error);

      const ready = await started.value.ready;
      if (ready.isErr()) return err(ready.error);

      return tryResult(() => {
        if (application.closing !== undefined)
          // Native plugin initialization failure, not a domain Result error.
          // resultar-check-disable-next-line prefer-tagged-error
          throw new Error("Fastify services closed during initialization");
        app.decorate("services", ready.value);
        app.decorateRequest("services");

        if (options.startup !== undefined)
          app.addHook("onReady", async () => {
            const startup = ResultTask.gen(function* initializeApplication() {
              const task =
                typeof options.startup === "function" ? options.startup(app) : options.startup;
              if (task !== undefined) yield* task;
            });
            application.startup = startServiceTask(
              (task) => root.useSingletons([], () => task as RuntimeTask),
              startup,
            );
            const startupReady = await application.startup.ready;
            if (startupReady.isErr()) {
              const rolled = await rollback(startupReady.error);
              rolled.mapErr(mapError).unwrapOrThrow();
            }
          });

        registerRequestHooks(app, {
          root,
          bindings,
          requestHook: options.requestHook ?? "preHandler",
          locals: options.locals,
          exposeRequest,
          mapError,
        });
      }, preserveNativeError);
    };

    const result = await init();
    if (result.isErr()) {
      const rolled = await rollback(result.error);
      // Plugin registration deliberately rejects at the Fastify boundary.
      rolled.mapErr(mapError).unwrapOrThrow();
    }
  };
  return fp(plugin, { name: options.name ?? "resultar-fastify", fastify: "5.x" });
}
