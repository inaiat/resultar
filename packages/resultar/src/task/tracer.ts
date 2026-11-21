import type { Exit } from './result-task.js'

/** Primitive or homogeneous primitive-array attribute value attached to a task span. */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]

/** Key-value metadata map attached to a span. Undefined entries are ignored. */
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue | undefined>>

/** Immutable frame captured in a failure's logical span stack trace. */
export interface SpanTraceFrame {
  readonly name: string
  readonly attributes?: SpanAttributes | undefined
}

/** Internal singly-linked stack node for zero-copy span inheritance across fibers. */
export interface SpanStackNode {
  readonly frame: SpanTraceFrame
  readonly span: TaskSpan | undefined
  readonly parent: SpanStackNode | undefined
}

/** Active span handle returned by a {@link TaskTracer}. */
export interface TaskSpan {
  readonly name: string
  readonly setAttribute?: (key: string, value: SpanAttributeValue) => void
  readonly end: (exit: Exit<unknown, unknown>, endTime?: number) => void
}

/** Context passed to {@link TaskTracer.startSpan} when entering a `withSpan` or named `ResultTask.fn` boundary. */
export interface TaskTracerStartOptions {
  readonly attributes?: SpanAttributes | undefined
  readonly parent?: TaskSpan | undefined
  readonly startTime: number
}

/**
 * Lightweight, dependency-free tracing hook accepted in `ResultTask` run options (`{ tracer }`).
 *
 * Designed to adapt cleanly to OpenTelemetry (`@opentelemetry/api`) or custom structured telemetry
 * without pulling tracing dependencies into `resultar`.
 */
export interface TaskTracer {
  readonly startSpan: (name: string, options: TaskTracerStartOptions) => TaskSpan
}

/** Completed or active span entry recorded by {@link Tracer.memory}. */
export interface RecordedSpan {
  readonly name: string
  readonly parentName: string | undefined
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>
  readonly startTime: number
  readonly endTime: number | undefined
  readonly durationMs: number | undefined
  readonly exit: Exit<unknown, unknown> | undefined
}

/** In-memory tracer handle useful for testing span hierarchies, attributes, and virtual-clock durations. */
export interface MemoryTracer extends TaskTracer {
  readonly tracer: TaskTracer
  readonly spans: readonly RecordedSpan[]
  readonly clear: () => void
}

const causeSpanTraces = new WeakMap<object, readonly SpanTraceFrame[]>()
const EMPTY_SPAN_TRACE: readonly SpanTraceFrame[] = Object.freeze([])

/** Attaches a logical span stack trace (innermost-first) to a cause if none is recorded yet. */
export const attachCauseSpans = (cause: object, stack: SpanStackNode | undefined): void => {
  if (stack === undefined || causeSpanTraces.has(cause)) return
  const frames: SpanTraceFrame[] = []
  let current: SpanStackNode | undefined = stack
  while (current !== undefined) {
    frames.push(current.frame)
    current = current.parent
  }
  causeSpanTraces.set(cause, Object.freeze(frames))
}

/** Copies an existing logical span trace from `source` to `target` without overwriting an existing trace. */
export const copyCauseSpans = (source: object, target: object): void => {
  const frames = causeSpanTraces.get(source)
  if (frames !== undefined && !causeSpanTraces.has(target)) {
    causeSpanTraces.set(target, frames)
  }
}

/** Returns the logical span stack attached to `cause` (innermost-first), or an empty array. */
export const getCauseSpans = (cause: object): readonly SpanTraceFrame[] =>
  causeSpanTraces.get(cause) ?? EMPTY_SPAN_TRACE

const sanitizeAttributes = (
  attributes: SpanAttributes | undefined,
): Record<string, SpanAttributeValue> => {
  const clean: Record<string, SpanAttributeValue> = {}
  if (attributes === undefined) return clean
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) clean[key] = value
  }
  return clean
}

const NOOP_SPAN: TaskSpan = Object.freeze({ name: '', end: () => undefined })

const noopTracer: TaskTracer = Object.freeze({ startSpan: () => NOOP_SPAN })

interface MutableRecordedSpan {
  readonly name: string
  readonly parentName: string | undefined
  readonly attributes: Record<string, SpanAttributeValue>
  readonly startTime: number
  endTime: number | undefined
  durationMs: number | undefined
  exit: Exit<unknown, unknown> | undefined
}

const createMemoryTracer = (): MemoryTracer => {
  const recorded: MutableRecordedSpan[] = []
  const tracer: TaskTracer = {
    startSpan: (name, options) => {
      const entry: MutableRecordedSpan = {
        name,
        parentName: options.parent?.name,
        attributes: sanitizeAttributes(options.attributes),
        startTime: options.startTime,
        endTime: undefined,
        durationMs: undefined,
        exit: undefined,
      }
      recorded.push(entry)
      return {
        name,
        setAttribute: (key, value) => {
          entry.attributes[key] = value
        },
        end: (exit, endTime) => {
          entry.exit = exit
          entry.endTime = endTime
          entry.durationMs = endTime === undefined ? undefined : endTime - entry.startTime
        },
      }
    },
  }
  return {
    tracer,
    startSpan: tracer.startSpan,
    get spans(): readonly RecordedSpan[] {
      return recorded
    },
    clear: () => {
      recorded.length = 0
    },
  }
}

/**
 * Built-in {@link TaskTracer} helpers for opt-in observability and deterministic span testing.
 *
 * @example
 * ```ts
 * import { ResultTask, Tracer } from 'resultar'
 *
 * const memory = Tracer.memory()
 * const task = ResultTask.ok(42).withSpan('answer.compute', { source: 'cache' })
 * await task.runResult({ tracer: memory.tracer })
 * // memory.spans[0]?.name === 'answer.compute'
 * ```
 */
export const Tracer: {
  /** Zero-op tracer that discards all span events. */
  readonly noop: TaskTracer
  /** Creates an in-memory tracer that records span hierarchy, attributes, timing, and exits. */
  readonly memory: () => MemoryTracer
} = Object.freeze({ noop: noopTracer, memory: createMemoryTracer })
