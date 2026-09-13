// Each executable contract measures a bounded part of the corresponding qualitative scenario.
// Reference solutions validate the graders; they are never supplied to generation adapters.
export const cases = [
  {
    id: 1,
    contract: `Export InvalidEmailError using createTaggedError (tag InvalidEmailError, required email prop).
Export validate(email: string): StrictResult<string, InvalidEmailError>. Trim and lowercase valid
addresses containing @; return the original input in error.email otherwise. Export status(result)
which maps success to 200 and InvalidEmailError to 400 using exhaustive tagged matching.`,
    reference: `import {createTaggedError, ok} from 'resultar'
import type {StrictResult} from 'resultar'
export class InvalidEmailError extends createTaggedError({name: 'InvalidEmailError', message: 'Invalid email $email'}) {}
export const validate = (email: string): StrictResult<string, InvalidEmailError> =>
  email.includes('@') ? ok(email.trim().toLowerCase()) : InvalidEmailError.err({email})
export const status = (result: StrictResult<string, InvalidEmailError>) => result.matchTags(() => 200, {InvalidEmailError: () => 400})`,
    types: `import {validate, InvalidEmailError} from './solution.mjs'
import type {StrictResult} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof validate>, StrictResult<string, InvalidEmailError>>>`,
    checks: `const good = solution.validate(' Ada@EXAMPLE.COM ')
assert.ok(good.isOk()); assert.equal(good.value, 'ada@example.com'); assert.equal(solution.status(good), 200)
for (const email of ['', 'missing-at']) {
  const bad = solution.validate(email)
  assert.ok(bad.isErr()); assert.ok(solution.InvalidEmailError.is(bad.error)); assert.equal(bad.error.email, email)
  assert.equal(solution.status(bad), 400)
}`,
    mutate: source => source.replace("email.includes('@')", 'true'),
  },
  {
    id: 2,
    contract: `Use the supplied Load, TransientError and FatalError from ./contract.mjs.
Export loadWithRetry(load: Load). Make at most three attempts using ResultAsync.retry, retry only
TransientError, use no delay, and pass the policy's signal to load. Preserve the concrete error union
including AbortError.`,
    support: `import {createTaggedError} from 'resultar'
import type {ResultAsync, ResultAsyncAbortSignal} from 'resultar'
export class TransientError extends createTaggedError({name: 'TransientError', message: 'Temporary failure'}) {}
export class FatalError extends createTaggedError({name: 'FatalError', message: 'Permanent failure'}) {}
export type Load = (signal: ResultAsyncAbortSignal) => ResultAsync<number, TransientError | FatalError>`,
    reference: `import {ResultAsync} from 'resultar'
import {TransientError} from './contract.mjs'
import type {Load} from './contract.mjs'
export const loadWithRetry = (load: Load) => ResultAsync.retry((_attempt, signal) => load(signal), {times: 2, while: error => TransientError.is(error)})`,
    types: `import {loadWithRetry} from './solution.mjs'
import type {TransientError, FatalError} from './contract.mjs'
import type {ResultAsync, AbortError} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof loadWithRetry>, ResultAsync<number, TransientError | FatalError | AbortError>>>`,
    checks: `const {TransientError, FatalError} = await import('./contract.mjs')
const {okAsync, errAsync} = await import('resultar')
let calls = 0
const recovered = await solution.loadWithRetry(signal => {
  assert.equal(signal.aborted, false)
  return ++calls < 3 ? errAsync(new TransientError({})) : okAsync(42)
})
assert.ok(recovered.isOk()); assert.equal(recovered.value, 42); assert.equal(calls, 3)
calls = 0
const fatal = new FatalError({})
const failed = await solution.loadWithRetry(() => { calls++; return errAsync(fatal) })
assert.ok(failed.isErr()); assert.equal(failed.error, fatal); assert.equal(calls, 1)
calls = 0
const exhausted = await solution.loadWithRetry(() => { calls++; return errAsync(new TransientError({})) })
assert.ok(exhausted.isErr()); assert.equal(calls, 3)`,
    mutate: source => source.replace('times: 2', 'times: 0'),
  },
  {
    id: 3,
    contract: `Export observeAsync(value: ResultAsync<number, string>, observer: () => void) and
observeTask(value: ResultTask<number, string>, observer: () => void). Use the native tap semantics of
each execution model and preserve the success and typed error channels. Do not start a task early.`,
    reference: `import type {ResultAsync, ResultTask} from 'resultar'
export const observeAsync = (value: ResultAsync<number, string>, observer: () => void) => value.tap(observer)
export const observeTask = (value: ResultTask<number, string>, observer: () => void) => value.tap(observer)`,
    types: `import {observeAsync, observeTask} from './solution.mjs'
import type {ResultAsync, ResultTask} from 'resultar'
export type AsyncCheck = Assert<Equal<ReturnType<typeof observeAsync>, ResultAsync<number, string>>>
export type TaskCheck = Assert<Equal<ReturnType<typeof observeTask>, ResultTask<number, string>>>`,
    checks: `const {okAsync, ResultTask} = await import('resultar')
const defect = new Error('observation')
const asyncResult = await solution.observeAsync(okAsync(7), () => { throw defect })
assert.ok(asyncResult.isOk()); assert.equal(asyncResult.value, 7)
let calls = 0
const task = solution.observeTask(ResultTask.succeed(7), () => { calls++; throw defect })
assert.equal(calls, 0)
const exit = await ResultTask.runExit(task)
assert.equal(calls, 1); assert.equal(exit._tag, 'Failure')
if (exit._tag === 'Failure') { assert.equal(exit.cause._tag, 'Die'); if (exit.cause._tag === 'Die') assert.equal(exit.cause.defect, defect) }
const good = await ResultTask.runResult(solution.observeTask(ResultTask.succeed(9), () => {}))
assert.ok(good.isOk()); assert.equal(good.value, 9)`,
    mutate: source => source.replace('=> value.tap(observer)', '=> value').replace('=> value.tap(observer)', '=> value'),
  },
  {
    id: 4,
    contract: `Export loadZod(request: () => Promise<Response>) and loadTypeBox(request: () => Promise<Response>)
using the corresponding resultar-request adapters. Zod accepts {id: string} containing only digits
and transforms it to {numericId: number}; TypeBox validates {numericId: number} directly. Derive
success types from schemas and keep RequestError failures for HTTP, transport, JSON and validation.`,
    reference: `import {z} from 'zod'
import {Type} from 'typebox'
import {requestJson as requestZod} from 'resultar-request-zod'
import {requestJson as requestTypeBox} from 'resultar-request-typebox'
const zodSchema = z.object({id: z.string().regex(/^\\d+$/)}).transform(({id}) => ({numericId: Number(id)}))
const typeboxSchema = Type.Object({numericId: Type.Number()})
export const loadZod = (request: () => Promise<Response>) => requestZod({request, schema: zodSchema})
export const loadTypeBox = (request: () => Promise<Response>) => requestTypeBox({request, schema: typeboxSchema})`,
    types: `import {loadZod, loadTypeBox} from './solution.mjs'
import type {ResultAsync} from 'resultar'
import type {RequestError} from 'resultar-request'
export type ZodCheck = Assert<Equal<ReturnType<typeof loadZod>, ResultAsync<{numericId: number}, RequestError>>>
export type TypeBoxCheck = Assert<Equal<ReturnType<typeof loadTypeBox>, ResultAsync<{numericId: number}, RequestError>>>`,
    checks: `for (const [load, payload] of [[solution.loadZod, {id: '42'}], [solution.loadTypeBox, {numericId: 42}]] as const) {
  const good = await load(async () => Response.json(payload))
  assert.ok(good.isOk()); assert.deepEqual(good.value, {numericId: 42})
  for (const request of [async () => Response.json({wrong: true}), async () => new Response('broken json'), async () => new Response('unavailable', {status: 503}), async () => { throw new Error('transport') }]) {
    const bad = await load(request); assert.ok(bad.isErr()); assert.ok(bad.error instanceof Error)
  }
}`,
    mutate: source => source.replace('Number(id)', 'Number(id) + 1'),
  },
  {
    id: 5,
    contract: `Export tsconfig with strict NodeNext/ESNext compiler options and a resultar-check plugin
requiring noDiscard and noAwaitInSafeTry as errors, failing on warning. Export commands as
{check: 'resultar-check --project tsconfig.json', editor: 'resultar-check lsp --project tsconfig.json'}.
Keep intentional discards distinct from corrections; there is no JavaScript checker plugin to load.`,
    reference: `export const tsconfig = {compilerOptions: {target: 'ESNext', module: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true, plugins: [{name: 'resultar-check', noDiscard: 'error', noAwaitInSafeTry: 'error', failOn: 'warning'}]}}
export const commands = {check: 'resultar-check --project tsconfig.json', editor: 'resultar-check lsp --project tsconfig.json'}`,
    types: `import {commands, tsconfig} from './solution.mjs'
export const config: {compilerOptions: {strict: boolean}} = tsconfig
export const cli: {check: string; editor: string} = commands`,
    checks: `const {writeFileSync, mkdirSync} = await import('node:fs')
const {spawnSync} = await import('node:child_process')
const {join} = await import('node:path')
assert.equal(solution.commands.check, 'resultar-check --project tsconfig.json')
assert.equal(solution.commands.editor, 'resultar-check lsp --project tsconfig.json')
const directory = join(process.cwd(), 'configured'); mkdirSync(directory)
writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({...solution.tsconfig, include: ['bad.mts']}))
writeFileSync(join(directory, 'bad.mts'), "import {ok, okAsync, Result} from 'resultar'; ok(1); void Result.gen(async function* () { await okAsync(1); return ok(1) })")
const check = spawnSync(process.execPath, [process.env['RESULTAR_EVAL_CHECKER']!, '--project', join(directory, 'tsconfig.json'), '--json'], {encoding: 'utf8'})
assert.equal(check.status, 1, check.stderr)
const findings = check.stdout.trim().split('\\n').map(line => JSON.parse(line))
assert.ok(findings.some(f => f.rule === 'no-discard' && f.severity === 'error'))
assert.ok(findings.some(f => f.rule === 'no-await-in-safe-try' && f.severity === 'error'))
assert.equal(findings.find(f => f.rule === 'no-discard').fixes[0].kind, 'intentional-discard')`,
    mutate: source => source.replace("noDiscard: 'error'", "noDiscard: 'off'"),
  },
  {
    id: 6,
    contract: `Repair this nested composition and export doublePositive with a flat Result<number, string>
return type: input.map(n => n > 0 ? ok(n * 2) : err('nonpositive')). Preserve existing input errors.
Use public composition, without casts, unsafe unwraps, or ignoring error results.`,
    reference: `import {ok, err} from 'resultar'
import type {Result} from 'resultar'
export const doublePositive = (input: Result<number, string>) => input.andThen(n => n > 0 ? ok(n * 2) : err('nonpositive'))`,
    types: `import {doublePositive} from './solution.mjs'
import type {Result} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof doublePositive>, Result<number, string>>>`,
    checks: `const {ok, err} = await import('resultar')
for (const n of [1, 7, 101]) { const result = solution.doublePositive(ok(n)); assert.ok(result.isOk()); assert.equal(result.value, n * 2) }
for (const n of [0, -1]) { const result = solution.doublePositive(ok(n)); assert.ok(result.isErr()); assert.equal(result.error, 'nonpositive') }
const existing = solution.doublePositive(err('upstream')); assert.ok(existing.isErr()); assert.equal(existing.error, 'upstream')`,
    mutate: source => source.replace('.andThen(', '.map('),
  },
  {
    id: 7,
    contract: `Use Prefix, AcquireError, ReadError, CloseError, Acquire from ./contract.mjs.
Export scopedRead(acquire: Acquire), a lazy ResultTask requiring Prefix, acquiring one connection,
reading its value and prepending Prefix, then awaiting close exactly once. Map external failures
with their original cause into the supplied error classes. Preserve body plus release failures at
runExit, and keep errors and Prefix requirements inferred and concrete.`,
    support: `import {createTaggedError, ResultTask} from 'resultar'
export const Prefix = ResultTask.service<string, 'prefix'>('prefix')
export class AcquireError extends createTaggedError({name: 'AcquireError', message: 'Acquire failed'}) {}
export class ReadError extends createTaggedError({name: 'ReadError', message: 'Read failed'}) {}
export class CloseError extends createTaggedError({name: 'CloseError', message: 'Close failed'}) {}
export type Acquire = (signal: AbortSignal) => Promise<{read: () => Promise<string>; close: () => Promise<void>}>`,
    reference: `import {ResultTask} from 'resultar'
import {Prefix, AcquireError, ReadError, CloseError} from './contract.mjs'
import type {Acquire} from './contract.mjs'
export const scopedRead = (acquire: Acquire) => ResultTask.scoped(ResultTask.gen(function* () {
  const prefix = yield* Prefix
  const connection = yield* ResultTask.acquireRelease({
    acquire: ResultTask.tryPromise({try: acquire, catch: cause => new AcquireError({cause})}),
    release: connection => ResultTask.tryPromise({try: () => connection.close(), catch: cause => new CloseError({cause})}),
  })
  const value = yield* ResultTask.tryPromise({try: () => connection.read(), catch: cause => new ReadError({cause})})
  return prefix + value
}))`,
    types: `import {scopedRead} from './solution.mjs'
import {Prefix} from './contract.mjs'
import type {AcquireError, ReadError, CloseError} from './contract.mjs'
import type {ResultTask} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof scopedRead>, ResultTask<string, AcquireError | ReadError | CloseError, typeof Prefix>>>`,
    checks: `const {ResultTask} = await import('resultar')
const events: string[] = []
const task = solution.scopedRead(async signal => {
  assert.equal(signal.aborted, false); events.push('acquire')
  return {read: async () => {events.push('read'); return 'value'}, close: async () => {await Promise.resolve(); events.push('close')}}
})
assert.deepEqual(events, [])
for (let i = 0; i < 2; i++) {
  const result = await ResultTask.runResult(task, {services: {prefix: '>'}})
  assert.ok(result.isOk()); assert.equal(result.value, '>value')
}
assert.deepEqual(events, ['acquire','read','close','acquire','read','close'])
const readCause = new Error('read'); const closeCause = new Error('close')
const both = solution.scopedRead(async () => ({read: async () => {throw readCause}, close: async () => {throw closeCause}}))
const exit = await ResultTask.runExit(both, {services: {prefix: '>'}})
assert.equal(exit._tag, 'Failure')
if (exit._tag === 'Failure') {
  assert.equal(exit.cause._tag, 'Sequential')
  const encoded = JSON.stringify(exit.cause)
  assert.ok(encoded.includes('ReadError')); assert.ok(encoded.includes('CloseError'))
}
const acquireCause = new Error('acquire')
const bad = await ResultTask.runResult(solution.scopedRead(async () => {throw acquireCause}), {services: {prefix: ''}})
assert.ok(bad.isErr()); assert.equal(bad.error._tag, 'AcquireError'); assert.equal(bad.error.cause, acquireCause)`,
    mutate: source => source.replace('return prefix + value', "return prefix + 'wrong'"),
  },
];
