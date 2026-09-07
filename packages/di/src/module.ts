import { ResultTask, type Exit, type ResultTaskScope, type ServiceTag } from "resultar";

import { runScopedResponse } from "./fetch.js";
import type { ServiceClass } from "./service.js";

export type ServiceLifetime = "singleton" | "scoped" | "transient";

export interface ServiceRegistrationOptions {
  readonly lifetime?: ServiceLifetime;
}

type Entry<E, R, Dependencies extends string> = {
  readonly error: E;
  readonly requirements: R;
  readonly dependencies: Dependencies;
};
type Graph = Readonly<Record<string, Entry<unknown, unknown, string>>>;
type TagNames<R> = R extends ServiceTag<infer Name, unknown> ? Name : never;
type Reach<
  G extends Graph,
  Keys extends string,
  Seen extends string = never,
  Depth extends readonly unknown[] = [],
> = [Exclude<Extract<Keys, keyof G>, Seen>] extends [never]
  ? Seen
  : Depth["length"] extends 8
    ? Extract<keyof G, string>
    : Reach<
        G,
        | G[Exclude<Extract<Keys, keyof G>, Seen>]["dependencies"]
        | TagNames<G[Exclude<Extract<Keys, keyof G>, Seen>]["requirements"]>,
        Seen | Extract<Keys, keyof G>,
        [...Depth, unknown]
      >;
type SelectedE<G extends Graph, Keys extends string, Fallback> = string extends keyof G
  ? Fallback
  : G[Extract<Reach<G, Keys>, keyof G>]["error"];
type SelectedR<G extends Graph, Keys extends string, Fallback> = string extends keyof G
  ? Fallback
  : G[Extract<Reach<G, Keys>, keyof G>]["requirements"];

type ScopeError<R> = R extends ResultTaskScope<infer E> ? E : never;
type WithoutScope<R> = Exclude<R, ResultTaskScope<unknown>>;
type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
type LiteralName<Name extends string> = string extends Name
  ? never
  : IsUnion<Name> extends true
    ? never
    : Name;
type NewName<Services, Name extends string> = LiteralName<Name> &
  (Extract<Name, keyof Services> extends never
    ? unknown
    : {
        readonly duplicateService: `Service "${Extract<Name, keyof Services & string>}" is already registered; use override() to replace it`;
      });
type LiteralKeys<Keys extends readonly string[]> =
  IsUnion<Keys> extends true
    ? never
    : number extends Keys["length"]
      ? never
      : { readonly [Index in keyof Keys]: LiteralName<Keys[Index]> };
type SyncValue<A> = A extends PromiseLike<unknown> | ResultTask<unknown, unknown, unknown>
  ? never
  : A;
type KeysOf<Services> = Extract<keyof Services, string>;
type RegisteredServiceRequirements<R, Services> =
  R extends ServiceTag<infer Identifier, infer Contract>
    ? Identifier extends KeysOf<Services>
      ? Services[Identifier] extends Contract
        ? never
        : R
      : R
    : R;
type IncompatibleRequirements<R, Services> =
  R extends ServiceTag<infer Identifier, infer Contract>
    ? Identifier extends keyof Services
      ? Services[Identifier] extends Contract
        ? never
        : Identifier
      : never
    : never;
type CheckRequirements<R, Services> = [IncompatibleRequirements<R, Services>] extends [never]
  ? unknown
  : {
      readonly incompatibleServices: {
        readonly [Name in IncompatibleRequirements<R, Services>]: {
          readonly expected: Extract<R, ServiceTag<Name, unknown>> extends ServiceTag<
            Name,
            infer Contract
          >
            ? Contract
            : never;
          readonly received: Name extends keyof Services ? Services[Name] : never;
        };
      };
    };
type RemainingRequirements<R, Services> = RegisteredServiceRequirements<WithoutScope<R>, Services>;

type DependencyParameter<
  Keys extends readonly string[],
  Args extends readonly unknown[],
> = Keys extends readonly []
  ? unknown
  : Args extends readonly []
    ? { readonly dependencyParameterRequired: Keys[number] }
    : unknown;

type RegisterSync<Services extends object, E, R, G extends Graph, Primary extends boolean> = <
  const Name extends string,
  const Keys extends readonly KeysOf<Services>[],
  Create extends (services: Readonly<Pick<Services, Keys[number]>>) => unknown,
>(
  name: Name & NewName<Services, Name>,
  dependencies: Keys & LiteralKeys<Keys>,
  create: Create &
    DependencyParameter<Keys, Parameters<Create>> &
    ((services: Readonly<Pick<Services, Keys[number]>>) => SyncValue<ReturnType<Create>>),
) => ModuleFor<
  Services & Readonly<Record<Name, ReturnType<Create>>>,
  E,
  R,
  G & Record<Name, Entry<never, never, Keys[number]>>,
  Primary
>;

type RegisterClass<Services extends object, E, R, G extends Graph, Primary extends boolean> = <
  Self,
  const Identifier extends string,
  ServiceError = never,
  ServiceR = never,
>(
  service: ServiceClass<Self, Identifier, ServiceError, ServiceR> &
    CheckRequirements<NoInfer<ServiceR>, Services> & {
      readonly identifier: Identifier & NewName<Services, Identifier>;
    },
) => ModuleFor<
  Services & Readonly<Record<Identifier, Self>>,
  E | ServiceError,
  R | ServiceR,
  G & Record<Identifier, Entry<ServiceError, ServiceR, never>>,
  Primary
>;

type RegisterLifetime<
  Services extends object,
  E,
  R,
  G extends Graph,
  Primary extends boolean,
> = (Primary extends true ? unknown : RegisterSync<Services, E, R, G, Primary>) &
  RegisterClass<Services, E, R, G, Primary>;

type UseTask<Services extends object, E, R, G extends Graph> = <
  const Keys extends readonly KeysOf<Services>[],
  A,
  UseError = never,
  UseR = never,
>(
  dependencies: Keys & LiteralKeys<Keys>,
  use: ((services: Readonly<Pick<Services, Keys[number]>>) => ResultTask<A, UseError, UseR>) &
    CheckRequirements<
      SelectedR<G, Keys[number] | TagNames<NoInfer<UseR>>, R> | NoInfer<UseR>,
      Services
    >,
) => ResultTask<
  A,
  | SelectedE<G, Keys[number] | TagNames<UseR>, E>
  | UseError
  | ScopeError<SelectedR<G, Keys[number] | TagNames<UseR>, R> | UseR>,
  RemainingRequirements<SelectedR<G, Keys[number] | TagNames<UseR>, R> | UseR, Services>
>;

/** A long-lived root. Each `use` call runs in a child scope and closes that child afterwards. */
export interface ServiceScope<
  Services extends object,
  E = never,
  R = never,
  G extends Graph = Graph,
> {
  readonly use: UseTask<Services, E, R, G>;
  /** Fetch-compatible handler. Its child remains open through response-body consumption. */
  readonly fetch: <const Keys extends readonly KeysOf<Services>[]>(
    dependencies: Keys & LiteralKeys<Keys>,
    handle: ((
      services: Readonly<Pick<Services, Keys[number]>>,
      request: Request,
    ) => Response | Promise<Response>) &
      ([RemainingRequirements<SelectedR<G, Keys[number], R>, Services>] extends [never]
        ? unknown
        : {
            readonly missingServices: RemainingRequirements<
              SelectedR<G, Keys[number], R>,
              Services
            >;
          }),
  ) => (request: Request) => Promise<Response>;
  /** Closes singleton resources owned by this root. Repeated calls are no-ops. */
  readonly close: () => ResultTask<void, ScopeError<R>>;
  /** Supplies immutable request-local values. Each use still owns a fresh child. */
  readonly withServices: <const Local extends object>(
    values: Local &
      Readonly<Record<Extract<keyof Local, keyof Services>, never>> &
      CheckRequirements<R, Local>,
  ) => ServiceScope<Services & Local, E, R, G>;
}

export interface HttpApplication {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly request: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

/** Immutable dependency composition with explicit creation and lifetime policies. */
export interface ServiceModule<
  Services extends object,
  E = never,
  R = never,
  G extends Graph = Graph,
  Primary extends boolean = false,
> {
  /** Acquires a Fetch application with one owned root and a fresh scope per response. */
  readonly http: <const Keys extends readonly KeysOf<Services>[]>(
    dependencies: Keys & LiteralKeys<Keys>,
    handle: ((
      services: Readonly<Pick<Services, Keys[number]>>,
      request: Request,
    ) => Response | Promise<Response>) &
      ([RemainingRequirements<SelectedR<G, Keys[number], R>, Services>] extends [never]
        ? unknown
        : {
            readonly missingServices: RemainingRequirements<
              SelectedR<G, Keys[number], R>,
              Services
            >;
          }),
  ) => ResultTask<HttpApplication, never, ResultTaskScope<ScopeError<R>>>;

  /** Combines immutable modules; duplicate names are rejected. */
  readonly merge: <Other extends object, OtherE, OtherR, OtherG extends Graph>(
    module: ModuleFor<Other, OtherE, OtherR, OtherG, Primary> &
      (Extract<keyof Services, keyof Other> extends never
        ? unknown
        : { readonly duplicateServices: Extract<keyof Services, keyof Other> }),
  ) => ModuleFor<Services & Other, E | OtherE, R | OtherR, G & OtherG, Primary>;

  /** Shares an externally owned value across all scopes. The module never disposes it. */
  readonly value: <const Name extends string, A>(
    name: Name & NewName<Services, Name>,
    value: A,
  ) => ModuleFor<
    Services & Readonly<Record<Name, A>>,
    E,
    R,
    G & Record<Name, Entry<never, never, never>>,
    Primary
  >;

  /** Creates once per root. Token tasks retain their finalizers until root close. */
  readonly singleton: RegisterLifetime<Services, E, R, G, Primary>;

  /** Creates once per child. Token tasks retain their finalizers until child close. */
  readonly scoped: RegisterLifetime<Services, E, R, G, Primary>;

  /** Creates on every resolution. Token finalizers belong to the requesting scope. */
  readonly transient: RegisterLifetime<Services, E, R, G, Primary>;

  /** Initializes on demand with a ResultTask. Defaults to `scoped`. */
  readonly task: <
    const Name extends string,
    const Keys extends readonly KeysOf<Services>[],
    A,
    TaskError = never,
    TaskR = never,
  >(
    name: Name & NewName<Services, Name>,
    dependencies: Keys & LiteralKeys<Keys>,
    create: (services: Readonly<Pick<Services, Keys[number]>>) => ResultTask<A, TaskError, TaskR>,
    options?: ServiceRegistrationOptions,
  ) => ModuleFor<
    Services & Readonly<Record<Name, A>>,
    E | TaskError,
    R | TaskR,
    G & Record<Name, Entry<TaskError, TaskR, Keys[number]>>,
    Primary
  >;

  /** Acquires on demand and registers release with the selected lifetime owner. */
  readonly resource: <
    const Name extends string,
    const Keys extends readonly KeysOf<Services>[],
    A,
    AcquireError = never,
    AcquireR = never,
    ReleaseError = never,
    ReleaseR = never,
  >(
    name: Name & NewName<Services, Name>,
    dependencies: Keys & LiteralKeys<Keys>,
    options: ServiceRegistrationOptions & {
      readonly acquire: (
        services: Readonly<Pick<Services, Keys[number]>>,
      ) => ResultTask<A, AcquireError, AcquireR>;
      readonly release: (
        resource: A,
        exit: Exit<unknown, unknown>,
        services: Readonly<Pick<Services, Keys[number]>>,
      ) => ResultTask<void, ReleaseError, ReleaseR>;
    },
  ) => ModuleFor<
    Services & Readonly<Record<Name, A>>,
    E | AcquireError,
    R | AcquireR | WithoutScope<ReleaseR> | ResultTaskScope<ReleaseError | ScopeError<ReleaseR>>,
    G &
      Record<
        Name,
        Entry<
          AcquireError,
          AcquireR | WithoutScope<ReleaseR> | ResultTaskScope<ReleaseError | ScopeError<ReleaseR>>,
          Keys[number]
        >
      >,
    Primary
  >;

  /** Returns a new module with a typed, externally owned replacement. */
  readonly override: <const Name extends KeysOf<Services>>(
    name: Name & LiteralName<Name>,
    value: Services[Name],
  ) => ModuleFor<
    Services,
    SelectedE<Omit<G, Name>, Extract<keyof G, string>, E>,
    SelectedR<Omit<G, Name>, Extract<keyof G, string>, R>,
    Omit<G, Name> & Record<Name, Entry<never, never, never>>,
    Primary
  >;

  /** Runs one isolated root and closes all of its resources when the callback finishes. */
  readonly use: UseTask<Services, E, R, G>;

  /** Opens a long-lived root. Call `scope.close()` during application shutdown. */
  readonly scope: () => ServiceScope<Services, E, R, G>;
}

/** Token-first public surface; fluent operations preserve the selected API. */
export type ModuleFor<
  S extends object,
  E,
  R,
  G extends Graph,
  Primary extends boolean,
> = Primary extends true
  ? Omit<ServiceModule<S, E, R, G, Primary>, "task" | "resource">
  : ServiceModule<S, E, R, G, Primary>;

export type PrimaryServiceModule<
  S extends object,
  E = never,
  R = never,
  G extends Graph = Graph,
> = ModuleFor<S, E, R, G, true>;

type RuntimeServices = Readonly<Record<string, unknown>>;
type RuntimeTask<A = unknown, E = unknown, R = never> = ResultTask<A, E, R>;

const succeedVoid = (): RuntimeTask<void, never, never> => ResultTask.succeed(globalThis.undefined);

interface Definition {
  readonly dependencies: readonly string[];
  readonly lifetime: ServiceLifetime;
  readonly create: (services: RuntimeServices, owner: RuntimeScope) => RuntimeTask;
}
type Definitions = ReadonlyMap<string, Definition>;

const lifetimeRank: Record<ServiceLifetime, number> = { transient: 0, scoped: 1, singleton: 2 };

const validateKeys = (definitions: Definitions, keys: readonly string[]): void => {
  for (const key of keys) {
    if (!definitions.has(key)) throw new TypeError(`Unknown service: ${key}`);
  }
};

const register = (definitions: Definitions, name: string, definition: Definition): Definitions => {
  if (definitions.has(name)) throw new TypeError(`Service already registered: ${name}`);
  validateKeys(definitions, definition.dependencies);
  return new Map([...definitions, [name, definition]]);
};

const makeDefinition = (
  dependencies: readonly string[],
  create: Definition["create"],
  lifetime: ServiceLifetime = "scoped",
): Definition => ({ dependencies, create, lifetime });

const die = (cause: unknown): RuntimeTask<never> =>
  ResultTask.sync(() => {
    throw cause;
  });

class RuntimeScope {
  public readonly cache = new Map<string, unknown>();
  private readonly tasks = new Map<string, Resolution>();
  private readonly resources = ResultTask.makeScope();
  private readonly children = new Set<Promise<void>>();
  private readonly localNames = new Set<string>();
  private finished: (() => void) | undefined;
  private closed = false;
  private disposing = false;

  public constructor(
    private readonly definitions: Definitions,
    private readonly parent?: RuntimeScope,
  ) {}

  public get root(): RuntimeScope {
    return this.parent === undefined ? this : this.parent.root;
  }

  public child(locals: RuntimeServices = {}): RuntimeScope {
    if (this.closed) throw new TypeError("Cannot create a child from a closed service scope");
    const definitions = new Map(this.definitions);
    for (const [name, value] of Object.entries(locals)) {
      if (definitions.has(name))
        throw new TypeError(`Local service duplicates registration: ${name}`);
      this.root.localNames.add(name);
      definitions.set(
        name,
        makeDefinition([], () => ResultTask.succeed(value), "scoped"),
      );
    }
    const child = new RuntimeScope(definitions, this);
    const completion = new Promise<void>((resolve) => {
      child.finished = resolve;
    });
    this.children.add(completion);
    // eslint-disable-next-line no-void
    void completion.then(() => this.children.delete(completion));
    return child;
  }

  public validate(keys: readonly string[]): void {
    validateKeys(this.definitions, keys);
  }

  public bind(
    task: RuntimeTask<unknown, unknown, unknown>,
    requestedBy?: ServiceLifetime,
    path: readonly Resolution[] = [],
  ): RuntimeTask {
    const resolvers = Object.fromEntries(
      [...new Set([...this.definitions.keys(), ...this.root.localNames])].map((key) => [
        key,
        () => this.resolve(key, requestedBy, path),
      ]),
    );
    // Runtime erasure is confined to the adapter; the public module checks service contracts.
    const serviceTask = task as unknown as ResultTask<
      unknown,
      unknown,
      ServiceTag<string, unknown>
    >;
    return ResultTask.provideServiceResolver(serviceTask, resolvers);
  }

  public resolve(
    key: string,
    requestedBy?: ServiceLifetime,
    path: readonly Resolution[] = [],
  ): RuntimeTask {
    return ResultTask.gen(
      function* resolveOnExecution(this: RuntimeScope) {
        return yield* this.resolveNow(key, requestedBy, path);
      }.bind(this),
    );
  }

  private resolveNow(
    key: string,
    requestedBy: ServiceLifetime | undefined,
    path: readonly Resolution[],
  ): RuntimeTask {
    const definition = this.definitions.get(key);
    if (definition === undefined)
      return die(
        new TypeError(
          `Unknown service: ${key}. Resolution path: ${[...path.map((node) => node.name), key].join(" -> ")}. Register the service or supply it with withServices().`,
        ),
      );
    if (
      requestedBy !== undefined &&
      lifetimeRank[requestedBy] > lifetimeRank[definition.lifetime]
    ) {
      return die(
        new TypeError(
          `Lifetime violation: ${requestedBy} service "${path.at(-1)?.name ?? "unknown"}" cannot depend on shorter-lived ${definition.lifetime} service "${key}". Resolution path: ${[...path.map((node) => node.name), key].join(" -> ")}. Align their lifetimes or pass request data to a service method.`,
        ),
      );
    }

    const owner = this.ownerFor(definition.lifetime);
    if (owner !== undefined && owner.cache.has(key)) {
      return ResultTask.succeed(owner.cache.get(key));
    }
    if (this.disposing || this.root.disposing)
      return die(new TypeError("Cannot resolve from a closed service scope"));

    const scope = owner ?? this;
    let resolution = owner?.tasks.get(key);
    if (resolution === undefined) {
      const node: Resolution = { name: key, dependencies: new Set(), task: succeedVoid() };
      const nextPath = [...path, node];
      const work = ResultTask.gen(function* initializeService() {
        node.dependencies.clear();
        const dependencies = yield* scope.resolveMany(
          definition.dependencies,
          definition.lifetime,
          nextPath,
        );
        const value = yield* scope.bind(
          definition.create(dependencies, scope),
          definition.lifetime,
          nextPath,
        );
        owner?.cache.set(key, value);
        return value;
      });
      node.task = scope.resources.use(ResultTask.memoize(work));
      resolution = node;
      owner?.tasks.set(key, node);
    }
    const parent = path.at(-1);
    if (parent !== undefined) {
      if (reaches(resolution, parent)) {
        return die(
          new TypeError(
            `Cyclic dependencies detected: ${[...path.map((node) => node.name), key].join(" -> ")}`,
          ),
        );
      }
      parent.dependencies.add(resolution);
    }
    return resolution.task;
  }

  private ownerFor(lifetime: ServiceLifetime): RuntimeScope | undefined {
    if (lifetime === "singleton") return this.root;
    if (lifetime === "scoped") return this;
    return undefined;
  }

  public resolveMany(
    keys: readonly string[],
    requestedBy?: ServiceLifetime,
    path: readonly Resolution[] = [],
  ): RuntimeTask<RuntimeServices> {
    return ResultTask.gen(
      function* resolveManyServices(this: RuntimeScope) {
        const entries: [string, unknown][] = [];
        for (const key of keys) {
          const value = yield* this.resolve(key, requestedBy, path);
          entries.push([key, value]);
        }
        return Object.freeze(Object.fromEntries(entries));
      }.bind(this),
    );
  }

  public close(exit: Exit<unknown, unknown>): RuntimeTask<void> {
    return ResultTask.scoped(
      ResultTask.acquireRelease({
        acquire: succeedVoid(),
        release: () =>
          ResultTask.sync(() => {
            this.finished?.();
          }),
      }).flatMap(() =>
        ResultTask.sync(() => {
          this.closed = true;
        })
          .flatMap(() =>
            ResultTask.tryPromise({
              try: async () => {
                await Promise.all(this.children);
              },
              catch: (error) => error,
            }),
          )
          .flatMap(() => {
            this.disposing = true;
            return this.resources.close(exit);
          }),
      ),
    );
  }
}

interface Resolution {
  readonly name: string;
  readonly dependencies: Set<Resolution>;
  task: RuntimeTask;
}

const reaches = (
  node: Resolution,
  target: Resolution,
  visited = new Set<Resolution>(),
): boolean => {
  if (node === target) return true;
  if (visited.has(node)) return false;
  visited.add(node);
  return [...node.dependencies].some((dependency) => reaches(dependency, target, visited));
};

const assertSynchronous = (value: unknown): void => {
  if (
    value instanceof ResultTask ||
    (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      "then" in value &&
      typeof value.then === "function")
  ) {
    throw new TypeError(
      "A service factory must be synchronous; use task or resource for acquisition",
    );
  }
};

const isServiceClass = (
  value: unknown,
): value is ServiceClass<unknown, string, unknown, unknown> => {
  if (typeof value !== "function") return false;
  const candidate = value as {
    readonly identifier?: unknown;
    readonly key?: unknown;
    readonly make?: unknown;
  };
  return (
    typeof candidate.identifier === "string" &&
    typeof candidate.key === "symbol" &&
    candidate.make instanceof ResultTask
  );
};

const makeScope = <Services extends object, E, R, G extends Graph>(
  runtime: RuntimeScope,
  locals: RuntimeServices = {},
): ServiceScope<Services, E, R, G> => ({
  use: ((dependencies: readonly string[], use: (services: RuntimeServices) => RuntimeTask) => {
    runtime.validate(dependencies.filter((key) => !Object.hasOwn(locals, key)));
    const task = ResultTask.gen(function* runScopedUse() {
      const child = runtime.child(locals);
      const owned = ResultTask.acquireRelease({
        acquire: succeedVoid(),
        release: (_resource, exit) => child.close(exit),
      }).flatMap(() =>
        ResultTask.gen(function* resolveAndUse() {
          const services = yield* child.resolveMany(dependencies);
          return yield* child.bind(use(services));
        }),
      );
      return yield* owned;
    });
    return ResultTask.scoped(task) as never;
  }) as ServiceScope<Services, E, R, G>["use"],
  fetch: (dependencies, handle) => (request) =>
    runScopedResponse(request, (respond) => {
      const scope = makeScope(runtime, locals);
      const use = scope.use as unknown as (
        keys: readonly string[],
        callback: (services: RuntimeServices) => RuntimeTask<void>,
      ) => RuntimeTask<void>;
      return use(dependencies, (services) =>
        ResultTask.tryPromise({
          try: async () => {
            const response = await handle(services as Parameters<typeof handle>[0], request);
            if (request.signal.aborted) await response.body?.cancel(request.signal.reason);
            return response;
          },
          catch: (error) => error,
        }).flatMap((response) => respond(response)),
      );
    }),
  close: () =>
    runtime.close({ _tag: "Success", value: globalThis.undefined }) as unknown as ResultTask<
      void,
      ScopeError<R>
    >,
  withServices: (values) => {
    for (const key of Object.keys(values)) {
      if (Object.hasOwn(locals, key)) throw new TypeError(`Local service already supplied: ${key}`);
    }
    return makeScope(runtime, Object.freeze({ ...locals, ...values }));
  },
});

const moduleDefinitions = new WeakMap<object, Definitions>();

const makeModule = <Services extends object, E, R, G extends Graph>(
  definitions: Definitions,
): ServiceModule<Services, E, R, G> => {
  const createRuntime = (): RuntimeScope => new RuntimeScope(definitions);
  const use = ((
    dependencies: readonly string[],
    callback: (services: RuntimeServices) => RuntimeTask,
  ) => {
    validateKeys(definitions, dependencies);
    const task = ResultTask.gen(function* runModuleUse() {
      const runtime = createRuntime();
      const scope = makeScope<Services, E, R, G>(runtime);
      const rootLifetime = ResultTask.acquireRelease({
        acquire: succeedVoid(),
        release: (_resource, exit) => runtime.close(exit),
      });
      const runScopedUse = scope.use as unknown as (
        dependencies: readonly string[],
        callback: (services: RuntimeServices) => RuntimeTask,
      ) => RuntimeTask;
      const selected = runScopedUse(dependencies, callback);
      return yield* rootLifetime.flatMap(() => selected);
    });
    return ResultTask.scoped(task) as never;
  }) as ServiceModule<Services, E, R, G>["use"];

  const registerLifetime = (
    lifetime: ServiceLifetime,
  ): RegisterLifetime<Services, E, R, G, false> => {
    const registerService = function registerService(
      nameOrService: unknown,
      dependencies?: readonly string[],
      create?: (services: RuntimeServices) => unknown,
    ): ServiceModule<Services, E, R, G> {
      if (typeof nameOrService === "function") {
        if (!isServiceClass(nameOrService)) {
          throw new TypeError(
            "A class registration must be created with Service<Self>()(identifier, { make })",
          );
        }

        const service = nameOrService;
        return makeModule(
          register(
            definitions,
            service.identifier,
            makeDefinition([], () => service.make as RuntimeTask, lifetime),
          ),
        );
      }

      if (typeof nameOrService !== "string" || dependencies === undefined || create === undefined) {
        throw new TypeError("A service registration requires a name, dependencies, and factory");
      }

      return makeModule(
        register(
          definitions,
          nameOrService,
          makeDefinition(
            [...dependencies],
            (services) =>
              ResultTask.sync(() => {
                const value = create(services);
                assertSynchronous(value);
                return value;
              }),
            lifetime,
          ),
        ),
      );
    };

    return registerService as unknown as RegisterLifetime<Services, E, R, G, false>;
  };

  const module: ServiceModule<Services, E, R, G> = {
    http: (dependencies, handle) =>
      ResultTask.acquireRelease({
        acquire: ResultTask.sync(() => makeScope<Services, E, R, G>(createRuntime())),
        release: (scope) => scope.close(),
      }).map((scope) => {
        const fetch = scope.fetch(dependencies, handle);
        return {
          fetch,
          request: (input: string | Request, init?: RequestInit) =>
            fetch(
              input instanceof Request
                ? new Request(input, init)
                : new Request(new URL(input, "http://localhost"), init),
            ),
        };
      }),
    merge: (other) => {
      const additions = moduleDefinitions.get(other);
      if (additions === undefined) throw new TypeError("Expected a module created by createModule");
      const combined = new Map(definitions);
      for (const [name, definition] of additions) {
        if (combined.has(name)) throw new TypeError(`Service already registered: ${name}`);
        combined.set(name, definition);
      }
      return makeModule(combined);
    },
    value: (name, value) =>
      makeModule(
        register(
          definitions,
          name,
          makeDefinition([], () => ResultTask.succeed(value), "singleton"),
        ),
      ),

    singleton: registerLifetime("singleton"),
    scoped: registerLifetime("scoped"),
    transient: registerLifetime("transient"),

    task: (name, dependencies, create, options) =>
      makeModule(
        register(
          definitions,
          name,
          makeDefinition(
            [...dependencies],
            (services) =>
              create(services as Parameters<typeof create>[0]) as unknown as RuntimeTask,
            options?.lifetime,
          ),
        ),
      ),

    resource: (name, dependencies, options) =>
      makeModule(
        register(
          definitions,
          name,
          makeDefinition(
            [...dependencies],
            (services) => {
              const selected = services as Parameters<typeof options.acquire>[0];
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
              return ResultTask.acquireRelease({
                acquire: options.acquire(selected),
                release: (resource, exit) => options.release(resource, exit, selected),
              }) as RuntimeTask;
            },
            options.lifetime,
          ),
        ),
      ),

    override: (name, value) => {
      validateKeys(definitions, [name]);
      const previous = definitions.get(name);
      return makeModule(
        new Map([
          ...definitions,
          [
            name,
            makeDefinition([], () => ResultTask.succeed(value), previous?.lifetime ?? "singleton"),
          ],
        ]),
      );
    },

    use,
    scope: () => makeScope<Services, E, R, G>(createRuntime()),
  };
  moduleDefinitions.set(module, definitions);
  return module;
};

/** Starts an immutable module. Nothing executes until `use` or a child scope runs. */
export const createModule = (): ServiceModule<object, never, never, Record<never, never>> =>
  makeModule(new Map());

/** Checked selection for framework adapters using the public scope API. */
export type HttpServiceSelection<
  S extends object,
  R,
  G extends Graph,
  Keys extends readonly KeysOf<S>[],
> = Keys &
  LiteralKeys<Keys> &
  ([RemainingRequirements<SelectedR<G, Keys[number], R>, S>] extends [never]
    ? unknown
    : { readonly missingServices: RemainingRequirements<SelectedR<G, Keys[number], R>, S> });
export type { Graph as ServiceGraph, ScopeError as ServiceScopeError };
