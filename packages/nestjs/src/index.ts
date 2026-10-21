import { IncomingMessage, ServerResponse, type IncomingHttpHeaders, type Server } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import {
  createParamDecorator,
  Logger,
  Module,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  type INestApplicationContext,
  type ModuleMetadata,
  type NestApplicationOptions,
  type NestInterceptor,
} from "@nestjs/common";
import {
  AbstractHttpAdapter,
  APP_GUARD,
  APP_INTERCEPTOR,
  HttpAdapterHost,
  ModuleRef,
  NestFactory,
} from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { from, switchMap, type Observable } from "rxjs";
// Lifecycle sessions retain their eager ResultAsync compatibility boundary.
/* eslint-disable typescript/no-deprecated */
import {
  err,
  fromSafePromise,
  ResultAsync,
  ResultTask,
  ResultTaskCauseError,
  tryResult,
  tryResultAsync,
  unit,
  unitAsync,
} from "resultar";
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

import { hasFailure, startSession, type RuntimeTask, type ServiceSession } from "./session.js";

export { FastifyAdapter } from "@nestjs/platform-fastify";
export { createModule, Service, service, resource } from "resultar-di";
export type {
  HttpApplication,
  ServiceClass,
  ServiceLifetime,
  ServiceModule,
  ServiceScope,
  ServiceTaskRequirements,
} from "resultar-di";

/** Injection token for resolved application-scoped Resultar services (`appBindings`). */
export const APP_SERVICES: unique symbol = Symbol.for("resultar.nestjs.appServices");

const STATE_TOKEN = Symbol.for("resultar.nestjs.state");

export interface NestRequestLogger {
  readonly info: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  readonly error: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  readonly warn: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  readonly debug: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  readonly trace: (obj: unknown, msg?: string, ...args: unknown[]) => void;
  readonly fatal: (obj: unknown, msg?: string, ...args: unknown[]) => void;
}

export interface NestRequest extends IncomingMessage {
  id: string;
  signal: AbortSignal;
  services?: unknown;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  log: NestRequestLogger;
  getDecorator: <T = unknown>(name: PropertyKey) => T;
  setDecorator: (name: PropertyKey, value: unknown) => void;
}

export interface NestInjectOptions {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly payload?: string | Buffer | Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface NestInjectResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly rawPayload: Buffer;
  readonly json: <T = unknown>() => T;
}

export interface NestServicesModule<
  App extends object,
  Request extends object,
> extends DynamicModule {
  /** Inference only; no runtime metadata or global NestJS augmentation is installed. */
  readonly serviceTypes?: { readonly app: App; readonly request: Request };
}

export interface NestServicesApplication<App extends object, Request extends object> extends Omit<
  INestApplication,
  "listen"
> {
  /** Inference only; no runtime metadata or global NestJS augmentation is installed. */
  readonly serviceTypes?: { readonly app: App; readonly request: Request };
  readonly services: App;
  readonly server: Server;
  readonly ready: () => Promise<NestServicesApplication<App, Request>>;
  readonly inject: (input: string | NestInjectOptions) => Promise<NestInjectResponse>;
  readonly decorate: (name: PropertyKey, value: unknown) => void;
  readonly hasDecorator: (name: PropertyKey) => boolean;
  readonly getDecorator: <T = unknown>(name: PropertyKey) => T;
  readonly addHook: (name: "preClose", hook: () => void | Promise<void>) => void;
  readonly listen: (
    port: number | string | { readonly port: number | string; readonly host?: string },
    hostname?: string,
  ) => Promise<Server>;
}

export type InferAppServices<Source> = Source extends {
  readonly serviceTypes?: { readonly app: infer App };
}
  ? App
  : Source extends {
        readonly scope: () => ServiceScope<infer Services, infer _E, infer _R, infer _G>;
      }
    ? Services
    : Source extends Promise<infer Resolved>
      ? InferAppServices<Resolved>
      : Source extends (...args: never[]) => infer Created
        ? InferAppServices<Created>
        : never;

export type InferRequestServices<Source> = Source extends {
  readonly serviceTypes?: { readonly request: infer Request };
}
  ? Request
  : Source extends {
        readonly scope: () => ServiceScope<infer Services, infer _E, infer _R, infer _G>;
      }
    ? Services
    : Source extends Promise<infer Resolved>
      ? InferRequestServices<Resolved>
      : Source extends (...args: never[]) => infer Created
        ? InferRequestServices<Created>
        : never;

/** Returns the request-scoped Resultar services attached to an HTTP request, if initialized. */
export function getRequestServices<Services extends object = Readonly<Record<string, unknown>>>(
  request: unknown,
): Services | undefined {
  if (typeof request === "object" && request !== null && "services" in request)
    return (request as { readonly services?: Services }).services;
  return undefined;
}

/** Returns the application-scoped Resultar services (`appBindings`) from a NestJS application. */
export function getAppServices<Services extends object = Readonly<Record<string, unknown>>>(
  app: INestApplicationContext,
): Services | undefined {
  if (typeof app === "object" && app !== null && "services" in app) {
    const decorated = (app as { readonly services?: Services }).services;
    if (decorated !== undefined) return decorated;
  }
  const resolved = tryResult(
    (): unknown => app.get<unknown>(APP_SERVICES, { strict: false }),
    preserveNativeError,
  );
  return resolved.isOk() ? (resolved.value as Services | undefined) : undefined;
}

/** Parameter decorator that extracts the request-scoped Resultar services (or a single key). */
export const Services: <K extends PropertyKey | undefined = undefined>(
  property?: K,
) => ParameterDecorator = createParamDecorator(
  (property: PropertyKey | undefined, context: ExecutionContext): unknown => {
    const request: unknown = context.switchToHttp().getRequest();
    const services = getRequestServices(request);
    if (services === undefined)
      throw new TypeError("Resultar request services are not initialized for this request");
    return property === undefined
      ? services
      : (services as Readonly<Record<PropertyKey, unknown>>)[property];
  },
);

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
export type ModuleSource =
  | ModuleShape
  | ((app: INestApplicationContext) => ModuleShape | Promise<ModuleShape>);
type ModuleOf<M> = M extends (app: INestApplicationContext) => infer Module ? Awaited<Module> : M;
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

interface RequestState {
  readonly controller: AbortController;
  readonly cleanup: () => void;
  session?: ServiceSession;
  completion?: ServiceSession["completion"];
  exposed: boolean;
}

// NestJS owns the external error contract; retain identity, status codes and attached metadata.
const preserveNativeError = (error: unknown): unknown => error;

const requestCleanups = new WeakMap<object, Promise<unknown>>();
const registeredAdapters = new WeakSet<object>();

function closeApplication(
  root: RuntimeScope,
  session?: ServiceSession,
  startup?: ServiceTaskSession,
): ResultAsync<void, AggregateError> {
  // Acquisition failures are reported through ready; singleton finalizers belong to the root.
  const errors: unknown[] = [];
  return (startup?.close() ?? unitAsync())
    .orElse((error) => {
      errors.push(error);
      return unit();
    })
    .andThen(() => session?.finish() ?? unitAsync())
    .andThen(() => fromSafePromise(ResultTask.runExit(root.close())))
    .andThen((exit) => {
      if (exit._tag === "Failure") errors.push(new ResultTaskCauseError(exit.cause));
      return errors.length > 0
        ? err(new AggregateError(errors, "Application service cleanup failed"))
        : unit();
    });
}

function finishRequest(state: RequestState): ResultAsync<void, never> {
  const finished: ResultAsync<unknown, never> = state.session?.finish() ?? unitAsync();
  return finished.andThen(() => state.completion ?? unitAsync()).map(() => state.cleanup());
}

function getRawRequest(request: NestRequest): IncomingMessage {
  const raw = (request as { readonly raw?: IncomingMessage }).raw;
  return raw ?? request;
}

function getRawResponse(response: ServerResponse): ServerResponse {
  const raw = (response as { readonly raw?: ServerResponse }).raw;
  return raw ?? response;
}

function attachRequest(
  request: NestRequest,
  rawRequest: IncomingMessage,
  response: ServerResponse,
  rawResponse: ServerResponse,
  handlerTimeout?: number,
): RequestState {
  const controller = new AbortController();
  const rawSignal = (rawRequest as { readonly signal?: unknown }).signal;
  if (
    !Object.hasOwn(request, "signal") &&
    typeof rawSignal === "object" &&
    rawSignal instanceof AbortSignal
  ) {
    Object.defineProperty(request, "signal", {
      value: rawSignal,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  const externalSignal: AbortSignal | undefined =
    typeof request.signal === "object" && request.signal instanceof AbortSignal
      ? request.signal
      : undefined;
  const onExternalAbort = () => {
    const reason: unknown = externalSignal?.reason;
    // Fastify 5.12 emits a generic abort on IncomingMessage.close, including a fully
    // received body. The response close/error listeners own disconnects after upload.
    if (rawRequest.complete && reason instanceof DOMException && reason.name === "AbortError")
      return;
    controller.abort(reason);
  };
  const onAborted = () => {
    controller.abort(new Error("Request aborted"));
  };
  const onDisconnect = () => {
    if (!rawResponse.writableFinished) controller.abort(new Error("Response connection closed"));
  };
  const onTransportError = (error: Error) => controller.abort(error);
  const timeout =
    handlerTimeout === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(
            new Error(`Request handler timed out after ${String(handlerTimeout)}ms`),
          );
          if (!rawResponse.headersSent && !rawResponse.writableEnded) {
            (response as { readonly hijack?: () => void }).hijack?.();
            rawResponse.statusCode = 503;
            rawResponse.end("Service Unavailable");
          }
          if (!request.signal.aborted) {
            rawRequest.emit("close");
          }
        }, handlerTimeout);

  if (externalSignal === undefined) {
    Object.defineProperty(request, "signal", {
      value: controller.signal,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } else {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal.aborted) onExternalAbort();
  }
  rawRequest.once("aborted", onAborted);
  rawRequest.once("error", onTransportError);
  rawResponse.once("close", onDisconnect);
  rawResponse.once("error", onTransportError);

  return {
    controller,
    exposed: false,
    cleanup: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      rawRequest.removeListener("aborted", onAborted);
      rawRequest.removeListener("error", onTransportError);
      rawResponse.removeListener("close", onDisconnect);
      rawResponse.removeListener("error", onTransportError);
    },
  };
}

function withInitTimeout<T, E>(
  operation: ResultAsync<T, E>,
  timeoutMs: number | undefined,
): ResultAsync<T, E | Error> {
  if (timeoutMs === undefined) return operation;
  return ResultAsync.fromCallback<T, E | Error>({
    subscribe: ({ resolve, reject }) => {
      const timer = setTimeout(() => {
        reject(new Error(`NestJS initialization timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      const settled = operation.match(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
      return () => {
        clearTimeout(timer);
        settled.catch(preserveNativeError);
      };
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

export type LocalsFactory = (request: NestRequest) => object | Promise<object>;

export interface NestServicesOptions {
  readonly name?: string;
  readonly services: ModuleSource;
  /** Defaults to all registered services; [] selects none. Resolved before each handler. */
  readonly bindings?: readonly string[];
  readonly appBindings?: readonly string[];
  /** A one-time application task, run in onApplicationBootstrap after module initialization. */
  readonly startup?:
    | ResultTask<void, unknown, unknown>
    | ((app: INestApplicationContext) => ResultTask<void, unknown, unknown>);
  readonly locals?: LocalsFactory;
  /** Framework facades can expose lazy services in a guard before pipes. Defaults to interceptor. */
  readonly requestHook?: "guard" | "interceptor";
  readonly exposeApplication?: (access: ServiceAccess, app: INestApplicationContext) => object;
  readonly exposeRequest?: (access: ServiceAccess, request: NestRequest) => object;
  /** Adapt native lifecycle failures at a framework facade boundary. */
  readonly mapError?: (error: unknown) => unknown;
  /** Defaults to true. Facades can report rollback errors only at the failed startup boundary. */
  readonly rethrowRollbackOnClose?: boolean;
  /** Optional readiness timeout in milliseconds for module and startup initialization. */
  readonly initTimeout?: number;
  /** Optional per-request handler timeout in milliseconds that aborts request.signal and responds 503. */
  readonly handlerTimeout?: number;
}

export interface NestAppOptions extends NestServicesOptions, NestApplicationOptions {
  /** Optional HTTP adapter instance (defaults to `new FastifyAdapter()`). */
  readonly adapter?: AbstractHttpAdapter;
  readonly controllers?: readonly NonNullable<ModuleMetadata["controllers"]>[number][];
  readonly imports?: readonly NonNullable<ModuleMetadata["imports"]>[number][];
  readonly providers?: readonly NonNullable<ModuleMetadata["providers"]>[number][];
  readonly exports?: readonly NonNullable<ModuleMetadata["exports"]>[number][];
  /** Optional HTTP request ID header name (e.g. "x-request-id") used to populate request.id. */
  readonly requestIdHeader?: string;
}

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
type StartupRequirements<O extends NestServicesOptions> = [
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
type CheckedOptions<O extends NestServicesOptions> = ModuleSource extends O["services"]
  ? unknown
  : {
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
            readonly duplicateServices: Extract<
              keyof LocalValues<O>,
              keyof ServicesOf<O["services"]>
            >;
          });

interface InternalAppHost {
  appContext: INestApplicationContext & {
    readonly decorate: (name: PropertyKey, value: unknown) => void;
    readonly hasDecorator: (name: PropertyKey) => boolean;
    readonly getDecorator: <T = unknown>(name: PropertyKey) => T;
  };
  readonly requestIdHeader?: string;
  readonly logger?: NestApplicationOptions["logger"];
  close?: () => Promise<void>;
  waitForActiveRequests?: () => Promise<void>;
}

interface InternalModuleState {
  readonly appServicesTarget: Record<PropertyKey, unknown>;
  readonly prepareRequest: (context: ExecutionContext) => void;
  readonly initializeRequest: (context: ExecutionContext) => Promise<void>;
  readonly onModuleInit: () => Promise<void>;
  readonly onApplicationBootstrap: () => Promise<void>;
  readonly beforeApplicationShutdown: () => Promise<void>;
  readonly onApplicationShutdown: () => Promise<void>;
}

const noopLog = (): void => {
  /* No-op fallback when a custom HTTP adapter omits request.log. */
};
const fallbackRequestLogger: NestRequestLogger = {
  info: noopLog,
  error: noopLog,
  warn: noopLog,
  debug: noopLog,
  trace: noopLog,
  fatal: noopLog,
};

function logCleanupFailure(
  request: NestRequest,
  failure: ResultTaskCauseError,
  loggerOption?: NestApplicationOptions["logger"],
): void {
  const reqLog = (request as { readonly log?: Partial<NestRequestLogger> }).log;
  if (typeof reqLog?.error === "function") {
    reqLog.error({ err: failure }, "Request service cleanup failed");
  }
  if (
    typeof loggerOption === "object" &&
    loggerOption !== null &&
    !Array.isArray(loggerOption) &&
    "error" in loggerOption &&
    typeof loggerOption.error === "function"
  ) {
    loggerOption.error("Request service cleanup failed", failure);
    return;
  }
  Logger.error("Request service cleanup failed", failure, "ResultarServices");
}

function ensureRequestHelpers(
  request: NestRequest,
  nextRequestId: () => string,
  requestIdHeader?: string,
): void {
  const headerValue =
    requestIdHeader === undefined ? undefined : request.headers[requestIdHeader.toLowerCase()];
  if (typeof headerValue === "string" && headerValue.length > 0) {
    request.id = headerValue;
  } else if (Array.isArray(headerValue) && typeof headerValue[0] === "string") {
    request.id = headerValue[0];
  } else if (typeof request.id !== "string" || request.id.length === 0) {
    request.id = nextRequestId();
  }
  const requestRecord = request as unknown as Record<PropertyKey, unknown>;
  if (typeof requestRecord.log !== "object" || requestRecord.log === null) {
    requestRecord.log = fallbackRequestLogger;
  }
  if (!Object.hasOwn(requestRecord, "getDecorator")) {
    Object.defineProperty(requestRecord, "getDecorator", {
      value: <T = unknown>(name: PropertyKey): T => requestRecord[name] as T,
      writable: true,
      configurable: true,
    });
  }
  if (!Object.hasOwn(requestRecord, "setDecorator")) {
    Object.defineProperty(requestRecord, "setDecorator", {
      value: (name: PropertyKey, value: unknown): void => {
        requestRecord[name] = value;
      },
      writable: true,
      configurable: true,
    });
  }
}

function createModuleState(
  options: NestServicesOptions,
  httpAdapterHost: HttpAdapterHost,
  moduleRef: ModuleRef,
  host?: InternalAppHost,
): InternalModuleState {
  const { exposeApplication, exposeRequest } = options;
  const appServicesTarget: Record<PropertyKey, unknown> = {};
  const activeRequests = new Set<Promise<unknown>>();
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req-${String(requestCounter)}`;
  };

  let root: RuntimeScope | undefined = undefined;
  let resolvedBindings: readonly string[] = options.bindings ?? [];
  const application: {
    session?: ServiceSession;
    startup?: ServiceTaskSession;
    closing?: ResultAsync<void, AggregateError>;
    rolledBack?: boolean;
  } = {};

  const appFacade: INestApplicationContext =
    host?.appContext ??
    ({
      get: (typeOrToken: unknown, getOptions?: { strict?: boolean }): unknown =>
        moduleRef.get<unknown, unknown>(typeOrToken as never, getOptions),
      resolve: (
        typeOrToken: unknown,
        contextId?: unknown,
        resolveOptions?: { strict?: boolean },
      ): Promise<unknown> =>
        moduleRef.resolve<unknown, unknown>(
          typeOrToken as never,
          contextId as never,
          resolveOptions,
        ),
      select: () => appFacade,
      init: () => Promise.resolve(appFacade),
      close: () => Promise.resolve(),
      useLogger: (): boolean => false,
      flushLogs: (): boolean => false,
      enableShutdownHooks: () => appFacade,
    } as unknown as INestApplicationContext);

  const close = (): ResultAsync<void, AggregateError> => {
    if (root === undefined) return unitAsync();
    application.closing ??= closeApplication(root, application.session, application.startup);
    return application.closing;
  };

  const closeAndUnwrap = async (): Promise<void> => {
    const adapter: unknown = httpAdapterHost.httpAdapter;
    if (typeof adapter === "object" && adapter !== null) {
      registeredAdapters.delete(adapter);
    }
    if (application.rolledBack === true && options.rethrowRollbackOnClose === false) return;
    await close()
      .mapErr(options.mapError ?? preserveNativeError)
      .unwrapOrThrow();
  };

  const waitForActiveRequests = async (): Promise<void> => {
    if (activeRequests.size > 0) {
      await Promise.allSettled(activeRequests);
    }
  };

  if (host !== undefined) {
    host.close = closeAndUnwrap;
    host.waitForActiveRequests = waitForActiveRequests;
  }

  const rollback = (error: unknown): ResultAsync<never, unknown> =>
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
      });

  const onModuleInit = async (): Promise<void> => {
    const initResult = tryResultAsync(async () => {
      const source: ModuleSource = options.services;
      const serviceModule = typeof source === "function" ? await source(appFacade) : source;
      resolvedBindings = options.bindings ?? inspectModule(serviceModule).map(({ name }) => name);
      const createdRoot = serviceModule.scope() as RuntimeScope;
      root = createdRoot;
      application.session = startSession((hold) =>
        exposeApplication === undefined
          ? createdRoot.useSingletons(options.appBindings ?? [], hold)
          : useServiceAccess(
              createdRoot,
              (access) => hold(exposeApplication(access, appFacade) as RuntimeServices),
              { application: true, initialize: options.appBindings },
            ),
      );
      return application.session;
    }, preserveNativeError)
      .andThen((session) => session.ready)
      .andThen((appServices) =>
        tryResult(() => {
          if (application.closing !== undefined)
            // Native module initialization failure, not a domain Result error.
            // resultar-check-disable-next-line prefer-tagged-error
            throw new Error("NestJS services closed during initialization");
          const adapter: unknown = httpAdapterHost.httpAdapter;
          if (typeof adapter === "object" && adapter !== null) {
            if (registeredAdapters.has(adapter))
              throw new TypeError(
                "The services decorator is already registered in this NestJS context",
              );
            registeredAdapters.add(adapter);
          }
          if (host !== undefined) {
            if (host.appContext.hasDecorator("services"))
              throw new TypeError(
                "The services decorator is already registered in this NestJS context",
              );
            host.appContext.decorate("services", appServices);
          }
          Object.defineProperties(appServicesTarget, Object.getOwnPropertyDescriptors(appServices));
        }, preserveNativeError),
      )
      .orElse(rollback);

    await withInitTimeout(initResult, options.initTimeout)
      .mapErr(options.mapError ?? preserveNativeError)
      .unwrapOrThrow();
  };

  const onApplicationBootstrap = async (): Promise<void> => {
    if (options.startup === undefined || root === undefined) return;
    const currentRoot = root;
    const startup = ResultTask.gen(function* initializeApplication() {
      const task =
        typeof options.startup === "function" ? options.startup(appFacade) : options.startup;
      if (task !== undefined) yield* task;
    });
    application.startup = startServiceTask(
      (task) => currentRoot.useSingletons([], () => task as RuntimeTask),
      startup,
    );
    await withInitTimeout(application.startup.ready.orElse(rollback), options.initTimeout)
      .mapErr(options.mapError ?? preserveNativeError)
      .unwrapOrThrow();
  };

  const initializeRequest = async (context: ExecutionContext): Promise<void> => {
    if (root === undefined)
      throw new TypeError("Resultar application services are not initialized");
    const currentRoot = root;
    const http = context.switchToHttp();
    const request = http.getRequest<NestRequest>();
    const response = http.getResponse<ServerResponse>();
    const rawRequest = getRawRequest(request);
    const rawResponse = getRawResponse(response);
    ensureRequestHelpers(request, nextRequestId, host?.requestIdHeader);
    if (request.services !== undefined) return;

    const state = attachRequest(request, rawRequest, response, rawResponse, options.handlerTimeout);
    let completed = false;
    const onComplete = (): void => {
      if (completed) return;
      completed = true;
      rawResponse.removeListener("finish", onComplete);
      rawResponse.removeListener("close", onComplete);
      const cleanupPromise = Promise.resolve(finishRequest(state)).finally(() => {
        activeRequests.delete(cleanupPromise);
      });
      requestCleanups.set(rawRequest, cleanupPromise);
      activeRequests.add(cleanupPromise);
    };
    rawResponse.once("finish", onComplete);
    rawResponse.once("close", onComplete);

    return (
      tryResultAsync(async () => (await options.locals?.(request)) ?? {}, preserveNativeError)
        .andThen((locals) =>
          tryResult(() => {
            state.controller.signal.throwIfAborted();
            const scope = currentRoot.withServices(locals);
            const session = startSession(
              (hold) =>
                exposeRequest === undefined
                  ? scope.use(resolvedBindings, hold)
                  : useServiceAccess(
                      scope,
                      (access) => hold(exposeRequest(access, request) as RuntimeServices),
                      { initialize: resolvedBindings },
                    ),
              state.controller.signal,
            );
            state.session = session;
            state.completion = session.completion
              .map((exit) => {
                state.cleanup();
                return exit;
              })
              .inspect((exit) => {
                if (state.exposed && exit._tag === "Failure" && hasFailure(exit.cause)) {
                  logCleanupFailure(request, new ResultTaskCauseError(exit.cause), host?.logger);
                }
              });
            return session;
          }, preserveNativeError),
        )
        .andThen((session) => session.ready)
        .andThen((services) =>
          tryResult(() => {
            request.services = services;
            state.exposed = true;
          }, preserveNativeError),
        )
        .orElse((error) => {
          completed = true;
          rawResponse.removeListener("finish", onComplete);
          rawResponse.removeListener("close", onComplete);
          return finishRequest(state).andThen(() => err(error));
        })
        // NestJS's exception filter layer receives the original failure after cleanup.
        .mapErr(options.mapError ?? preserveNativeError)
        .unwrapOrThrow()
    );
  };

  const prepareRequest = (context: ExecutionContext): void => {
    const request = context.switchToHttp().getRequest<NestRequest>();
    ensureRequestHelpers(request, nextRequestId, host?.requestIdHeader);
  };

  return {
    appServicesTarget,
    prepareRequest,
    initializeRequest,
    onModuleInit,
    onApplicationBootstrap,
    beforeApplicationShutdown: waitForActiveRequests,
    onApplicationShutdown: closeAndUnwrap,
  };
}

function buildNestModule(options: NestServicesOptions, host?: InternalAppHost): DynamicModule {
  @Module({})
  class ResultarNestModule {}

  const hookType = options.requestHook ?? "interceptor";
  const requestHookProviders =
    hookType === "guard"
      ? [
          {
            provide: APP_GUARD,
            useFactory: (state: InternalModuleState): CanActivate => ({
              canActivate: async (context: ExecutionContext): Promise<boolean> => {
                await state.initializeRequest(context);
                return true;
              },
            }),
            inject: [STATE_TOKEN],
          },
        ]
      : [
          {
            provide: APP_GUARD,
            useFactory: (state: InternalModuleState): CanActivate => ({
              canActivate: (context: ExecutionContext): boolean => {
                state.prepareRequest(context);
                return true;
              },
            }),
            inject: [STATE_TOKEN],
          },
          {
            provide: APP_INTERCEPTOR,
            useFactory: (state: InternalModuleState): NestInterceptor => ({
              intercept: (context: ExecutionContext, next: CallHandler): Observable<unknown> =>
                from(state.initializeRequest(context)).pipe(switchMap(() => next.handle())),
            }),
            inject: [STATE_TOKEN],
          },
        ];

  return {
    global: true,
    module: ResultarNestModule,
    providers: [
      {
        provide: STATE_TOKEN,
        useFactory: (httpAdapterHost: HttpAdapterHost, moduleRef: ModuleRef) =>
          createModuleState(options, httpAdapterHost, moduleRef, host),
        inject: [HttpAdapterHost, ModuleRef],
      },
      {
        provide: APP_SERVICES,
        useFactory: (state: InternalModuleState) => state.appServicesTarget,
        inject: [STATE_TOKEN],
      },
      ...requestHookProviders,
    ],
    exports: [APP_SERVICES],
  };
}

/** Registers native NestJS services backed by one Resultar DI root. */
export function createNestModule<const Options extends NestServicesOptions>(
  options: Options & CheckedOptions<NoInfer<Options>>,
): NestServicesModule<
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
  return buildNestModule(options);
}

function normalizeInjectHeaders(
  inputHeaders: NestInjectOptions["headers"],
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  if (inputHeaders === undefined) return headers;
  for (const [key, value] of Object.entries(inputHeaders)) {
    if (value !== undefined) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
    }
  }
  return headers;
}

function encodeInjectPayload(
  payload: unknown,
  headers: Record<string, string | string[]>,
): Buffer | undefined {
  if (payload === undefined) return undefined;
  let bodyBuffer: Buffer | undefined = undefined;
  if (Buffer.isBuffer(payload)) {
    bodyBuffer = payload;
  } else if (typeof payload === "string") {
    bodyBuffer = Buffer.from(payload, "utf8");
  } else {
    bodyBuffer = Buffer.from(JSON.stringify(payload), "utf8");
    headers["content-type"] ??= "application/json";
  }
  headers["content-length"] ??= String(bodyBuffer.byteLength);
  return bodyBuffer;
}

function appendResponseChunk(chunks: Buffer[], chunk: unknown, encodingOrCallback: unknown): void {
  if (Buffer.isBuffer(chunk)) {
    chunks.push(chunk);
  } else if (typeof chunk === "string") {
    chunks.push(
      Buffer.from(
        chunk,
        typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : "utf8",
      ),
    );
  }
}

function collectResponseHeaders(res: ServerResponse): IncomingHttpHeaders {
  const responseHeaders: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(res.getHeaders())) {
    if (typeof value === "number") {
      responseHeaders[key] = String(value);
    } else if (Array.isArray(value)) {
      responseHeaders[key] = value.map(String);
    } else {
      responseHeaders[key] = value;
    }
  }
  return responseHeaders;
}

async function dispatchInject(
  httpServer: Server,
  input: string | NestInjectOptions,
): Promise<NestInjectResponse> {
  const options: NestInjectOptions = typeof input === "string" ? { url: input } : input;
  const headers = normalizeInjectHeaders(options.headers);
  const bodyBuffer = encodeInjectPayload(options.payload, headers);

  const reqSocket = new PassThrough() as unknown as Socket;
  (reqSocket as unknown as { remoteAddress: string }).remoteAddress = "127.0.0.1";
  const req = new IncomingMessage(reqSocket);
  req.method = (options.method ?? "GET").toUpperCase();
  req.url = options.url;
  req.headers = headers;
  if (options.signal !== undefined) {
    (req as unknown as { signal: AbortSignal }).signal = options.signal;
  }

  const res = new ServerResponse(req);
  res.assignSocket(new PassThrough() as unknown as Socket);

  const chunks: Buffer[] = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = ((
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean => {
    appendResponseChunk(chunks, chunk, encodingOrCallback);
    return origWrite(chunk, encodingOrCallback as never, callback as never);
  }) as typeof res.write;

  res.end = ((
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse => {
    appendResponseChunk(chunks, chunk, encodingOrCallback);
    return origEnd(chunk as never, encodingOrCallback as never, callback as never);
  }) as typeof res.end;

  const responseFinished = new Promise<void>((resolve) => {
    res.once("finish", resolve);
    res.once("close", resolve);
  });

  httpServer.emit("request", req, res);
  if (bodyBuffer !== undefined) {
    req.push(bodyBuffer);
  }
  // eslint-disable-next-line unicorn/no-null -- Node.js Readable stream EOF requires null.
  req.push(null);

  await responseFinished;
  const cleanupPromise = requestCleanups.get(req);
  if (cleanupPromise !== undefined) {
    await cleanupPromise;
  }

  const rawPayload = Buffer.concat(chunks);
  const body = rawPayload.toString("utf8");

  return {
    statusCode: res.statusCode,
    headers: collectResponseHeaders(res),
    body,
    rawPayload,
    json: <T = unknown>(): T => JSON.parse(body) as T,
  };
}

/** Creates a native NestJS application backed by one Resultar DI root. */
export function createNestApp<const Options extends NestAppOptions>(
  options: Options & CheckedOptions<NoInfer<Options>>,
  configure?: (
    app: NestServicesApplication<
      InferAppServices<ReturnType<typeof createNestModule<Options>>>,
      InferRequestServices<ReturnType<typeof createNestModule<Options>>>
    >,
  ) => void | Promise<void>,
): NestServicesApplication<
  InferAppServices<ReturnType<typeof createNestModule<Options>>>,
  InferRequestServices<ReturnType<typeof createNestModule<Options>>>
> {
  type App = InferAppServices<ReturnType<typeof createNestModule<Options>>>;
  type Request = InferRequestServices<ReturnType<typeof createNestModule<Options>>>;
  type Application = NestServicesApplication<App, Request>;

  const appOptions: NestAppOptions = options;
  const {
    adapter: customAdapter,
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
    initTimeout,
    handlerTimeout,
    controllers,
    imports,
    providers,
    exports: moduleExports,
    requestIdHeader,
    ...nestOptions
  } = appOptions;

  const effectiveNestOptions: NestApplicationOptions = {
    logger: false,
    ...nestOptions,
    abortOnError: false,
  };

  const adapter: AbstractHttpAdapter =
    customAdapter ??
    new FastifyAdapter(
      requestIdHeader === undefined
        ? undefined
        : { requestIdHeader: requestIdHeader.toLowerCase() },
    );
  adapter.initHttpServer(effectiveNestOptions);
  const httpServer = adapter.getHttpServer() as Server;
  adapter.initHttpServer = () => {
    adapter.setHttpServer(httpServer);
  };

  const decorators = new Map<PropertyKey, unknown>();
  const preCloseHooks: (() => void | Promise<void>)[] = [];
  const pendingOperations: ((nestApp: INestApplication) => void)[] = [];

  let nestApp: INestApplication | undefined = undefined;
  let initializationPromise: Promise<Application> | undefined = undefined;
  let closingPromise: Promise<void> | undefined = undefined;

  const host: InternalAppHost = {
    appContext: undefined as unknown as InternalAppHost["appContext"],
    requestIdHeader,
    logger: nestOptions.logger,
  };

  const servicesModule = buildNestModule(
    {
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
      initTimeout,
      handlerTimeout,
    },
    host,
  );

  @Module({
    imports: [servicesModule, ...(imports ?? [])],
    controllers: [...(controllers ?? [])],
    providers: [...(providers ?? [])],
    exports: [...(moduleExports ?? [])],
  })
  class ResultarRootApplicationModule {}

  let configurePromise: Promise<void> | undefined = undefined;

  const ensureReady = (): Promise<Application> => {
    initializationPromise ??= (async (): Promise<Application> => {
      if (configurePromise !== undefined) {
        await configurePromise;
      }
      const created = await NestFactory.create(
        ResultarRootApplicationModule,
        adapter,
        effectiveNestOptions,
      );
      nestApp = created;
      for (const operation of pendingOperations) {
        operation(created);
      }
      pendingOperations.length = 0;
      await created.init();
      const instance = adapter.getInstance() as
        | { readonly ready?: () => PromiseLike<unknown> }
        | undefined;
      if (typeof instance?.ready === "function") {
        await instance.ready();
      }
      return application;
    })();
    return initializationPromise;
  };

  const queueOrRun = (operation: (instance: INestApplication) => void): Application => {
    if (nestApp === undefined) {
      pendingOperations.push(operation);
    } else {
      operation(nestApp);
    }
    return application;
  };

  const application: Application = {
    get services(): App {
      return (decorators.get("services") ?? {}) as App;
    },
    get server(): Server {
      return httpServer;
    },
    decorate(decoratorName: PropertyKey, value: unknown): void {
      decorators.set(decoratorName, value);
    },
    hasDecorator(decoratorName: PropertyKey): boolean {
      return decorators.has(decoratorName);
    },
    getDecorator<T = unknown>(decoratorName: PropertyKey): T {
      return decorators.get(decoratorName) as T;
    },
    addHook(hookName: "preClose", hook: () => void | Promise<void>): void {
      if (hookName === "preClose") preCloseHooks.push(hook);
    },
    ready(): Promise<Application> {
      return ensureReady();
    },
    async init(): Promise<Application> {
      return ensureReady();
    },
    async inject(input: string | NestInjectOptions): Promise<NestInjectResponse> {
      await ensureReady();
      return dispatchInject(httpServer, input);
    },
    getHttpAdapter(): AbstractHttpAdapter {
      return adapter;
    },
    getHttpServer(): Server {
      return httpServer;
    },
    get<TInput = unknown, TResult = TInput>(
      typeOrToken: TInput,
      getOptions?: { strict?: boolean; each?: boolean },
    ): TResult {
      if (typeOrToken === APP_SERVICES) {
        return (decorators.get("services") ?? {}) as TResult;
      }
      if (nestApp === undefined)
        throw new Error("NestJS application has not been initialized yet; await app.ready() first");
      return nestApp.get(typeOrToken as never, getOptions as never);
    },
    async resolve<TInput = unknown, TResult = TInput>(
      typeOrToken: TInput,
      contextId?: unknown,
      resolveOptions?: { strict?: boolean; each?: boolean },
    ): Promise<TResult> {
      await ensureReady();
      if (nestApp === undefined) return undefined as TResult;
      return nestApp.resolve<TInput, TResult>(
        typeOrToken as never,
        contextId as never,
        resolveOptions as never,
      );
    },
    select<T>(moduleType: T, selectOptions?: unknown): INestApplicationContext {
      if (nestApp === undefined) return application;
      return nestApp.select(moduleType as never, selectOptions as never);
    },
    use(...args: unknown[]): Application {
      adapter.use(...(args as [never]));
      return application;
    },
    enableCors(corsOptions?: unknown): void {
      adapter.enableCors(corsOptions);
    },
    enableVersioning(versioningOptions?: unknown): Application {
      return queueOrRun((instance) => {
        instance.enableVersioning(versioningOptions as never);
      });
    },
    setGlobalPrefix(prefix: string, prefixOptions?: unknown): Application {
      return queueOrRun((instance) => {
        instance.setGlobalPrefix(prefix, prefixOptions as never);
      });
    },
    useGlobalPipes(...pipes: unknown[]): Application {
      return queueOrRun((instance) => {
        instance.useGlobalPipes(...(pipes as never[]));
      });
    },
    useGlobalInterceptors(...interceptors: unknown[]): Application {
      return queueOrRun((instance) => {
        instance.useGlobalInterceptors(...(interceptors as never[]));
      });
    },
    useGlobalGuards(...guards: unknown[]): Application {
      return queueOrRun((instance) => {
        instance.useGlobalGuards(...(guards as never[]));
      });
    },
    useGlobalFilters(...filters: unknown[]): Application {
      return queueOrRun((instance) => {
        instance.useGlobalFilters(...(filters as never[]));
      });
    },
    useBodyParser(...args: unknown[]): Application {
      return queueOrRun((instance) => {
        (instance as unknown as { useBodyParser: (...a: unknown[]) => void }).useBodyParser(
          ...args,
        );
      });
    },
    useLogger(logger: unknown): void {
      queueOrRun((instance) => {
        instance.useLogger(logger as never);
      });
    },
    flushLogs(): void {
      nestApp?.flushLogs();
    },
    enableShutdownHooks(signals?: unknown, shutdownOptions?: unknown): Application {
      return queueOrRun((instance) => {
        instance.enableShutdownHooks(signals as never, shutdownOptions as never);
      });
    },
    async listen(
      portOrOptions: number | string | { readonly port: number | string; readonly host?: string },
      ...args: unknown[]
    ): Promise<Server> {
      await ensureReady();
      if (nestApp === undefined) return httpServer;
      if (typeof portOrOptions === "object" && portOrOptions !== null) {
        return (
          portOrOptions.host === undefined
            ? await nestApp.listen(portOrOptions.port)
            : await nestApp.listen(portOrOptions.port, portOrOptions.host)
        ) as Server;
      }
      return (await nestApp.listen(portOrOptions, ...(args as never[]))) as Server;
    },
    async getUrl(): Promise<string> {
      if (nestApp === undefined)
        throw new Error("NestJS application is not listening; call app.listen() first");
      return nestApp.getUrl();
    },
    async close(): Promise<void> {
      closingPromise ??= (async (): Promise<void> => {
        let hookChain = Promise.resolve();
        for (const hook of preCloseHooks) {
          hookChain = hookChain.then(async () => {
            await hook();
          });
        }
        await hookChain;
        await host.waitForActiveRequests?.();
        let cleanupError: unknown = undefined;
        const cleanupResult = await tryResultAsync(async () => {
          await host.close?.();
        }, preserveNativeError);
        if (cleanupResult.isErr()) {
          cleanupError = cleanupResult.error;
        }
        await tryResultAsync(async () => {
          await (nestApp === undefined ? adapter.close() : nestApp.close());
        }, preserveNativeError);
        if (cleanupError !== undefined) {
          err(cleanupError).unwrapOrThrow();
        }
      })();
      return closingPromise;
    },
  } as unknown as Application;

  host.appContext = application as unknown as InternalAppHost["appContext"];

  if (configure !== undefined) {
    const maybePromise = configure(application);
    if (maybePromise instanceof Promise) {
      configurePromise = maybePromise;
    }
  }

  return application;
}
