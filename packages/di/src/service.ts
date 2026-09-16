import {
  ResultTask,
  type ServiceTag,
  type Exit,
  type ResultTaskScope,
  ServiceTagTypeId,
} from "resultar";

/* eslint-disable @typescript-eslint/no-extraneous-class, unicorn/no-static-only-class */

/** A class-shaped service token with a lazily evaluated construction task. */
export type ServiceClass<Self, Identifier extends string, E = never, R = never> = ServiceTag<
  Identifier,
  Self
> & { readonly make: ResultTask<Self, E, R> } & (abstract new (...args: never[]) => object);

function createServiceClass<const Identifier extends string, Self, E = never, R = never>(
  identifier: Identifier,
  definition: { readonly make: ResultTask<Self, E, R> },
): ServiceClass<Self, Identifier, E, R> {
  const tag = ResultTask.service<Self, Identifier>(identifier);

  class ServiceBase {
    public constructor(...args: unknown[]) {
      if (
        new.target === ServiceBase ||
        (args.length === 0 && Object.getOwnPropertyNames(new.target.prototype).length <= 1)
      ) {
        throw new TypeError("Service classes are tokens; resolve them through a module");
      }
    }
    public static readonly [ServiceTagTypeId]: typeof ServiceTagTypeId = ServiceTagTypeId;
    public static readonly _tag = tag._tag;
    public static readonly identifier = tag.identifier;
    public static readonly key = tag.key;
    public static readonly make = definition.make;
    public static readonly [Symbol.iterator] = tag[Symbol.iterator].bind(tag);
  }

  return ServiceBase;
}

type Tags = Readonly<Record<string, ServiceTag<string, unknown>>>;
type Values<Dependencies extends Tags> = {
  readonly [Key in keyof Dependencies]: Dependencies[Key] extends ServiceTag<string, infer Value>
    ? Value
    : never;
};
type TaskDefinition<Self, E, R> = {
  readonly requires?: never;
  readonly make: ResultTask<Self, E, R>;
};
type RequiredDefinition<Dependencies extends Tags, Self, E, R> = {
  readonly requires: Dependencies;
  readonly make: (dependencies: Values<Dependencies>) => ResultTask<Self, E, R>;
};
type Contract<Self, Inferred> = [Self] extends [never] ? Inferred : Self;
type AsyncFactoryValue =
  | ResultTask<unknown, unknown, unknown>
  | { readonly then: (...args: never[]) => unknown };
type SyncDefinition<Dependencies extends Tags, Self> = {
  readonly requires: Dependencies;
  readonly make: (
    dependencies: Values<Dependencies>,
  ) => Self & ([Extract<Self, AsyncFactoryValue>] extends [never] ? unknown : never);
};

interface CurriedService<Self> {
  <const Identifier extends string, ActualSelf = unknown, E = never, R = never>(
    identifier: Identifier,
    definition: TaskDefinition<Contract<Self, ActualSelf>, E, R>,
  ): ServiceClass<Contract<Self, ActualSelf>, Identifier, E, R>;
  <
    const Identifier extends string,
    const Dependencies extends Tags,
    ActualSelf = unknown,
    E = never,
    R = never,
  >(
    identifier: Identifier,
    definition: RequiredDefinition<Dependencies, Contract<Self, ActualSelf>, E, R>,
  ): ServiceClass<Contract<Self, ActualSelf>, Identifier, E, Dependencies[keyof Dependencies] | R>;
  <
    const Identifier extends string,
    const Dependencies extends Tags,
    ActualSelf extends Contract<Self, unknown> = Contract<Self, unknown>,
  >(
    identifier: Identifier,
    definition: SyncDefinition<Dependencies, ActualSelf>,
  ): ServiceClass<Contract<Self, ActualSelf>, Identifier, never, Dependencies[keyof Dependencies]>;
}

function resolveDependencies(dependencies: Tags) {
  return ResultTask.gen(function* resolve() {
    const entries: [string, unknown][] = [];
    for (const [key, tag] of Object.entries(dependencies)) entries.push([key, yield* tag]);
    return Object.freeze(Object.fromEntries(entries));
  });
}

function defineService<const Identifier extends string, Self, E = never, R = never>(
  identifier: Identifier,
  definition: TaskDefinition<Self, E, R>,
): ServiceClass<Self, Identifier, E, R>;
function defineService<
  const Identifier extends string,
  const Dependencies extends Tags,
  Self,
  E = never,
  R = never,
>(
  identifier: Identifier,
  definition: RequiredDefinition<Dependencies, Self, E, R>,
): ServiceClass<Self, Identifier, E, Dependencies[keyof Dependencies] | R>;
function defineService<const Identifier extends string, const Dependencies extends Tags, Self>(
  identifier: Identifier,
  definition: SyncDefinition<Dependencies, Self>,
): ServiceClass<Self, Identifier, never, Dependencies[keyof Dependencies]>;
function defineService<Self = never>(): CurriedService<Self>;
function defineService(...args: unknown[]): unknown {
  if (args.length === 0) return defineService;
  const identifier = args[0] as string;
  const definition = args[1] as
    | TaskDefinition<unknown, unknown, unknown>
    | RequiredDefinition<Tags, unknown, unknown, unknown>
    | SyncDefinition<Tags, unknown>;
  if (definition.requires === undefined) {
    if (!(definition.make instanceof ResultTask))
      throw new TypeError("Service make must be a ResultTask when requires is absent");
    return createServiceClass(identifier, definition);
  }
  const { requires, make } = definition;
  if (typeof make !== "function")
    throw new TypeError("Service make must be a factory when requires is present");
  return createServiceClass(identifier, {
    make: ResultTask.gen(function* construct() {
      const dependencies = yield* resolveDependencies(requires);
      const value = make(dependencies);
      if (value instanceof ResultTask) return yield* value as ResultTask<unknown, unknown, unknown>;
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value &&
        typeof value.then === "function"
      )
        throw new TypeError(
          "Service make factory must return a synchronous value or ResultTask, not a Promise or thenable",
        );
      return value;
    }),
  });
}

/** Creates a lazy class-shaped service with explicit `requires` or generator-inferred dependencies. */
export const Service: typeof defineService & {
  /** Declares a yieldable requirement; its provider must be registered separately. */
  readonly require: <Self>() => <const Identifier extends string>(
    identifier: Identifier,
  ) => ServiceTag<Identifier, Self>;
} = Object.assign(defineService, { require: <Self>() => ResultTask.service<Self>() });

/** Defines a task-backed token without a class wrapper. */
export function service<const Name extends string, A, E, R>(
  name: Name,
  make: ResultTask<A, E, R>,
): ServiceClass<A, Name, E, R>;
/** Injects typed tokens into an ordinary synchronous factory. */
export function service<const Name extends string, const Dependencies extends Tags, A>(
  name: Name,
  dependencies: Dependencies,
  create: (
    dependencies: Values<Dependencies>,
  ) => A &
    (A extends PromiseLike<unknown> | ResultTask<unknown, unknown, unknown>
      ? { readonly initialization: "Use service(name, task) for asynchronous initialization" }
      : unknown),
): ServiceClass<A, Name, never, Dependencies[keyof Dependencies]>;
export function service(
  name: string,
  dependencies: ResultTask<unknown, unknown, unknown> | Tags,
  create?: (dependencies: Readonly<Record<string, unknown>>) => unknown,
): ServiceClass<unknown, string, unknown, unknown> {
  const make =
    dependencies instanceof ResultTask
      ? dependencies
      : ResultTask.gen(function* construct() {
          const values = yield* resolveDependencies(dependencies);
          if (create === undefined) throw new TypeError("A service factory is required");
          const value = create(values);
          if (
            value instanceof ResultTask ||
            (value !== null && typeof value === "object" && "then" in value)
          )
            throw new TypeError("Use service(name, task) for asynchronous initialization");
          return value;
        });
  return Service<unknown>()(name, { make });
}

/** Defines acquisition and cleanup; singleton/scoped/transient chooses the lifetime. */
export const resource = <const Name extends string, A, E, R, ReleaseE, ReleaseR>(
  name: Name,
  options: {
    readonly acquire: ResultTask<A, E, R>;
    readonly release: (
      value: A,
      exit: Exit<unknown, unknown>,
    ) => ResultTask<void, ReleaseE, ReleaseR>;
  },
): ServiceClass<A, Name, E, R | ReleaseR | ResultTaskScope<ReleaseE>> =>
  service(name, ResultTask.acquireRelease(options)) as unknown as ServiceClass<
    A,
    Name,
    E,
    R | ReleaseR | ResultTaskScope<ReleaseE>
  >;
