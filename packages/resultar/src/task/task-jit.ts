import { compileJitFunction, MAX_JIT_STEPS, serializeStringLiteral } from '../core/jit.js'
import type { Cause } from './cause.js'
import type { Exit } from './result-task.js'
import type { ResultTaskRuntimeContext } from './task-service.js'

// Leaf / terminal opcodes: 0..6
export const OP_SUCCESS = 0
export const OP_FAIL = 1
export const OP_SYNC = 2
export const OP_TRY_PROMISE = 3
export const OP_GEN = 4
export const OP_ASYNC = 5
export const OP_CUSTOM = 6
// Combinator / continuation opcodes: 7..15 (single check `op >= OP_FLAT_MAP`)
export const OP_FLAT_MAP = 7
export const OP_MAP = 8
export const OP_MAP_ERROR = 9
export const OP_TAP = 10
export const OP_TAP_ERROR = 11
export const OP_TAP_BOTH = 12
export const OP_CATCH_ALL = 13
export const OP_CATCH_TAG = 14
export const OP_CATCH_TAGS = 15

export interface CatchTagContinuation {
  readonly tag: string
  readonly handler: (error: unknown) => unknown
}

export interface TaskNodeLike {
  readonly op: number
  readonly value: unknown
  readonly continuation: unknown
  readonly run: (
    context: ResultTaskRuntimeContext,
  ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
}

export interface TaskJitHelpers {
  readonly NEVER_ABORTED_SIGNAL: AbortSignal
  readonly success: (value: unknown) => Exit<unknown, unknown>
  readonly failed: (error: unknown) => Exit<unknown, unknown>
  readonly died: (defect: unknown) => Exit<unknown, unknown>
  readonly interrupted: (signal: AbortSignal) => Exit<unknown, unknown>
  readonly failure: (cause: Cause<unknown>) => Exit<unknown, unknown>
  readonly isResultTask: (value: unknown) => value is TaskNodeLike
  readonly isPromiseExit: (
    value: Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>,
  ) => value is Promise<Exit<unknown, unknown>>
  readonly executeTryPromise: (
    tryFn: (signal: AbortSignal) => PromiseLike<unknown>,
    catchFn: ((error: unknown) => unknown) | undefined,
    context: ResultTaskRuntimeContext,
  ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  readonly runGen: (
    genFn: (arg: never) => Generator<unknown, unknown, never>,
    arg: unknown,
    context: ResultTaskRuntimeContext,
  ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  readonly transformCause: (
    cause: Cause<unknown>,
    mapFail: (leaf: Cause<unknown>) => Cause<unknown>,
  ) => Cause<unknown>
  readonly getTaggedHandler: (
    value: unknown,
    handlers: object,
  ) => ((error: unknown) => unknown) | undefined
  readonly createCauseError: (cause: Cause<unknown>) => Error
  readonly runSlow: (
    task: TaskNodeLike,
    context: ResultTaskRuntimeContext,
  ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  readonly createAsyncResumer: (
    steps: readonly TaskNodeLike[],
  ) => (
    pending: Promise<Exit<unknown, unknown>>,
    fromIndex: number,
    context: ResultTaskRuntimeContext,
  ) => Promise<Exit<unknown, unknown>>
  readonly createSyncResumer: (
    steps: readonly TaskNodeLike[],
  ) => (
    exit: Exit<unknown, unknown>,
    fromIndex: number,
    context: ResultTaskRuntimeContext,
  ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
}

const isCompilableCombinator = (op: number): boolean =>
  op === OP_MAP ||
  op === OP_FLAT_MAP ||
  op === OP_MAP_ERROR ||
  op === OP_CATCH_ALL ||
  op === OP_CATCH_TAG ||
  op === OP_CATCH_TAGS

const isCompilableLeaf = (op: number): boolean => op >= OP_SUCCESS && op <= OP_ASYNC

interface CollectedChain {
  readonly leaf: TaskNodeLike
  readonly steps: readonly TaskNodeLike[]
}

const collectChain = (rootTask: TaskNodeLike): CollectedChain | undefined => {
  const reversed: TaskNodeLike[] = []
  let cursor = rootTask

  while (cursor.op >= OP_FLAT_MAP) {
    if (!isCompilableCombinator(cursor.op) || reversed.length >= MAX_JIT_STEPS) {
      return undefined
    }
    reversed.push(cursor)
    cursor = cursor.value as TaskNodeLike
  }

  if (reversed.length < 2 || !isCompilableLeaf(cursor.op)) {
    return undefined
  }

  reversed.reverse()
  return { leaf: cursor, steps: reversed }
}

class TaskCodeBuilder {
  public readonly paramNames: string[] = []
  public readonly paramValues: unknown[] = []

  public bind(value: unknown): string {
    const name = `p${String(this.paramNames.length)}`
    this.paramNames.push(name)
    this.paramValues.push(value)
    return name
  }
}

interface TaskEmitContext {
  readonly b: TaskCodeBuilder
  readonly totalSteps: number
}

const emitLeafInit = (ctx: TaskEmitContext, leaf: TaskNodeLike): string => {
  const { b } = ctx
  switch (leaf.op) {
    case OP_SUCCESS: {
      return `  let ok = true, v = ${b.bind(leaf.value)}, ex = undefined, n = undefined;`
    }
    case OP_FAIL: {
      return `  let ok = false, v = undefined, ex = failed(${b.bind(leaf.value)}), n = undefined;`
    }
    case OP_SYNC: {
      if (leaf.continuation === undefined) {
        const fnParam = b.bind(leaf.value)
        return `  let ok = true, v = undefined, ex = undefined, n = undefined;
  try { v = ${fnParam}(); } catch (e) { ok = false; ex = died(e); }`
      }
      const opts = leaf.continuation as {
        readonly try: () => unknown
        readonly catch: (cause: unknown) => unknown
      }
      const tryParam = b.bind(opts.try)
      const catchParam = b.bind(opts.catch)
      return `  let ok = true, v = undefined, ex = undefined, n = undefined;
  try { v = ${tryParam}(); } catch (e) {
    ok = false;
    try { ex = failed(${catchParam}(e)); } catch (ce) { ex = died(ce); }
  }`
    }
    case OP_TRY_PROMISE: {
      const tryParam = b.bind(leaf.value)
      const catchParam = b.bind(leaf.continuation)
      return `  let ok = false, v = undefined, ex = undefined, n = undefined;
  try { ex = executeTryPromise(${tryParam}, ${catchParam}, ctx); } catch (e) { ex = died(e); }
  if (isPromise(ex)) return resumeAsync(ex, 0, ctx);
  if (ex._tag === "Success") { ok = true; v = ex.value; ex = undefined; }`
    }
    case OP_GEN: {
      const argParam = b.bind(leaf.value)
      const genParam = b.bind(leaf.continuation)
      return `  let ok = false, v = undefined, ex = undefined, n = undefined;
  try { ex = runGen(${genParam}, ${argParam}, ctx); } catch (e) { ex = died(e); }
  if (isPromise(ex)) return resumeAsync(ex, 0, ctx);
  if (ex._tag === "Success") { ok = true; v = ex.value; ex = undefined; }`
    }
    default: {
      const execParam = b.bind(leaf.value)
      return `  let ok = false, v = undefined, ex = undefined, n = undefined;
  try { ex = ${execParam}(ctx); } catch (e) { ex = died(e); }
  if (isPromise(ex)) return resumeAsync(ex, 0, ctx);
  if (ex._tag === "Success") { ok = true; v = ex.value; ex = undefined; }`
    }
  }
}

interface TaskStepEmitSpec {
  readonly invokeExpr: string
  readonly setOkOnSuccess: boolean
}

const emitTaskOrResultStep = (
  ctx: TaskEmitContext,
  stepIndex: number,
  spec: TaskStepEmitSpec,
): string => {
  const nextIndex = stepIndex + 1
  const remaining = (ctx.totalSteps - nextIndex) * 2 + 2
  const okAssign = spec.setOkOnSuccess ? 'ok = true; ' : ''
  const clearEx = spec.setOkOnSuccess ? ' ex = undefined;' : ''
  return `      try {
        n = ${spec.invokeExpr};
        if (isTask(n)) {
          if (track && sig.aborted) return interrupted(sig);
          if (n.op === 0) { sched.remaining -= 1; ${okAssign}v = n.value;${clearEx} }
          else if (n.op === 1) { sched.remaining -= 1; ok = false; ex = failed(n.value); }
          else {
            ex = n.run(ctx);
            if (isPromise(ex)) return resumeAsync(ex, ${String(nextIndex)}, ctx);
            if (ex._tag === "Success") { ${okAssign}v = ex.value; ex = undefined; }
            else { ok = false; }
            if (sched.remaining <= ${String(remaining)}) return resumeSync(ok ? success(v) : ex, ${String(nextIndex)}, ctx);
          }
        } else if (n.isOk()) {
          ${okAssign}v = n.value;${clearEx}
        } else {
          ok = false;
          ex = failed(n.error);
        }
      } catch (e) {
        ok = false;
        ex = died(e);
      }`
}

const emitStepCode = (ctx: TaskEmitContext, step: TaskNodeLike, index: number): string => {
  const { b } = ctx
  switch (step.op) {
    case OP_MAP: {
      const fnParam = b.bind(step.continuation)
      return `  if (ok) {
    if (track && sig.aborted) { ok = false; ex = interrupted(sig); }
    else { try { v = ${fnParam}(v); } catch (e) { ok = false; ex = died(e); } }
  }`
    }
    case OP_FLAT_MAP: {
      const fnParam = b.bind(step.continuation)
      const body = emitTaskOrResultStep(ctx, index, {
        invokeExpr: `${fnParam}(v)`,
        setOkOnSuccess: false,
      })
      return `  if (ok) {
    if (track && sig.aborted) { ok = false; ex = interrupted(sig); }
    else {
${body}
    }
  }`
    }
    case OP_MAP_ERROR: {
      const fn = step.continuation as (error: unknown) => unknown
      const leafMapper = (leaf: Cause<unknown>): Cause<unknown> =>
        leaf._tag === 'Fail' ? { _tag: 'Fail', error: fn(leaf.error) } : leaf
      const mapperParam = b.bind(leafMapper)
      return `  if (!ok) {
    try { ex = failure(transformCause(ex.cause, ${mapperParam})); }
    catch (e) { ex = died(e); }
  }`
    }
    case OP_CATCH_ALL: {
      const fnParam = b.bind(step.continuation)
      const body = emitTaskOrResultStep(ctx, index, {
        invokeExpr: `${fnParam}(c.error)`,
        setOkOnSuccess: true,
      })
      return `  if (!ok) {
    const c = ex.cause;
    if (c._tag === "Sequential" || c._tag === "Parallel") {
      ex = died(createCauseError(c));
    } else if (c._tag === "Fail") {
${body}
    }
  }`
    }
    case OP_CATCH_TAG: {
      const desc = step.continuation as CatchTagContinuation
      const tagLit = serializeStringLiteral(desc.tag)
      const fnParam = b.bind(desc.handler)
      const body = emitTaskOrResultStep(ctx, index, {
        invokeExpr: `${fnParam}(err)`,
        setOkOnSuccess: true,
      })
      return `  if (!ok) {
    const c = ex.cause;
    if (c._tag === "Sequential" || c._tag === "Parallel") {
      ex = died(createCauseError(c));
    } else if (c._tag === "Fail") {
      const err = c.error;
      if (typeof err === "object" && err !== null && "_tag" in err && err._tag === ${tagLit}) {
${body}
      }
    }
  }`
    }
    case OP_CATCH_TAGS: {
      const handlersParam = b.bind(step.continuation)
      const body = emitTaskOrResultStep(ctx, index, {
        invokeExpr: 'h(c.error)',
        setOkOnSuccess: true,
      })
      return `  if (!ok) {
    const c = ex.cause;
    if (c._tag === "Sequential" || c._tag === "Parallel") {
      ex = died(createCauseError(c));
    } else if (c._tag === "Fail") {
      const h = getTaggedHandler(c.error, ${handlersParam});
      if (h !== undefined) {
${body}
      }
    }
  }`
    }
    default: {
      return ''
    }
  }
}

/**
 * Compiles a hot immutable `ResultTask` chain into an unboxed straight-line executor.
 * Returns `undefined` if the chain is ineligible or JIT compilation is unavailable.
 */
export const compileTaskChain = (
  rootTask: TaskNodeLike,
  helpers: TaskJitHelpers,
):
  | ((
      context: ResultTaskRuntimeContext,
    ) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>)
  | undefined => {
  const collected = collectChain(rootTask)
  if (collected === undefined) return undefined

  const { leaf, steps } = collected
  const b = new TaskCodeBuilder()

  const baseParamNames = [
    'NEVER_ABORTED',
    'success',
    'failed',
    'died',
    'interrupted',
    'failure',
    'isTask',
    'isPromise',
    'executeTryPromise',
    'runGen',
    'transformCause',
    'getTaggedHandler',
    'createCauseError',
    'runSlow',
    'resumeAsync',
    'resumeSync',
    'rootTask',
  ]
  const baseParamValues: unknown[] = [
    helpers.NEVER_ABORTED_SIGNAL,
    helpers.success,
    helpers.failed,
    helpers.died,
    helpers.interrupted,
    helpers.failure,
    helpers.isResultTask,
    helpers.isPromiseExit,
    helpers.executeTryPromise,
    helpers.runGen,
    helpers.transformCause,
    helpers.getTaggedHandler,
    helpers.createCauseError,
    helpers.runSlow,
    helpers.createAsyncResumer(steps),
    helpers.createSyncResumer(steps),
    rootTask,
  ]

  let extraBudget = 0
  for (const step of steps) {
    if (step.op === OP_FLAT_MAP || step.op >= OP_CATCH_ALL) {
      extraBudget += 1
    }
  }
  const baseCost = steps.length * 2 + 1
  const requiredBudget = baseCost + extraBudget

  const ctx: TaskEmitContext = { b, totalSteps: steps.length }
  const lines: string[] = [
    '  const sig = ctx.signal;',
    '  const track = sig !== NEVER_ABORTED;',
    '  if (track && sig.aborted) return interrupted(sig);',
    '  const sched = ctx.scheduling;',
    `  if (sched.remaining <= ${String(requiredBudget)}) return runSlow(rootTask, ctx);`,
    `  sched.remaining -= ${String(baseCost)};`,
    emitLeafInit(ctx, leaf),
  ]

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step !== undefined) {
      lines.push(emitStepCode(ctx, step, index))
    }
  }

  lines.push(
    '  if (ok) return track && sig.aborted ? interrupted(sig) : success(v);',
    '  return ex;',
  )

  const body = `return function resultarTaskCompiled(ctx) {\n${lines.join('\n')}\n}`
  return compileJitFunction<
    (context: ResultTaskRuntimeContext) => Exit<unknown, unknown> | Promise<Exit<unknown, unknown>>
  >([...baseParamNames, ...b.paramNames], body, [...baseParamValues, ...b.paramValues])
}
