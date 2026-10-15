import { deepEqual, equal, ok as assertOk, strictEqual } from 'node:assert'
import { describe, expectTypeOf, it } from 'vite-plus/test'

import {
  createTaggedError,
  type ErrResult,
  isError,
  redact,
  type Redacted,
  type TaggedErrorClass,
  type TaggedErrorInstance,
} from '../src/index.js'

class MissingError extends createTaggedError({
  name: 'MissingError',
  message: 'Missing $id in $source',
}).withProps<{ id: string; requestId?: string }>() {
  public readonly category = 'lookup'
}

class MetadataError extends createTaggedError({
  name: 'MetadataError',
  message: 'Request $id failed',
}).withProps<{
  id: string
  context: { readonly attempts: number; readonly credentials: { readonly token: Redacted<string> } }
  token: Redacted<string>
  retryAfter?: number
}>() {}

const StaticError = createTaggedError({
  name: 'StaticError',
  message: 'Static failure',
}).withProps<{ detail?: { readonly requestId: string } }>()

class RequiredMetadataError extends createTaggedError({
  name: 'RequiredMetadataError',
  message: 'Static failure',
}).withProps<{ detail: { readonly requestId: string } }>() {}

class ApplicationError extends Error {
  public readonly statusCode = 503
}

class TypedCauseError extends Error {
  public override readonly cause = { source: 'custom-base' } as const
}

class UnknownCauseError extends Error {
  public override readonly cause: unknown = 'custom-base'
}

class CustomBaseError extends createTaggedError({
  name: 'CustomBaseError',
  message: 'Missing $id',
  extends: ApplicationError,
}).withProps<{ id: string; context: { readonly region: string } }>() {}

describe('explicit tagged error props', () => {
  it('refines specified fields and retains unspecified template inference', () => {
    const error = new MissingError({ id: 'user-1', source: 'users' })

    expectTypeOf(error.id).toEqualTypeOf<string>()
    expectTypeOf(error.source).toEqualTypeOf<string | number>()
    expectTypeOf(error.requestId).toEqualTypeOf<string | undefined>()
    equal(error.message, 'Missing user-1 in users')
    equal(error.requestId, undefined)
    assertOk(error instanceof Error)
    assertOk(isError(error))
    deepEqual(error.fingerprint, ['MissingError', 'Missing $id in $source'])
    equal(error.messageTemplate, 'Missing $id in $source')
    const descriptor = Object.getOwnPropertyDescriptor(error, 'id')
    equal(descriptor?.writable, false)
  })

  it('keeps static err and is tied to the actual consumer subclass', () => {
    const result = MissingError.err({ id: 'user-1', source: 'users', requestId: 'request-1' })
    expectTypeOf(result).toEqualTypeOf<ErrResult<never, MissingError>>()
    const unknown: unknown = result.error

    assertOk(MissingError.is(unknown))
    expectTypeOf(unknown).toEqualTypeOf<MissingError>()
    expectTypeOf(unknown.id).toEqualTypeOf<string>()
    equal(unknown.category, 'lookup')
    equal(unknown.requestId, 'request-1')
  })

  it('keeps guards usable as typed refinements with an explicit receiver', () => {
    type MissingInstance = TaggedErrorInstance<
      'MissingError',
      'Missing $id in $source',
      Error,
      { id: string; requestId?: string }
    >
    expectTypeOf(MissingError.is).toExtend<(value: unknown) => value is MissingInstance>()
    const guard: (value: unknown) => value is MissingInstance = MissingError.is.bind(MissingError)
    const error = new MissingError({ id: 'user-1', source: 'users' })
    const values: readonly unknown[] = [error, new Error('other'), undefined]
    const matches = values.filter(guard)

    expectTypeOf(matches).toEqualTypeOf<MissingInstance[]>()
    deepEqual(matches, [error])
  })

  it('creates fresh sibling constructors so guards cannot misidentify other typed views', () => {
    const Base = createTaggedError({ name: 'ViewedError', message: 'Missing $id' })
    const Strings = Base.withProps<{ id: string }>()
    const Numbers = Strings.withProps<{ id: number }>()
    const otherStrings = Base.withProps<{ id: string }>()
    const base = new Base({ id: 1 })
    const string = new Strings({ id: 'user-1' })
    const number = new Numbers({ id: 1 })

    equal(Strings === Base, false)
    equal(Strings === otherStrings, false)
    equal(Strings.is(base), false)
    equal(Strings.is(number), false)
    equal(Base.is(string), false)
    equal(Numbers.is(string), false)
    equal(otherStrings.is(string), false)
    equal(Strings.is(string), true)
    equal(Numbers.is(number), true)
    deepEqual(string.fingerprint, base.fingerprint)
  })

  it('retains earlier metadata declarations when adding another specialization', () => {
    const Base = createTaggedError({ name: 'ComposedError', message: 'Missing $id' })
    const Typed = Base.withProps<{ id: string }>().withProps<{ requestId?: string }>()
    const error = new Typed({ id: 'user-1' })

    expectTypeOf(error.id).toEqualTypeOf<string>()
    expectTypeOf(error.requestId).toEqualTypeOf<string | undefined>()
    equal(error.id, 'user-1')
  })

  it('copies required inherited getters using the original receiver', () => {
    const Typed = createTaggedError({ name: 'GetterError', message: 'Missing $id' }).withProps<{
      id: string
      requestId: string
    }>()
    class GetterProps {
      public readonly id = 'user-1'
      readonly #suffix = 'request-1'

      public get requestId(): string {
        return `${this.id}/${this.#suffix}`
      }
    }
    const error = new Typed(new GetterProps())

    expectTypeOf(error.requestId).toEqualTypeOf<string>()
    equal(error.requestId, 'user-1/request-1')
    equal(Object.getOwnPropertyDescriptor(error, 'requestId')?.writable, false)
    equal((error.toJSON() as Record<string, unknown>)['requestId'], 'user-1/request-1')
  })

  it('copies required own non-enumerable metadata', () => {
    const Typed = createTaggedError({ name: 'HiddenError', message: 'Missing $id' }).withProps<{
      id: string
      requestId: string
    }>()
    const props = Object.defineProperty({ id: 'user-1', requestId: 'request-1' }, 'requestId', {
      enumerable: false,
    })
    const error = new Typed(props)

    equal(Object.keys(props).includes('requestId'), false)
    equal(error.requestId, 'request-1')
    equal(Object.getOwnPropertyDescriptor(error, 'requestId')?.writable, false)
    equal((error.toJSON() as Record<string, unknown>)['requestId'], 'request-1')
  })

  it('accepts metadata on function objects without reading restricted function intrinsics', () => {
    const Typed = createTaggedError({
      name: 'FunctionPropsError',
      message: 'Missing $id',
    }).withProps<{ id: string }>()
    const props = Object.assign(() => undefined, { id: 'user-1' })
    const error = new Typed(props)

    equal(error.id, 'user-1')
    equal(error.message, 'Missing user-1')
    equal('caller' in error, false)
    equal('arguments' in error, false)
  })

  it('respects own property shadowing without evaluating an inherited getter', () => {
    const Typed = createTaggedError({ name: 'ShadowError', message: 'Missing $id' }).withProps<{
      id: string
      requestId: string
    }>()
    let inheritedReads = 0
    class ParentProps {
      public readonly id = 'user-1'

      public get requestId(): string {
        inheritedReads += 1
        return `${this.id}/inherited`
      }
    }
    const props = Object.defineProperty(new ParentProps(), 'requestId', {
      enumerable: false,
      value: 'own',
    })
    const error = new Typed(props)

    equal(error.requestId, 'own')
    equal(inheritedReads, 0)
  })

  it('protects existing Error, custom base, and helper properties', () => {
    const props = {
      id: 'user-1',
      context: { region: 'south' },
      statusCode: 999,
      _tag: 'Spoofed',
      name: 'Spoofed',
      message: 'Spoofed',
      then: 'Spoofed',
      get toJSON(): never {
        throw new Error('Reserved getters must not be evaluated')
      },
    }
    const error = new CustomBaseError(props)

    equal(error.statusCode, 503)
    equal(error._tag, 'CustomBaseError')
    equal(error.name, 'CustomBaseError')
    equal(error.message, 'Missing user-1')
    equal('then' in error, false)
    equal(typeof error.findCause, 'function')
    equal(typeof error.toJSON, 'function')
    equal((error.toJSON() as Record<string, unknown>)['context'], props.context)
  })

  it('preserves the original factory own-enumerable metadata copying', () => {
    const Original = createTaggedError({ name: 'OriginalCopy', message: 'Static failure' })
    class OriginalProps {
      public readonly cause = undefined
      public readonly own = 'own'

      public get inherited(): string {
        return `${this.own}/inherited`
      }
    }
    const props = Object.defineProperty(new OriginalProps(), 'hidden', {
      enumerable: false,
      value: 'hidden',
    })
    const error = new Original(props)
    const json = error.toJSON() as Record<string, unknown>

    equal(json['own'], 'own')
    equal('inherited' in error, false)
    equal('hidden' in error, false)
    equal(Object.getOwnPropertyDescriptor(error, 'own')?.writable, false)
  })

  it('serializes structured props and redaction through the existing runtime', () => {
    const cause = new TypeError('transport')
    const token = redact('sensitive-token', 'credential')
    const context = { attempts: 2, credentials: { token } }
    const error = new MetadataError({ id: 'user-1', context, token, cause })

    expectTypeOf(error.cause).toEqualTypeOf<unknown>()
    expectTypeOf(error.context.attempts).toEqualTypeOf<number>()
    strictEqual(error.context, context)
    strictEqual(error.token, token)
    strictEqual(error.cause, cause)
    strictEqual(error.findCause(TypeError), cause)
    // eslint-disable-next-line unicorn/prefer-structured-clone -- Verify the JSON serializer and redaction boundary.
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>
    deepEqual(json['context'], { attempts: 2, credentials: { token: '<redacted:credential>' } })
    equal(json['token'], '<redacted:credential>')
    equal('retryAfter' in json, false)
    equal(JSON.stringify(error).includes('sensitive-token'), false)
    equal((json['cause'] as Record<string, unknown>)['message'], 'transport')
  })

  it('keeps optional-only metadata optional when the template needs no props', () => {
    const absent = new StaticError()
    const present = new StaticError({ detail: { requestId: 'request-1' } })
    const result = StaticError.err()

    expectTypeOf(absent.detail).toEqualTypeOf<{ readonly requestId: string } | undefined>()
    equal(absent.detail, undefined)
    equal(present.detail?.requestId, 'request-1')
    assertOk(result.error instanceof StaticError)
    equal(
      new RequiredMetadataError({ detail: { requestId: 'request-1' } }).detail.requestId,
      'request-1',
    )
  })

  it('preserves native messages with the default $message template', () => {
    const Dynamic = createTaggedError({ name: 'Dynamic' }).withProps<{
      message: string
      code?: number
    }>()
    const error = new Dynamic({ message: 'Dynamic failure', code: 42 })

    expectTypeOf(error.message).toEqualTypeOf<string>()
    expectTypeOf(error.code).toEqualTypeOf<number | undefined>()
    equal(error.message, 'Dynamic failure')
    equal(error.code, 42)
    equal(Dynamic.err({ message: 'Other failure' }).error.message, 'Other failure')
    const Numeric = createTaggedError({ name: 'Numeric' }).withProps<{ message: number }>()
    const numeric = new Numeric({ message: 42 })
    expectTypeOf(numeric.message).toEqualTypeOf<string>()
    equal(numeric.message, '42')
  })

  it('preserves custom native Error bases', () => {
    const error = new CustomBaseError({ id: 'user-1', context: { region: 'south' } })
    assertOk(error instanceof ApplicationError)
    expectTypeOf(error.statusCode).toEqualTypeOf<number>()
    equal(error.statusCode, 503)
    equal(error.message, 'Missing user-1')
    equal(error.context.region, 'south')
  })

  it('preserves a custom base cause even when the constructor replaces the input cause', () => {
    const Typed = createTaggedError({
      name: 'PreservedCauseError',
      message: 'Missing $id',
      extends: TypedCauseError,
    }).withProps<{ id: string }>()
    const error = new Typed({ id: 'user-1', cause: new TypeError('input') })

    expectTypeOf(error.cause).toEqualTypeOf<{ readonly source: 'custom-base' }>()
    deepEqual(error.cause, { source: 'custom-base' })
    assertOk(error instanceof TypedCauseError)
    deepEqual((error.toJSON() as Record<string, unknown>)['cause'], { source: 'custom-base' })
  })

  it('keeps unknown custom base causes without promising input preservation', () => {
    const Typed = createTaggedError({
      name: 'UnknownBaseCauseError',
      message: 'Missing $id',
      extends: UnknownCauseError,
    }).withProps<{ id: string }>()
    const error = new Typed({ id: 'user-1', cause: new TypeError('input') })

    expectTypeOf(error.cause).toEqualTypeOf<unknown>()
    equal(error.cause, 'custom-base')
    equal(error.findCause(TypeError), undefined)
    equal((error.toJSON() as Record<string, unknown>)['cause'], 'custom-base')
  })

  it('keeps existing public type arities and default template props', () => {
    type Original = TaggedErrorInstance<'Original', 'Missing $id', Error>
    const Constructor: TaggedErrorClass<'Original', 'Missing $id', Error> = createTaggedError({
      name: 'Original',
      message: 'Missing $id',
    })
    const error: Original = new Constructor({ id: 1 })
    expectTypeOf(error.id).toEqualTypeOf<string | number>()
    equal(error.id, 1)
  })
})

const symbolKey = Symbol('metadata')
const typeAssertions = (): void => {
  // @ts-expect-error Typed template field id rejects a number.
  new MissingError({ id: 1, source: 'users' })
  // @ts-expect-error Undeclared required template fields remain required.
  new MissingError({ id: 'user-1' })
  // @ts-expect-error Typed required fields remain required in static err.
  void MissingError.err({ source: 'users' })
  // @ts-expect-error Static err enforces the explicit id type.
  void MissingError.err({ id: 1, source: 'users' })
  // @ts-expect-error Required structured metadata requires constructor props.
  new RequiredMetadataError()
  // @ts-expect-error Required structured metadata requires err props.
  void RequiredMetadataError.err()
  // @ts-expect-error Optional metadata still checks its declared type.
  new StaticError({ detail: { requestId: 123 } })
  // @ts-expect-error Required template fields cannot become optional through specialization.
  createTaggedError({ name: 'Invalid', message: 'Missing $id' }).withProps<{ id?: string }>()
  // @ts-expect-error The default message placeholder must remain required.
  createTaggedError({ name: 'Invalid' }).withProps<{ message?: string }>()
  // @ts-expect-error Metadata cannot replace the runtime discriminator.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ _tag: 'Spoofed' }>()
  // @ts-expect-error Metadata cannot replace JSON serialization helpers.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ toJSON: string }>()
  // @ts-expect-error Metadata cannot replace cause lookup helpers.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ findCause: string }>()
  // @ts-expect-error Metadata cannot replace native Error fields.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ stack: string }>()
  // @ts-expect-error A custom message template owns the native message field.
  createTaggedError({ name: 'Invalid', message: 'Missing $id' }).withProps<{ message: string }>()
  // @ts-expect-error Native Error names are generated by the factory.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ name: string }>()
  // @ts-expect-error Prototype-related metadata is unsafe.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ __proto__: object }>()
  // @ts-expect-error Thenable metadata would change ordinary Error behavior.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ then: () => void }>()
  // @ts-expect-error Symbol metadata is not copied by the existing Object.entries runtime.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<{ [symbolKey]: string }>()
  // @ts-expect-error An open index signature can hide reserved keys.
  createTaggedError({ name: 'Invalid', message: 'Failure' }).withProps<Record<string, unknown>>()
  // @ts-expect-error Explicit props cannot replace custom base members.
  createTaggedError({ name: 'Invalid', message: 'Failure', extends: ApplicationError }).withProps<{
    statusCode: number
  }>()
  // @ts-expect-error Native Error cause uses the existing unknown constructor channel.
  createTaggedError({ name: 'NativeMetadataCauseType', message: 'Failure' }).withProps<{
    cause: TypeError
  }>()
  // @ts-expect-error A typed cause belongs to its custom base constructor and cannot be refined.
  createTaggedError({ name: 'Invalid', message: 'Failure', extends: TypedCauseError }).withProps<{
    cause: TypeError
  }>()
  // @ts-expect-error Even compatible cause metadata cannot assume a custom base preserves input.
  createTaggedError({ name: 'Invalid', message: 'Failure', extends: TypedCauseError }).withProps<{
    cause: { readonly source: 'custom-base' }
  }>()
  // @ts-expect-error A custom base can replace input cause even when its public cause type is unknown.
  createTaggedError({ name: 'Invalid', message: 'Failure', extends: UnknownCauseError }).withProps<{
    cause: TypeError
  }>()
}
void typeAssertions
