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

const STEP_CONSTANT = 0;
const STEP_LOCAL = 1;
const STEP_SINGLETON = 2;
const STEP_DYNAMIC = 3;

interface RecordSpec {
  readonly count: number;
  readonly k0: string;
  readonly i0: number;
  readonly k1: string;
  readonly i1: number;
  readonly k2: string;
  readonly i2: number;
  readonly entries: readonly (readonly [string, number])[];
}

type PlanStep =
  | { readonly tag: typeof STEP_CONSTANT; readonly value: unknown }
  | { readonly tag: typeof STEP_LOCAL; readonly name: string }
  | {
      readonly tag: typeof STEP_SINGLETON | typeof STEP_DYNAMIC;
      readonly name: string;
      readonly deps: RecordSpec;
      readonly factory: (services: Readonly<Record<string, unknown>>) => unknown;
      readonly assertSync: (value: unknown) => void;
    };

const MAX_DI_PLAN_NODES = 128;
const EMPTY_FROZEN: Readonly<Record<string, unknown>> = Object.freeze({});
const lifetimeRank: Record<ServiceLifetime, number> = { transient: 0, scoped: 1, singleton: 2 };

type CompiledStepFn = (
  rootCache: Map<string, unknown>,
  locals: Readonly<Record<string, unknown>>,
) => unknown;

const compileDirectStep = (step: PlanStep, stepFns: readonly CompiledStepFn[]): CompiledStepFn => {
  if (step.tag === STEP_CONSTANT) {
    const { value } = step;
    return () => value;
  }
  if (step.tag === STEP_LOCAL) {
    const { name } = step;
    return (_rootCache, locals) => locals[name];
  }
  const { deps, factory, assertSync } = step;
  const resolveDeps: CompiledStepFn = compileDepsRecord(deps, stepFns);
  if (step.tag === STEP_SINGLETON) {
    const { name } = step;
    return (rootCache, locals) => {
      const existing = rootCache.get(name);
      if (existing !== undefined || rootCache.has(name)) {
        return existing;
      }
      const created = factory(resolveDeps(rootCache, locals) as Readonly<Record<string, unknown>>);
      assertSync(created);
      rootCache.set(name, created);
      return created;
    };
  }
  return (rootCache, locals) => {
    const created = factory(resolveDeps(rootCache, locals) as Readonly<Record<string, unknown>>);
    assertSync(created);
    return created;
  };
};

const compileDepsRecord = (
  spec: RecordSpec,
  stepFns: readonly CompiledStepFn[],
): CompiledStepFn => {
  const { count } = spec;
  if (count === 0) return () => EMPTY_FROZEN;
  if (count === 1) {
    const { k0 } = spec;
    const f0 = stepFns[spec.i0];
    return (rc, locals) => Object.freeze({ [k0]: f0?.(rc, locals) });
  }
  if (count === 2) {
    const { k0, k1 } = spec;
    const f0 = stepFns[spec.i0];
    const f1 = stepFns[spec.i1];
    return (rc, locals) => Object.freeze({ [k0]: f0?.(rc, locals), [k1]: f1?.(rc, locals) });
  }
  if (count === 3) {
    const { k0, k1, k2 } = spec;
    const f0 = stepFns[spec.i0];
    const f1 = stepFns[spec.i1];
    const f2 = stepFns[spec.i2];
    return (rc, locals) =>
      Object.freeze({ [k0]: f0?.(rc, locals), [k1]: f1?.(rc, locals), [k2]: f2?.(rc, locals) });
  }
  const compiledEntries = spec.entries.map(([key, idx]) => [key, stepFns[idx]] as const);
  return (rc, locals) => {
    const record: Record<string, unknown> = {};
    for (const [key, fn] of compiledEntries) {
      defineDataProperty(record, key, fn?.(rc, locals));
    }
    return Object.freeze(record);
  };
};

const isSingleEvalStep = (step: PlanStep): boolean =>
  step.tag === STEP_DYNAMIC || step.tag === STEP_LOCAL;

const countStepReferences = (
  steps: readonly PlanStep[],
  outputRefs: readonly (readonly [string, number])[],
): number[] => {
  const refCounts = Array.from({ length: steps.length }, () => 0);
  for (const step of steps) {
    if (step.tag === STEP_SINGLETON || step.tag === STEP_DYNAMIC) {
      for (const [, idx] of step.deps.entries) {
        refCounts[idx] = (refCounts[idx] ?? 0) + 1;
      }
    }
  }
  for (const [, idx] of outputRefs) {
    refCounts[idx] = (refCounts[idx] ?? 0) + 1;
  }
  return refCounts;
};

const isTreeShapedPlan = (
  steps: readonly PlanStep[],
  outputRefs: readonly (readonly [string, number])[],
): boolean => {
  // Pure tree (each per-request step referenced at most once) can execute directly without a values[] table.
  const refCounts = countStepReferences(steps, outputRefs);
  return steps.every((step, i) => !isSingleEvalStep(step) || (refCounts[i] ?? 0) <= 1);
};

const compilePureClosureTier1 = (
  steps: readonly PlanStep[],
  outputSpec: RecordSpec,
): CompiledSyncPlan["resolve"] | undefined => {
  if (!isTreeShapedPlan(steps, outputSpec.entries)) {
    return undefined;
  }
  const stepFns: CompiledStepFn[] = [];
  for (const step of steps) {
    stepFns.push(compileDirectStep(step, stepFns));
  }
  const resolveOutput = compileDepsRecord(outputSpec, stepFns);
  return (rootCache, locals) =>
    resolveOutput(rootCache, locals) as Readonly<Record<string, unknown>>;
};

const defineDataProperty = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (key in target) {
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

const makeRecordSpec = (entries: readonly (readonly [string, number])[]): RecordSpec => {
  const [e0, e1, e2] = entries;
  return {
    count: entries.length,
    k0: e0 === undefined ? "" : e0[0],
    i0: e0 === undefined ? 0 : e0[1],
    k1: e1 === undefined ? "" : e1[0],
    i1: e1 === undefined ? 0 : e1[1],
    k2: e2 === undefined ? "" : e2[0],
    i2: e2 === undefined ? 0 : e2[1],
    entries,
  };
};

const buildRecord = (
  spec: RecordSpec,
  values: readonly unknown[],
): Readonly<Record<string, unknown>> => {
  const { count } = spec;
  if (count === 0) return EMPTY_FROZEN;
  // Computed object literal properties call CreateDataPropertyOrThrow, bypassing
  // both "__proto__" mutation and any inherited setters on Object.prototype.
  if (count === 1) {
    return Object.freeze({ [spec.k0]: values[spec.i0] });
  }
  if (count === 2) {
    return Object.freeze({ [spec.k0]: values[spec.i0], [spec.k1]: values[spec.i1] });
  }
  if (count === 3) {
    return Object.freeze({
      [spec.k0]: values[spec.i0],
      [spec.k1]: values[spec.i1],
      [spec.k2]: values[spec.i2],
    });
  }
  const record: Record<string, unknown> = {};
  for (const [key, idx] of spec.entries) {
    defineDataProperty(record, key, values[idx]);
  }
  return Object.freeze(record);
};

const evaluateStep = (
  step: PlanStep,
  values: readonly unknown[],
  rootCache: Map<string, unknown>,
  locals: Readonly<Record<string, unknown>>,
): unknown => {
  if (step.tag === STEP_CONSTANT) return step.value;
  if (step.tag === STEP_LOCAL) return locals[step.name];
  if (step.tag === STEP_SINGLETON) {
    const existing = rootCache.get(step.name);
    if (existing !== undefined || rootCache.has(step.name)) {
      return existing;
    }
    const created = step.factory(buildRecord(step.deps, values));
    step.assertSync(created);
    rootCache.set(step.name, created);
    return created;
  }
  const created = step.factory(buildRecord(step.deps, values));
  step.assertSync(created);
  return created;
};

const runPlanSteps = (
  steps: readonly PlanStep[],
  outputSpec: RecordSpec,
  rootCache: Map<string, unknown>,
  locals: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const values: unknown[] = [];
  for (const step of steps) {
    values.push(evaluateStep(step, values, rootCache, locals));
  }
  return buildRecord(outputSpec, values);
};

const buildSyncPlan = (
  tier: 0 | 1,
  steps: readonly PlanStep[],
  outputRefs: readonly (readonly [string, number])[],
): CompiledSyncPlan => {
  const outputSpec = makeRecordSpec(outputRefs);
  if (tier === 0) {
    let cached: Readonly<Record<string, unknown>> | undefined = undefined;
    return {
      tier: 0,
      resolve: (rootCache, locals) => {
        if (cached !== undefined) return cached;
        cached = runPlanSteps(steps, outputSpec, rootCache, locals);
        return cached;
      },
    };
  }
  const compiled = compilePureClosureTier1(steps, outputSpec);
  if (compiled !== undefined) {
    return { tier: 1, resolve: compiled };
  }
  return {
    tier: 1,
    resolve: (rootCache, locals) => runPlanSteps(steps, outputSpec, rootCache, locals),
  };
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
 * Statically analyzes the subgraph reachable from `keys` and builds a flat, CSP-safe
 * synchronous resolver (zero dynamic code generation) when all reachable services are
 * pure values or synchronous factories with no resource ownership.
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
    return recordStep(name, { tag: STEP_LOCAL, name }, true);
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
    if (steps.length >= MAX_DI_PLAN_NODES || visiting.has(name)) return undefined;
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
      return recordStep(name, { tag: STEP_CONSTANT, value: def.constantValue }, true);
    }

    visiting.add(name);
    const resolvedDeps = visitDependencies(def, visit);
    visiting.delete(name);
    if (resolvedDeps === undefined || def.rawSyncFactory === undefined) return undefined;

    return recordStep(
      name,
      {
        tag: def.lifetime === "singleton" ? STEP_SINGLETON : STEP_DYNAMIC,
        name,
        deps: makeRecordSpec(resolvedDeps),
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
  return buildSyncPlan(tier, steps, outputRefs);
};
