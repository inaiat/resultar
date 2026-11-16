# RFC 0008: Declarative configuration and dependency injection

- Status: Draft
- Date: 2026-11-16
- Target package: `resultar-config` (proposed), integrating existing `resultar` and `resultar-di` APIs
- References: [RFC 0002](./rfc-0002-di-lifetimes-scopes.md)

## Summary

Introduce a small configuration integration with inferred values and typed
validation errors, composed through the existing dependency injection module.
Keep the application contract simple: declare configuration properties once with
`defineAppConfig`, merge the resulting module into application services or pass it
at application initialization, and let services consume the validated values.

Validate the contract with a small prototype before publishing a configuration
package. The package must provide reusable validation, safe typed errors, and
module composition beyond wrapping one validator call.

All new signatures below are design sketches, not available APIs. This draft
adds no runtime behavior, dependencies, generated recipes, or release changesets.

## 1. Motivation and baseline

Applications using TypeBox, `env-schema`, and `resultar-di` need a consistent way
to define configuration, validate environment inputs, and inject the resulting
values. Services use those values for database connections, authentication, and
HTTP settings. Tests need an explicit environment map with isolated defaults.

This proposal addresses the following concerns:

| Observation | Proposed response |
| --- | --- |
| Manual per-field validators and configuration getters can duplicate schema behavior. | Publish a minimal schema-first recipe and evaluate a small adapter. |
| Validation can throw during service construction, leaving expected configuration failures outside the typed error channel. | Represent invalid input as `ConfigError` and initialize through a task provider. |
| Numeric string coercion must reject non-finite values and overflow. | Specify and test coercion at the validator boundary, without application-specific getters. |
| Invalid configuration must prevent connections and listeners from starting. | Demonstrate ordered startup through existing resource dependencies. |
| Tests need isolated input without mutating the host environment. | Accept an explicit source and preserve types through module injection. |

The current DI package already provides overrides, graph inspection, lifetime
validation, lazy resource acquisition, and cleanup of partially initialized graphs.
This proposal uses those facilities without changing their semantics. Improvements
to `Result.try` inference, typed closure of long-lived scopes, DI diagnostics, and
Node signal/shutdown integration are outside this RFC and tracked in
[RFC 0009](./rfc-0009-inference-scopes-and-application-lifecycle.md).

## 2. Configuration contract

### Responsibilities

- `env.ts` owns the application properties and exports the module produced by
  `defineAppConfig`. Its configuration type is inferred from those properties.
- The composition module merges that configuration module. Validation and singleton
  registration are part of the adapter; consumers do not register schema/source
  services or write a task generator merely to load configuration.
- Services receive validated fields. Database connection options, CORS parsing,
  and SDK construction belong to the corresponding service or integration.
- The initial Node adapter defaults to the process environment at resolution time;
  tests and application factories can supply an explicit source map. Node can load
  `.env` through its CLI. Definition and merge perform no environment read,
  validation, filesystem access, or process-wide caching.

Do not add a second application configuration schema, manually repeat its output
interface, or expose getters such as `getPort()` that only return validated fields.
An intentional CLI subset can be derived from the schema using the validator's
existing projection facilities. It need not require unrelated API credentials.

### Proposed definition and composition API

Evaluate `resultar-config` with an initial TypeBox + `env-schema` integration.
The tentative public entry point is `resultar-config/typebox`; packaging remains
subject to the pilot. This adapter depends on `resultar-di` and returns an ordinary
typed module compatible with its existing `merge`. Keep validator dependencies out
of the core and DI packages.

Use `defineAppConfig` as the public name.
`defineAppProperties` would describe only the input; the returned value also defines
validation and registration. `properties` names the TypeBox property map, while
`appConfig` names both the exported module and its single registered service.

```ts
// env.ts — proposed API, not an installed export.
import { defineAppConfig } from "resultar-config/typebox"
import { Type } from "typebox"

export const appConfigProperties = {
  PORT: Type.Integer({ default: 8080, minimum: 1, maximum: 65_535 }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  FEATURE_ENABLED: Type.Boolean({ default: false }),
}

export const appConfig = defineAppConfig({ properties: appConfigProperties })
```

The adapter constructs one closed object schema from `properties` and infers its
output using the installed TypeBox declarations. Do not require a second schema,
caller-supplied output generic, manually written interface, or type assertion.
Changes to properties and defaults must actually control validation.

### Return type and error propagation

The proposed signature returns the existing `ServiceModule` with readonly
`properties` metadata. Its fourth type parameter retains the exact dependency
graph, so selecting unrelated services does not incorrectly add `ConfigError` to
their error channel.

```ts
// Proposed public declaration; ConfigError is the tagged error specified below.
import type { ServiceModule } from "resultar-di"
import type { Static, TObject, TProperties } from "typebox"

export type AppConfigModule<P extends TProperties> = ServiceModule<
  { readonly appConfig: Static<TObject<P>> },
  ConfigError,
  never,
  {
    readonly appConfig: {
      readonly error: ConfigError
      readonly requirements: never
      readonly dependencies: never
    }
  }
> & { readonly properties: Readonly<P> }

export declare function defineAppConfig<P extends TProperties>(options: {
  readonly properties: P
  readonly source?: Readonly<Record<string, string | undefined>>
}): AppConfigModule<P>
```

`AppConfigModule<P>` is a type alias for a normal module with schema metadata,
not a wrapper or a new runtime abstraction. `properties` describes the original
schema fields; it is not a service or a second schema. It also anchors the input
type: the current structural `ServiceModule` type alone does not reject all
incompatible configuration modules passed through a factory. The prototype must
preserve this check without assertions or a manually repeated value interface.

The registration has no external task requirements. A task
selecting `appConfig`, or a service that depends on it, includes `ConfigError` in
its inferred error union. Merging another module preserves both its values and
its errors. Optional properties and literal unions retain their TypeBox types.

Passing the module through a factory must preserve this signature. A default
parameter inferred from `appConfig` is sufficient, as shown below. When an explicit
annotation is needed, use `AppConfigModule<typeof appConfigProperties>`; avoid
widening it to an unparameterized graph or a generic record of unknown services.
Alternative sources do not change the schema-derived return type.

### Composition and initialization injection

Application services compose it directly:

```ts
// app-services.ts — merge is an existing resultar-di operation.
import { createModule } from "resultar-di"
import { appConfig } from "./env.ts"

export const appServices = createModule()
  .merge(appConfig)
  .singleton("httpConfig", ["appConfig"], ({ appConfig }) => ({
    port: appConfig.PORT, // inferred as number
  }))
```

Alternatively, applications that accept configuration during initialization can
make their service composition a factory:

```ts
// Alternative app-services.ts for injection during application initialization.
export const createServices = (config = appConfig) =>
  createModule()
    .merge(config)
    .singleton("httpConfig", ["appConfig"], ({ appConfig }) => ({
      port: appConfig.PORT,
    }))

// At the executable boundary, or inside the application's createApp({ config }).
const services = createServices(appConfig)

// Tests supply a complete isolated source; the host environment is not consulted.
const testConfig = defineAppConfig({
  properties: appConfigProperties,
  source: { PORT: "9000", DATABASE_URL: "postgresql://localhost/example_test" },
})
const testServices = createServices(testConfig)
```

These are alternative composition styles. Merge exactly one configuration module
per root; existing duplicate-registration checks apply. An application-level
`createApp({ config = appConfig })` can forward that module to `createServices`.
This RFC adds no application builder or special `config` option to `createModule`.

The proposed definition accepts `properties` and an optional readonly `source`
map. An explicit source completely replaces environment lookup, including when
the map is empty. The Node default is read only when the singleton is first
resolved. Copy input before validation; do not mutate either supplied maps or
`process.env`. Configuration is a snapshot for that root, not a live environment
view. Do not cache resolved values in the reusable module definition.

Internally the adapter registers a singleton task provider named `appConfig` with
an inferred configuration value and `ConfigError` as its expected error channel.
The provider delegates to the validator; the consumer does not need a public
`parseConfig` helper, `.value("configSchema", ...)`, `.value("configSource", ...)`,
or a wrapping generator. Schema, source, and parsing remain implementation details
of this configuration definition.

Successful configuration is shared within a root; separate roots and tests remain
independent. Merging alone does not execute validation. Application startup must
resolve configuration before opening external resources or listening on a port,
either through their declared dependency on `appConfig` or an explicit startup
resolution. Invalid input propagates as a typed failure through the existing DI
task contract. Programmer faults retain the existing defect semantics.

Acceptance includes inference through merge and factory injection, exactly one
successful resolution per root, no evaluation at definition/merge time, isolated
explicit sources, duplicate-module rejection, and typed startup failures. Preserve
the existing DI behavior for retries after failed initialization.

### Validation, normalization, and errors

The selected validator remains responsible for schema validation, defaults, and
coercion. Do not introduce an additional schema language or hand-written rules for
every environment variable. Validate a copied input because validators may mutate
their data while applying defaults or removing additional properties.

Before shipping, specify the adapter's coercion behavior through executable tests:

- Missing required fields fail; optional fields may remain absent; defaults are
  applied according to the schema and documented validator options.
- An empty string is not globally equivalent to absence. Each schema decides
  whether it is valid, including the treatment of whitespace-only strings.
- Boolean strings `"true"` and `"false"` produce the intended values; unsupported
  representations fail rather than becoming JavaScript truthiness conversions.
- Numeric strings respect bounds and integer constraints. `NaN`, infinities, and
  overflow strings such as `"1e309"` must fail for finite numeric settings.
- Unrelated environment keys are excluded from the validated result. The first
  recipe uses a closed object schema and documents the chosen validator options.
- Case normalization such as trimming/lowercasing `LOG_LEVEL` stays explicit in
  `env.ts`; passwords and tokens must never be silently trimmed or lowercased.

First investigate validator configuration for finite-number correctness. A
schema-aware workaround requires its own tests; do not hard-code `PORT` or
`JWT_EXPIRATION_MS` into a library. If this cannot be made small and reliable,
keep explicit normalization in the application recipe and defer the package.

`ConfigError` is an expected tagged failure with a readonly collection of issues.
Each issue exposes a field path and stable category, for example missing, type,
or constraint, with a safe human-readable explanation. Aggregate independent
field failures so operators can fix them in one startup attempt.

Never retain the source map, rejected values, or the raw validator exception in
the public error or its `cause`. Validator messages and parameters can contain
values and must be converted to controlled diagnostics. Treat all input values as
sensitive by default; a secret annotation is not required for safe errors.
Schema authoring errors and unexpected validator faults remain programming
failures rather than being mislabeled as invalid environment input. Specify the
recognition of genuine validation failures before implementation.

No async configuration providers, remote secrets, reloads, precedence engine, or
Cloudflare-specific bindings are included. Runtime compatibility must be tested;
this RFC does not claim that the Node validator adapter works in every edge runtime.

## 3. Validate configuration before acquiring resources

The following executable-boundary example uses the preceding `createServices`
factory. `connectDatabase` and `listen` represent application-owned driver adapters
with the declared contracts; they are not proposed Resultar exports. All acquisition
and release operations are lazy tasks. `waitForShutdown` keeps the program alive
until the application requests shutdown; signal handling belongs to that adapter.

```ts
import type { ResultTask } from "resultar"
import { createServices } from "./app-services.ts"

interface Database {
  close(): ResultTask<void, Error>
}

interface Server {
  close(): ResultTask<void, Error>
  waitForShutdown(): ResultTask<void, Error>
}

// External driver contracts, supplied by the application.
declare function connectDatabase(url: string): ResultTask<Database, Error>
declare function listen(port: number, database: Database): ResultTask<Server, Error>

const services = createServices()
  .resource("database", ["appConfig"], {
    acquire: ({ appConfig }) => connectDatabase(appConfig.DATABASE_URL),
    release: (database) => database.close(),
  })
  .resource("server", ["appConfig", "database"], {
    acquire: ({ appConfig, database }) => listen(appConfig.PORT, database),
    release: (server) => server.close(),
  })

const program = services.use(["server"], ({ server }) => server.waitForShutdown())
const exit = await program.runExit()
// The entry point reports exit using its existing logging and exit-code policy.
```

Constructing `services` and `program` performs no validation or acquisition.
Running the program resolves `appConfig` before `database`, and resolves both
before `server`. Invalid configuration returns a failure containing `ConfigError`;
neither driver acquisition is invoked. No explicit validation call or generator
is required in the application configuration module.

The two resources use the existing default scoped lifetime and are retained for
the serving callback. The configuration uses singleton lifetime for that root.
When the callback completes or fails, release closes the server before the database.
If server acquisition fails, the already acquired database is released. These are
existing DI guarantees, not a new lifecycle implementation.

This ordering relies on the declared dependencies. Every side-effecting startup
resource must depend directly or transitively on `appConfig`; merging a configuration
module does not eagerly validate it or block unrelated acquisitions automatically.
Keep connections and listener creation inside their task adapters. Acceptance tests
must verify both acquisition counters remain zero for invalid input and assert the
successful ordering `config -> database -> server`.

## 4. Recipes, alternatives, and delivery gates

The first recipe set covers `defineAppConfig`, module merge, configuration passed
at initialization, explicit test sources, inferred service/error types, and validation
before resource acquisition. Keep each example small and
compile it against actual declarations. Examples for proposed APIs remain inside
this RFC until those APIs exist.

Keeping `env-schema` directly in `env.ts` is a valid outcome. A package is justified
only if typed, aggregated, sanitized errors and validated integration remove
repeated consumer code without adding more configuration machinery. A generic
Standard Schema adapter can be evaluated later; it would still need an explicit
environment coercion/default contract and is not a substitute for that work.

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0 | Configuration contract prototype | Confirm validator options, coercion/default semantics, and classification of input errors versus defects. |
| 1 | Public declaration and composition type tests | Preserve property types, optional fields, and literals through merge and factory injection. Selected tasks include `ConfigError` only when their dependency graph requires configuration; other provider errors remain in the union. Reject duplicate registration and incompatible injected configuration. |
| 2 | Validation and isolation tests | Verify aggregation, sanitization, finite numbers, immutable sources, defaults, lazy resolution, one successful validation per root, and independent roots. Explicit empty sources never read host variables. |
| 3 | Startup integration and executable recipes | Verify zero acquisitions on invalid input, dependency ordering on success, and existing cleanup on later acquisition failure. Compile and execute the documented composition examples. |
| 4 | Package and documentation delivery | Publish only after the prototype establishes reusable value; validate exports, declarations, recipes, and package smoke tests. |

Each implemented behavior change requires targeted tests and a package changeset.
Follow the workspace validation in `AGENTS.md`; after public API or recipe changes,
build and regenerate documentation/inventory and run documentation and agent checks.
Existing APIs retain their semantics. Record implementation and publication
separately in this RFC.

Open review decisions are the configuration package boundary, the exact structured
error shape, and validator options needed to satisfy the coercion contract. Changes
to core inference, scope ownership, DI diagnostics, and process lifecycle remain
outside this delivery plan and are reviewed independently in RFC 0009.
