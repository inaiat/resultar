import {
  createTaggedError,
  type Exit,
  type Result,
  type ResultTask,
  type TaggedErrorClass,
} from "resultar";

export type ServiceAccessFailure = "missing" | "cycle" | "lifetime" | "asynchronous" | "closed";

/** A synchronous lookup defect, distinct from an exception thrown by a factory. */
const ServiceAccessErrorBase: TaggedErrorClass<
  "ServiceAccessError",
  "Service $serviceName: $reason"
> = createTaggedError({ name: "ServiceAccessError", message: "Service $serviceName: $reason" });
export class ServiceAccessError extends ServiceAccessErrorBase {
  public constructor(
    readonly kind: ServiceAccessFailure,
    serviceName: string,
    reason: string,
  ) {
    super({ serviceName, reason });
  }
}

/** Dynamic access for framework adapters. Ordinary applications should prefer typed selections. */
export interface ServiceAccess {
  readonly keys: readonly string[];
  readonly has: (name: string) => boolean;
  readonly get: (name: string) => Result<unknown, Error>;
  readonly use: <A, E, R>(
    keys: readonly string[],
    callback: (services: Readonly<Record<string, unknown>>) => ResultTask<A, E, R>,
  ) => ResultTask<A, unknown, R>;
  readonly close: () => ResultTask<void, unknown>;
}

export type ServiceProvider<A = unknown, E = never, R = never> =
  | { readonly value: A }
  | { readonly lifetime?: "singleton" | "scoped" | "transient"; readonly task: ResultTask<A, E, R> }
  | {
      readonly lifetime?: "singleton" | "scoped" | "transient";
      readonly create: (access: ServiceAccess) => A;
      readonly release?: (value: A, exit: Exit<unknown, unknown>) => ResultTask<void, E>;
      /** Traditional factory containers allow capturing a transient in a longer-lived factory. */
      readonly allowTransientDependencies?: boolean;
    };
