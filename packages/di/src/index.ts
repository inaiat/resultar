import { createModule as createAdvancedModule, type PrimaryServiceModule } from "./module.js";

export const createModule = (): PrimaryServiceModule<object, never, never, Record<never, never>> =>
  createAdvancedModule() as unknown as PrimaryServiceModule<
    object,
    never,
    never,
    Record<never, never>
  >;
export { service, resource, Service } from "./service.js";
export type { ServiceClass } from "./service.js";
export type {
  HttpApplication,
  ServiceLifetime,
  PrimaryServiceModule as ServiceModule,
  ServiceScope,
} from "./module.js";
