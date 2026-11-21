import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Type, type Static, type TObject, type TProperties } from "typebox";
import { createTaggedError, ResultTask, type TaggedErrorClass } from "resultar";
import { createModule, type ServiceModule } from "resultar-di";

export { Type as t } from "typebox";

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

interface CompiledConfigValidators<P extends TProperties> {
  readonly normalize: ValidateFunction;
  readonly validate: ValidateFunction<Static<TObject<P>>>;
}

/** Defines a lazy singleton configuration provider; explicit sources completely replace process.env. */
export function defineAppConfig<P extends TProperties>(options: {
  readonly properties: P;
  readonly source?: Readonly<Record<string, string | undefined>>;
}): AppConfigModule<P> {
  let compiled: CompiledConfigValidators<P> | undefined = undefined;
  const module = createModule().task(
    "appConfig",
    [],
    () =>
      ResultTask.sync(() => {
        if (compiled === undefined) {
          const schema = Type.Object(options.properties, { additionalProperties: false });
          const coercing = new Ajv({
            allErrors: true,
            coerceTypes: true,
            useDefaults: true,
            removeAdditional: true,
            strictNumbers: true,
            allowUnionTypes: true,
          });
          // Schema compilation failures (including EvalError under --disallow-code-generation-from-strings)
          // are runtime defects, not invalid environment input.
          const normalize = coercing.compile(schema);
          // Revalidate the normalized copy even when coercion reports other errors:
          // this aggregates overflow and unrelated invalid fields in one failure.
          const ajv = new Ajv({ allErrors: true, strictNumbers: true, allowUnionTypes: true });
          const validate = ajv.compile<Static<TObject<P>>>(schema);
          compiled = { normalize, validate };
        }
        const { normalize, validate } = compiled;
        const data: Record<string, unknown> = { ...(options.source ?? process.env) };
        normalize(data);
        if (!validate(data)) {
          return ResultTask.err(configError(validate.errors ?? []));
        }
        return ResultTask.ok(data);
      }).andThen((task) => task),
    { lifetime: "singleton" },
  );
  return Object.assign(module, {
    properties: options.properties,
    load: (): ResultTask<Static<TObject<P>>, ConfigError> =>
      module.use(["appConfig"], ({ appConfig }) => ResultTask.ok(appConfig)),
  });
}
