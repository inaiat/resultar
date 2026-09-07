import { ResultTask, type ServiceTag, type Exit, type ResultTaskScope } from "resultar";

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
    public static readonly _tag = tag._tag;
    public static readonly identifier = tag.identifier;
    public static readonly key = tag.key;
    public static readonly make = definition.make;
    public static readonly [Symbol.iterator] = tag[Symbol.iterator].bind(tag);
  }

  return ServiceBase;
}

/** Creates a class-shaped service token whose contract is inferred from `make`. */
export function Service<const Identifier extends string, Self, E = never, R = never>(
  identifier: Identifier,
  definition: { readonly make: ResultTask<Self, E, R> },
): ServiceClass<Self, Identifier, E, R>;
/** Creates an Effect-style service token whose dependencies are declared with `yield*`. */
export function Service<Self = never>(): <
  const Identifier extends string,
  ActualSelf = [Self] extends [never] ? unknown : Self,
  E = never,
  R = never,
>(
  identifier: Identifier,
  definition: { readonly make: ResultTask<[Self] extends [never] ? ActualSelf : Self, E, R> },
) => ServiceClass<[Self] extends [never] ? ActualSelf : Self, Identifier, E, R>;
export function Service(...args: unknown[]): unknown {
  if (args.length >= 2) {
    return createServiceClass(
      args[0] as string,
      args[1] as { readonly make: ResultTask<unknown, never, never> },
    );
  }
  return function createService(
    identifier: string,
    definition: { readonly make: ResultTask<unknown, never, never> },
  ) {
    return createServiceClass(identifier, definition);
  };
}

type Tags = Readonly<Record<string, ServiceTag<string, unknown>>>;
type Values<Dependencies extends Tags> = {
  readonly [Key in keyof Dependencies]: Dependencies[Key] extends ServiceTag<string, infer Value>
    ? Value
    : never;
};

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
          const values: Record<string, unknown> = {};
          for (const [key, tag] of Object.entries(dependencies)) values[key] = yield* tag;
          if (create === undefined) throw new TypeError("A service factory is required");
          const value = create(Object.freeze(values));
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
