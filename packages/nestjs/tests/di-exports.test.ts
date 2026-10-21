import * as di from "resultar-di";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  createModule,
  Service,
  service,
  resource,
  type HttpApplication,
  type ServiceClass,
  type ServiceLifetime,
  type ServiceModule,
  type ServiceScope,
} from "../src/index.js";

test("reexports the original DI primitives and public types", () => {
  expect(createModule).toBe(di.createModule);
  expect(Service).toBe(di.Service);
  expect(service).toBe(di.service);
  expect(resource).toBe(di.resource);
  expectTypeOf<HttpApplication>().toEqualTypeOf<di.HttpApplication>();
  expectTypeOf<ServiceClass<string, "name">>().toEqualTypeOf<di.ServiceClass<string, "name">>();
  expectTypeOf<ServiceLifetime>().toEqualTypeOf<di.ServiceLifetime>();
  expectTypeOf<ServiceModule<{ name: string }>>().toEqualTypeOf<
    di.ServiceModule<{ name: string }>
  >();
  expectTypeOf<ServiceScope<{ name: string }>>().toEqualTypeOf<di.ServiceScope<{ name: string }>>();
});
