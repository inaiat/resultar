# resultar-app

Unified entry point for Resultar workflows, dependency injection and validated Node
configuration. Install one package and import the application building blocks together:

```sh
pnpm add resultar-app
```

```ts
import { createModule, defineAppConfig, ResultTask, t } from 'resultar-app'

const config = defineAppConfig({
  properties: { PORT: t.Integer({ default: 3000, minimum: 1, maximum: 65535 }) },
})
const services = createModule()
  .merge(config)
  .singleton('httpConfig', ['appConfig'], ({ appConfig }) => ({ port: appConfig.PORT }))

const result = await services.use(['httpConfig'], ({ httpConfig }) =>
  ResultTask.ok(httpConfig.port),
).runResult()

if (result.isOk()) console.log(result.value) // number
else console.error(result.error.issues) // ConfigError
```

For configuration alone, use `await config.load().runResult()`. Construction is lazy;
each execution loads a fresh snapshot. Application roots cache singleton services.
Resources remain owned by the existing scopes and are released by `use` / `close`.

## Public API

- All named exports from [`resultar`](../resultar/README.md), including `Result`,
  `ResultTask`, `ResultAsync`, tagged errors, matching and workflow types.
- The services, resources, scopes and composition APIs from
  [`resultar-di`](../di/README.md), including `createModule`, `Service`, `service`,
  `resource` and their types.
- `defineAppConfig`, `ConfigError`, `t`, `ConfigIssue` and `AppConfigModule` from
  [`resultar-config`](../config/README.md).

These are direct reexports of the component implementations, with the same runtime
identity, inference, eager/lazy execution contracts and cleanup behavior. The component
packages remain available independently. TypeBox is installed automatically through
`resultar-config`; `t.Static<typeof schema>` infers schema types.

## Unified and direct imports

Use the unified entry point when the application installs only `resultar-app`:

```sh
pnpm add resultar-app
```

```ts
import { Result, ResultTask, createModule, defineAppConfig, t } from 'resultar-app'
```

Direct component imports remain supported. Declare each component you import as
an application dependency, even when `resultar-app` also depends on it:

```sh
pnpm add resultar
```

```ts
import { Result, ResultTask } from 'resultar'
```

The same rule applies to `resultar-di`, `resultar-config` and direct `typebox`
imports. Importing a transitive dependency by its own package name is not guaranteed
to resolve; installing `resultar-app` guarantees the `resultar-app` entry point.
Both import styles can coexist. Keep component versions aligned so they resolve to
the same implementations; reexports introduce no additional classes or wrappers.

## Framework integrations

Framework integrations are installed separately. For example:

```sh
pnpm add resultar-app resultar-hono hono
```

Import application services/configuration from `resultar-app`, and `createHonoApp`
from `resultar-hono`. See the [Hono example](../../examples/hono/README.md).
`resultar-app` does not start a server or register process handlers when imported.
Importing `resultar-app` performs no dynamic code generation (`new Function`), so
workflow and DI APIs reexported from `resultar` and `resultar-di` run cleanly even
under `--disallow-code-generation-from-strings` / strict CSP; resolving
`defineAppConfig` (`load()` / `appConfig`) relies on AJV v8 in Node.js 24+ and
requires dynamic code generation at resolution time. Configuration uses the Node
environment; this combined entry point targets Node.js 24+ and ESM. HTTP adapters
continue owning their application and request lifetimes.

## Validation

```sh
pnpm --filter resultar-app check:full
pnpm --filter resultar-app smoke:package
```

The tests verify component identity, configuration inference, lazy acquisition and
cleanup. Package smoke installs archives in an isolated project whose only direct
dependency is `resultar-app`.
