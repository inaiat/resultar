# resultar-config

For applications combining workflows, services and configuration, use
[`resultar-app`](../app/README.md) as the unified installation and import entry point.
This package is also available independently.

Lazy, typed Node environment configuration composed with `resultar-di`.

```sh
pnpm add resultar-config resultar resultar-di
```

```ts
import { defineAppConfig, t } from "resultar-config";
import { createModule } from "resultar-di";
import { ResultTask } from "resultar";

const properties = {
  PORT: t.Integer({ default: 8080, minimum: 1, maximum: 65535 }),
  DATABASE_URL: t.String({ minLength: 1 }),
  FEATURE_ENABLED: t.Boolean({ default: false }),
};
const appConfig = defineAppConfig({ properties });
const createServices = (config = appConfig) =>
  createModule()
    .merge(config)
    .singleton("httpConfig", ["appConfig"], ({ appConfig }) => ({ port: appConfig.PORT }));
const services = createServices(
  defineAppConfig({
    properties,
    source: { DATABASE_URL: "postgresql://localhost/test", PORT: "9000" },
  }),
);
const exit = await services
  .use(["httpConfig"], ({ httpConfig }) => ResultTask.ok(httpConfig.port))
  .runExit();
```

`t` is a direct reexport of TypeBox's `Type`, so schema builders and inferred types
are unchanged. You can also keep importing `Type` from `typebox` and mix those
schemas with `t` schemas. TypeBox is installed automatically as a dependency
(`>=1.3.4 <2.0.0`); no separate installation is needed when using `t`. If you import
from `typebox` directly, declare it in your application's dependencies too.
The alias adds no framework-specific schema builders or validation behavior.

For direct loading at startup or in scripts, use the module's `load()` helper:

```ts
const config = await appConfig.load().runResult();
if (config.isErr()) {
  console.error("Invalid application configuration", config.error.issues);
  process.exitCode = 1;
} else {
  console.log(config.value.PORT); // number
}
```

`load()` returns `ResultTask<Static<TObject<P>>, ConfigError>`. Creating the task
reads nothing; every execution resolves and closes a fresh DI root. Re-running it
reads a new snapshot, without changing snapshots cached by application roots.
To reuse a validated snapshot in application services, pass it through
`createServices().override('appConfig', config.value)` in the success branch.
Schema defects retain the usual `ResultTask` defect behavior.

`defineAppConfig` returns an ordinary `AppConfigModule<typeof properties>` with
readonly `properties` metadata. No explicit output interface or assertion is needed.
Optional fields and literal unions retain TypeBox types. Selecting configuration or
its dependents includes `ConfigError`; unrelated services retain their own errors.
Merge one config module per root; duplicate registration checks remain in force.

Definition and merge do no work. The singleton snapshots the supplied source on
first resolution; omitting `source` reads `process.env` then. An explicit map,
including `{}`, replaces environment lookup completely. Input is copied before
validation. Successful values are cached per root; failures can be retried; distinct
roots share neither values nor validation caches. Configuration is not a live view.
Use Node's `--env-file` option if needed; this adapter does no dotenv file loading.

Validation uses TypeBox's closed object schema. An AJV normalization pass enables
`allErrors`, `coerceTypes`, `useDefaults`, `removeAdditional`, `strictNumbers`, and
`allowUnionTypes`. A second, non-coercing AJV validation of the same schema rejects
infinity introduced by numeric coercion (including `1e309`), aggregated with other
invalid or missing fields even if the normalization pass failed. Required fields,
bounds, integer constraints, defaults and optional fields follow the schema.
Boolean strings `true`/`false` work; `1`, `TRUE`, and `yes` do not. Empty strings
remain strings: a string schema may accept them, `minLength` can reject them, and
numeric schemas reject them. Whitespace-only numeric strings coerce to zero and
then face the schema's bounds. Tokens and passwords are never trimmed or normalized.
Additional environment keys are removed. Keep schemas JSON-compatible; unsupported
keywords/formats and schema compilation failures are defects.

`ConfigError.issues` is a frozen readonly collection of `{ path, category, message }`.
Paths use JSON Pointer; categories are `missing`, `type`, or `constraint`. Messages
are controlled and never include rejected values. The error retains neither the
source map, validator messages nor the validator exception/cause. Schema compilation
and unexpected faults remain defects.

Startup resources must depend directly or transitively on `appConfig`. Merging
alone does not block unrelated resources. The executable
[composition recipe](scripts/config-example.ts) demonstrates an injected test map,
configuration before database/server acquisition, and reverse cleanup. The tests
also verify zero acquisitions for invalid input and rollback after later failures.

```sh
pnpm --filter resultar-config smoke:package
```

Node.js 24+, ESM. Importing `resultar-config` and defining or merging lazy
`defineAppConfig` modules perform no dynamic code generation (`new Function`),
so the package imports cleanly under `--disallow-code-generation-from-strings`.
Resolving `appConfig` (`load()` or `use(["appConfig"], ...)`) compiles schemas
with AJV v8, which requires dynamic code generation at resolution time (and
surfaces `EvalError` as a `Die` defect if code generation is disabled). No remote
secrets, reloads, async providers, precedence engine, Zod entry point, or edge
runtime compatibility is implied.
