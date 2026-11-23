import type { ServiceLifetime } from "./module.js";

export type SyncDefinitionKind = "value" | "sync" | "task" | "resource" | "class" | "provider";

export interface SyncAnalyzableDefinition {
  readonly kind: SyncDefinitionKind;
  readonly dependencies: readonly string[];
  readonly lifetime: ServiceLifetime;
  readonly constantValue?: unknown;
  readonly rawSyncFactory?: (services: Readonly<Record<string, unknown>>) => unknown;
  readonly syncDependencyMap?: readonly (readonly [string, string])[];
  readonly syncAssert?: (value: unknown) => void;
}

export interface CompiledSyncPlan {
  readonly tier: 0 | 1;
  readonly resolve: (
    rootCache: Map<string, unknown>,
    locals: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

type PlanStep =
  | { readonly kind: "constant"; readonly name: string; readonly value: unknown }
  | { readonly kind: "local"; readonly name: string }
  | {
      readonly kind: "singleton" | "scoped" | "transient";
      readonly name: string;
      readonly deps: readonly (readonly [string, number])[];
      readonly factory: (services: Readonly<Record<string, unknown>>) => unknown;
      readonly assertSync: (value: unknown) => void;
    };

const MAX_DI_JIT_NODES = 128;
const EMPTY_FROZEN: Readonly<Record<string, unknown>> = Object.freeze({});
const lifetimeRank: Record<ServiceLifetime, number> = { transient: 0, scoped: 1, singleton: 2 };

let diJitCapability: boolean | undefined = undefined;

const isEnvJitDisabled = (): boolean => {
  try {
    const env = (
      globalThis as { readonly process?: { readonly env?: { readonly RESULTAR_JIT?: string } } }
    ).process?.env;
    const flag = env?.RESULTAR_JIT;
    return flag === "0" || flag === "false";
  } catch {
    return false;
  }
};

const canUseDiJit = (): boolean => {
  if (isEnvJitDisabled()) return false;
  if (diJitCapability !== undefined) return diJitCapability;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const probe = new Function("return 1") as () => number;
    diJitCapability = probe() === 1;
  } catch {
    diJitCapability = false;
  }
  return diJitCapability;
};

const serializeLiteral = (value: string): string =>
  JSON.stringify(value)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);

const buildObjectLiteral = (entries: readonly (readonly [string, string])[]): string => {
  if (entries.length === 0) return "EMPTY";
  const fields = entries.map(([key, expr]) =>
    key === "__proto__"
      ? `[${serializeLiteral(key)}]: ${expr}`
      : `${serializeLiteral(key)}: ${expr}`,
  );
  return `Object.freeze({ ${fields.join(", ")} })`;
};

const setOwnProperty = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  target[key] = value;
};

interface FallbackRuntimeState {
  readonly rootCache: Map<string, unknown>;
  readonly locals: Readonly<Record<string, unknown>>;
}

const buildDependencyRecord = (
  deps: readonly (readonly [string, number])[],
  values: readonly unknown[],
): Readonly<Record<string, unknown>> => {
  if (deps.length === 0) return EMPTY_FROZEN;
  const record: Record<string, unknown> = {};
  for (const [propKey, depIndex] of deps) {
    setOwnProperty(record, propKey, values[depIndex]);
  }
  return Object.freeze(record);
};

const evaluateFallbackStep = (
  step: PlanStep,
  values: readonly unknown[],
  state: FallbackRuntimeState,
): unknown => {
  if (step.kind === "constant") return step.value;
  if (step.kind === "local") return state.locals[step.name];
  if (step.kind === "singleton" && state.rootCache.has(step.name)) {
    return state.rootCache.get(step.name);
  }
  const created = step.factory(buildDependencyRecord(step.deps, values));
  step.assertSync(created);
  if (step.kind === "singleton") state.rootCache.set(step.name, created);
  return created;
};

const buildFallbackPlan = (
  tier: 0 | 1,
  steps: readonly PlanStep[],
  outputRefs: readonly (readonly [string, number])[],
): CompiledSyncPlan => {
  let cached: Readonly<Record<string, unknown>> | undefined = undefined;
  return {
    tier,
    resolve: (rootCache, locals) => {
      if (tier === 0 && cached !== undefined) return cached;
      const state: FallbackRuntimeState = { rootCache, locals };
      const values: unknown[] = [];
      for (const step of steps) {
        values.push(evaluateFallbackStep(step, values, state));
      }
      const output: Record<string, unknown> = {};
      for (const [key, stepIndex] of outputRefs) {
        setOwnProperty(output, key, values[stepIndex]);
      }
      const frozen = Object.freeze(output);
      if (tier === 0) cached = frozen;
      return frozen;
    },
  };
};

const emitPlanStepLines = (
  step: PlanStep,
  index: number,
  bind: (value: unknown) => string,
): readonly string[] => {
  const vName = `v${String(index)}`;
  if (step.kind === "constant") {
    return [`  const ${vName} = ${bind(step.value)};`];
  }
  if (step.kind === "local") {
    return [`  const ${vName} = locals[${serializeLiteral(step.name)}];`];
  }
  const fParam = bind(step.factory);
  const aParam = bind(step.assertSync);
  const depExpr = buildObjectLiteral(
    step.deps.map(([propKey, depIndex]) => [propKey, `v${String(depIndex)}`] as const),
  );
  if (step.kind === "singleton") {
    const nameLit = serializeLiteral(step.name);
    return [
      `  let ${vName};`,
      `  if (rootCache.has(${nameLit})) {`,
      `    ${vName} = rootCache.get(${nameLit});`,
      "  } else {",
      `    ${vName} = ${fParam}(${depExpr});`,
      `    ${aParam}(${vName});`,
      `    rootCache.set(${nameLit}, ${vName});`,
      "  }",
    ];
  }
  return [`  const ${vName} = ${fParam}(${depExpr});`, `  ${aParam}(${vName});`];
};

const compileJitPlan = (
  tier: 0 | 1,
  steps: readonly PlanStep[],
  outputRefs: readonly (readonly [string, number])[],
): CompiledSyncPlan | undefined => {
  if (!canUseDiJit()) return undefined;
  const paramNames: string[] = ["EMPTY"];
  const paramValues: unknown[] = [EMPTY_FROZEN];
  const bind = (value: unknown): string => {
    const name = `p${String(paramNames.length)}`;
    paramNames.push(name);
    paramValues.push(value);
    return name;
  };

  const lines: string[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step !== undefined) {
      lines.push(...emitPlanStepLines(step, index, bind));
    }
  }

  const outExpr = buildObjectLiteral(
    outputRefs.map(([key, stepIndex]) => [key, `v${String(stepIndex)}`] as const),
  );

  const body =
    tier === 0
      ? `"use strict";\nlet cached = undefined;\nreturn function resultarDiTier0(rootCache) {\n  if (cached !== undefined) return cached;\n${lines.join("\n")}\n  cached = ${outExpr};\n  return cached;\n};`
      : `"use strict";\nreturn function resultarDiTier1(rootCache, locals) {\n${lines.join("\n")}\n  return ${outExpr};\n};`;

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...paramNames, body) as (
      ...args: readonly unknown[]
    ) => CompiledSyncPlan["resolve"];
    return { tier, resolve: factory(...paramValues) };
  } catch {
    return undefined;
  }
};

const isEligibleSyncDefinition = (
  def: SyncAnalyzableDefinition | undefined,
  parentLifetime?: ServiceLifetime,
): def is SyncAnalyzableDefinition => {
  if (def === undefined) return false;
  if (parentLifetime !== undefined && lifetimeRank[parentLifetime] > lifetimeRank[def.lifetime]) {
    return false;
  }
  return def.kind === "value" || (def.kind === "sync" && def.rawSyncFactory !== undefined);
};

/**
 * Statically analyzes the subgraph reachable from `keys` and compiles a flat sync resolver
 * when all reachable services are pure values or synchronous factories with no resource ownership.
 */
export const compileSyncSubgraph = (
  definitions: ReadonlyMap<string, SyncAnalyzableDefinition>,
  keys: readonly string[],
  localKeys: readonly string[],
  defaultAssertSync: (value: unknown) => void,
  requestedBy?: ServiceLifetime,
): CompiledSyncPlan | undefined => {
  if (keys.length === 0) {
    return { tier: 0, resolve: () => EMPTY_FROZEN };
  }

  const localKeySet = new Set(localKeys);
  const stepIndexByName = new Map<string, number>();
  const visiting = new Set<string>();
  const steps: PlanStep[] = [];
  let hasNonSingleton = localKeys.length > 0;

  const recordStep = (name: string, step: PlanStep, cacheable: boolean): number => {
    const idx = steps.length;
    steps.push(step);
    if (cacheable) stepIndexByName.set(name, idx);
    return idx;
  };

  const visitLocal = (name: string, parentLifetime?: ServiceLifetime): number | undefined => {
    if (parentLifetime === "singleton") return undefined;
    const existing = stepIndexByName.get(name);
    if (existing !== undefined) return existing;
    hasNonSingleton = true;
    return recordStep(name, { kind: "local", name }, true);
  };

  const visitDependencies = (
    def: SyncAnalyzableDefinition,
    visitNode: (depName: string, lifetime: ServiceLifetime) => number | undefined,
  ): readonly (readonly [string, number])[] | undefined => {
    const depMap = def.syncDependencyMap ?? def.dependencies.map((dep) => [dep, dep] as const);
    const resolvedDeps: (readonly [string, number])[] = [];
    for (const [propKey, depName] of depMap) {
      const depIdx = visitNode(depName, def.lifetime);
      if (depIdx === undefined) return undefined;
      resolvedDeps.push([propKey, depIdx]);
    }
    return resolvedDeps;
  };

  const visit = (name: string, parentLifetime?: ServiceLifetime): number | undefined => {
    if (steps.length >= MAX_DI_JIT_NODES || visiting.has(name)) return undefined;
    if (localKeySet.has(name)) return visitLocal(name, parentLifetime);

    const def = definitions.get(name);
    if (!isEligibleSyncDefinition(def, parentLifetime)) return undefined;

    const cacheable = def.lifetime !== "transient";
    if (cacheable) {
      const existing = stepIndexByName.get(name);
      if (existing !== undefined) return existing;
    }
    if (def.lifetime !== "singleton") hasNonSingleton = true;
    if (def.kind === "value") {
      return recordStep(name, { kind: "constant", name, value: def.constantValue }, true);
    }

    visiting.add(name);
    const resolvedDeps = visitDependencies(def, visit);
    visiting.delete(name);
    if (resolvedDeps === undefined || def.rawSyncFactory === undefined) return undefined;

    return recordStep(
      name,
      {
        kind: def.lifetime,
        name,
        deps: resolvedDeps,
        factory: def.rawSyncFactory,
        assertSync: def.syncAssert ?? defaultAssertSync,
      },
      cacheable,
    );
  };

  const outputRefs: (readonly [string, number])[] = [];
  for (const key of keys) {
    const idx = visit(key, requestedBy);
    if (idx === undefined) return undefined;
    outputRefs.push([key, idx]);
  }

  const tier: 0 | 1 = hasNonSingleton ? 1 : 0;
  return compileJitPlan(tier, steps, outputRefs) ?? buildFallbackPlan(tier, steps, outputRefs);
};
