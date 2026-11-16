import envSchema from "env-schema";
import { Ajv, type ErrorObject } from "ajv";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { createTaggedError, ResultTask, type TaggedErrorClass } from "resultar";
import { createModule, type ServiceModule } from "resultar-di";

export interface ConfigIssue {
  readonly path: string;
  readonly category: "missing" | "type" | "constraint";
  readonly message: string;
}

/** Invalid input only: never retains environment values or raw validator errors. */
const ConfigErrorBase: TaggedErrorClass<
  "ConfigError",
  "Invalid application configuration",
  Error,
  { readonly issues: readonly ConfigIssue[] }
> = createTaggedError({
  name: "ConfigError",
  message: "Invalid application configuration",
}).withProps<{ readonly issues: readonly ConfigIssue[] }>();
export class ConfigError extends ConfigErrorBase {}

export type AppConfigModule<P extends TProperties> = ServiceModule<
  { readonly appConfig: Static<TObject<P>> },
  ConfigError,
  never,
  {
    readonly appConfig: {
      readonly error: ConfigError;
      readonly requirements: never;
      readonly dependencies: never;
    };
  }
> & {
  readonly properties: Readonly<P>;
  /** Loads a fresh snapshot per execution, independently of application DI roots. */
  readonly load: () => ResultTask<Static<TObject<P>>, ConfigError>;
};

const configError = (errors: readonly ErrorObject[]): ConfigError =>
  new ConfigError({
    issues: Object.freeze(
      errors.map((error) => {
        let category: ConfigIssue["category"] = "constraint";
        if (error.keyword === "required") category = "missing";
        if (error.keyword === "type") category = "type";
        const missing: unknown = error.params.missingProperty;
        const path =
          error.keyword === "required" && typeof missing === "string"
            ? `${error.instancePath}/${missing.replaceAll("~", "~0").replaceAll("/", "~1")}`
            : error.instancePath;
        return Object.freeze({
          path,
          category,
          message: {
            missing: "Required configuration field is missing",
            type: "Configuration field has an invalid type",
            constraint: "Configuration field does not satisfy its constraints",
          }[category],
        });
      }),
    ),
  });

/** Defines a lazy singleton configuration provider; explicit sources completely replace process.env. */
export function defineAppConfig<P extends TProperties>(options: {
  readonly properties: P;
  readonly source?: Readonly<Record<string, string | undefined>>;
}): AppConfigModule<P> {
  const module = createModule().task(
    "appConfig",
    [],
    () =>
      ResultTask.sync(() => {
        const schema = Type.Object(options.properties, { additionalProperties: false });
        const coercing = new Ajv({
          allErrors: true,
          coerceTypes: true,
          useDefaults: true,
          removeAdditional: true,
          strictNumbers: true,
          allowUnionTypes: true,
        });
        // Schema compilation failures are defects, not invalid environment input.
        const normalize = coercing.compile(schema);
        // Revalidate the normalized copy even when coercion reports other errors:
        // this aggregates overflow and unrelated invalid fields in one failure.
        const ajv = new Ajv({ allErrors: true, strictNumbers: true, allowUnionTypes: true });
        ajv.compile(schema);
        const data = { ...(options.source ?? process.env) };
        normalize(data);
        try {
          const value = envSchema<Static<TObject<P>>>({
            schema,
            data,
            env: false,
            dotenv: false,
            expandEnv: false,
            ajv,
          });
          return ResultTask.ok(value);
        } catch (error) {
          if (
            error instanceof Error &&
            "errors" in error &&
            ajv.errors !== null &&
            ajv.errors !== undefined &&
            error.errors === ajv.errors
          ) {
            return ResultTask.err(configError(ajv.errors));
          }
          throw error;
        }
      }).andThen((task) => task),
    { lifetime: "singleton" },
  );
  return Object.assign(module, {
    properties: options.properties,
    load: (): ResultTask<Static<TObject<P>>, ConfigError> =>
      module.use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig)),
  });
}
