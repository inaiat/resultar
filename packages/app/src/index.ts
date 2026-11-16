/** Unified entry point for typed workflows, dependency composition and configuration. */
export * from "resultar";
export {
  createModule,
  inspectModule,
  withProvider,
  useServiceAccess,
  ServiceAccessError,
  service,
  resource,
  Service,
  startServiceTask,
} from "resultar-di";
export type {
  ServiceAccess,
  ServiceProvider,
  ServiceClass,
  ServiceTaskSession,
  HttpApplication,
  ServiceLifetime,
  ServiceModule,
  ServiceRegistrationOptions,
  ServiceScope,
  ServiceGraph,
  ServiceScopeError,
  HttpServiceSelection,
  ServiceTaskRequirements,
} from "resultar-di";
export { ConfigError, defineAppConfig, t } from "resultar-config";
export type { ConfigIssue, AppConfigModule } from "resultar-config";
