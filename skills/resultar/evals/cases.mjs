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
observeTask(value: ResultTask<number, string>, observer: () => void). Use inspect for best-effort
ResultAsync observation and tap for the existing ResultTask side-effect semantics. Preserve success
and typed error channels, and do not start a task early.`,
    reference: `import type {ResultAsync, ResultTask} from 'resultar'
export const observeAsync = (value: ResultAsync<number, string>, observer: () => void) => value.inspect(observer)
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
const task = solution.observeTask(ResultTask.ok(7), () => { calls++; throw defect })
assert.equal(calls, 0)
const exit = await ResultTask.runExit(task)
assert.equal(calls, 1); assert.equal(exit._tag, 'Failure')
if (exit._tag === 'Failure') { assert.equal(exit.cause._tag, 'Die'); if (exit.cause._tag === 'Die') assert.equal(exit.cause.defect, defect) }
const good = await ResultTask.runResult(solution.observeTask(ResultTask.ok(9), () => {}))
assert.ok(good.isOk()); assert.equal(good.value, 9)`,
    mutate: source => source.replace('=> value.inspect(observer)', '=> value').replace('=> value.tap(observer)', '=> value'),
  },
  {
    id: 4,
    guidance: ["references/services.md", "manual/packages/request-zod/README.md", "manual/packages/request-typebox/README.md"],
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
    guidance: ["references/anti-patterns.md", "manual/packages/check/README.md"],
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
writeFileSync(join(directory, 'bad.mts'), "import {ok, okAsync, Result} from 'resultar'; ok(1); void Result.gen(async function* () { await okAsync(1); return 1 })")
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
    guidance: ["references/patterns.md", "references/integrations.md"],
    contract: `Use Prefix, AcquireError, ReadError, CloseError, Acquire from ./contract.mjs.
Export scopedRead(acquire: Acquire), a lazy ResultTask requiring Prefix, acquiring one connection,
reading its value and prepending Prefix, then awaiting close exactly once. Map external failures
with their original cause into the supplied error classes. Preserve body plus release failures at
runExit, and keep errors and Prefix requirements inferred and concrete.`,
    support: `import {createTaggedError, ResultTask} from 'resultar'
export const Prefix = ResultTask.service<string>()('prefix')
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
  {
    id: 8,
    guidance: ['references/services.md', 'manual/packages/request/README.md'],
    contract: `The request callback is an external transport, not an application repository.
Export load(request: (signal: AbortSignal) => Promise<Response>) as a lazy Task
using requestJson. Validate {value: number}; preserve RequestError. Do not make a request until
run, and make a new request on every run, forwarding the Task signal.`,
    reference: `import {ResultTask} from 'resultar'
import {requestJson} from 'resultar-request'
export const load = (request: (signal: AbortSignal) => Promise<Response>) => ResultTask.fromResultAsync(signal => requestJson({
  request: () => request(signal),
  validator: (value): value is {value: number} => typeof value === 'object' && value !== null && 'value' in value && typeof value.value === 'number',
}))`,
    types: `import {load} from './solution.mjs'
import type {ResultTask} from 'resultar'
import type {RequestError} from 'resultar-request'
export type Check = Assert<Equal<ReturnType<typeof load>, ResultTask<{value: number}, RequestError>>>`,
    checks: `let calls = 0
const task = solution.load(async signal => { assert.equal(signal.aborted, false); return Response.json({value: ++calls}) })
assert.equal(calls, 0)
assert.deepEqual(await task.runPromise(), {value: 1})
assert.deepEqual(await task.runPromise(), {value: 2})
assert.equal((await solution.load(async () => Response.json({value: 'bad'})).runResult()).isErr(), true)`,
    mutate: source => source.replace("typeof value.value === 'number'", "typeof value.value === 'string'"),
  },
  {
    id: 9,
    guidance: ['references/services.md', 'manual/packages/di/README.md'],
    contract: `Export makeApplication(events: string[]). Return a resultar-di root scope with
a singleton resource named cache (Map<string,string>) and scoped service named users depending
on cache and the external tenant local. users.find(id) reads tenant + ':' + id from cache.
Acquisition pushes 'open', release pushes 'close'. Each scope.use gets a child; closing the root
releases the cache once. Populate the initial cache with acme:1 -> Ada and other:1 -> Grace.`,
    reference: `import {ResultTask} from 'resultar'
import {createModule, resource, service, Service} from 'resultar-di'
export const makeApplication = (events: string[]) => {
  const Cache = resource('cache', {
    acquire: ResultTask.sync(() => {events.push('open'); return new Map([['acme:1', 'Ada'], ['other:1', 'Grace']])}),
    release: () => ResultTask.sync(() => {events.push('close')}),
  })
  const Tenant = Service.require<string>()('tenant')
  const Users = service('users', {cache: Cache, tenant: Tenant}, ({cache, tenant}) => ({find: (id: string) => cache.get(tenant + ':' + id)}))
  return createModule().singleton(Cache).scoped(Users).scope()
}`,
    types: `import {makeApplication} from './solution.mjs'
export type Check = Assert<Equal<Parameters<typeof makeApplication>, [string[]]>>`,
    checks: `const {ResultTask} = await import('resultar')
const events: string[] = []
const root = solution.makeApplication(events)
assert.deepEqual(events, [])
for (const [tenant, name] of [['acme','Ada'], ['other','Grace']]) {
  const found = await root.withServices({tenant}).use(['users'], ({users}) => ResultTask.ok(users.find('1'))).runPromise()
  assert.equal(found, name)
}
assert.deepEqual(events, ['open'])
await root.close().runPromise()
assert.deepEqual(events, ['open', 'close'])`,
    mutate: source => source.replace("tenant + ':' + id", "'acme:' + id"),
  },
  {
    id: 10,
    guidance: ['references/api.md'],
    contract: `Export toStatus(input: Input): number for the supplied discriminated union.
Use exhaustive Match discrimination on kind: missing -> 404, denied -> 403, ready -> 200.
Export mask(value: string): string using redact with label token; never expose the input.`,
    support: `export type Input = {kind: 'missing'} | {kind: 'denied'} | {kind: 'ready'; value: number}`,
    reference: `import {Match, redact} from 'resultar'
import type {Input} from './contract.mjs'
export const toStatus = (input: Input): number => Match.value(input).pipe(Match.discriminatorsExhaustive('kind')({missing: () => 404, denied: () => 403, ready: () => 200}))
export const mask = (value: string): string => String(redact(value, 'token'))`,
    types: `import {toStatus} from './solution.mjs'
export type Check = Assert<Equal<ReturnType<typeof toStatus>, number>>`,
    checks: `assert.equal(solution.toStatus({kind: 'missing'}), 404)
assert.equal(solution.toStatus({kind: 'denied'}), 403)
assert.equal(solution.toStatus({kind: 'ready', value: 3}), 200)
assert.equal(solution.mask('secret'), '<redacted:token>')`,
    mutate: source => source.replace('denied: () => 403', 'denied: () => 401'),
  },
  {
    id: 11,
    guidance: ['references/patterns.md'],
    contract: `Export retry(load: () => ResultTask<number, LoadError>). Use the supplied LoadError.
Use Retry.policy to allow two retries, delays 10ms then 20ms, with numeric backoff and no jitter.
Retry only retryable failures. Invoke the load factory lazily anew for every attempt.`,
    support: `import {createTaggedError} from 'resultar'
export class LoadError extends createTaggedError({name: 'LoadError', message: 'Load failed'}).withProps<{readonly retryable: boolean}>() {}`,
    reference: `import {ResultTask, Retry} from 'resultar'
import {LoadError} from './contract.mjs'
export const retry = (load: () => ResultTask<number, LoadError>) => ResultTask.gen(function* () { return yield* load() }).retry(Retry.policy<LoadError>({times: 2, delayMs: 10, backoff: 2, jittered: 0, while: error => error.retryable}))`,
    types: `import {retry} from './solution.mjs'
import type {LoadError} from './contract.mjs'
import type {ResultTask} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof retry>, ResultTask<number, LoadError>>>`,
    checks: `const {ResultTask} = await import('resultar')
const {LoadError} = await import('./contract.mjs')
let calls = 0
const delays: number[] = []
const task = solution.retry(() => ++calls < 3 ? ResultTask.err(new LoadError({retryable: true})) : ResultTask.ok(9))
assert.equal(calls, 0)
assert.equal(await task.runPromise({clock: {now: () => 0, random: () => 0.5, sleep: async ms => {delays.push(ms)}}}), 9)
assert.equal(calls, 3); assert.deepEqual(delays, [10,20])
calls = 0
const fatal = await solution.retry(() => {calls++; return ResultTask.err(new LoadError({retryable: false}))}).runResult()
assert.equal(fatal.isErr(), true); assert.equal(calls, 1)`,
    mutate: source => source.replace('backoff: 2', 'backoff: 1'),
  },
  {
    id: 12,
    guidance: ['references/api.md', 'references/integrations.md'],
    contract: `Implement an explicit native execution boundary, not a reusable repository method.
Export describe(task: ResultTask<number, string>, signal?: AbortSignal): Promise<string>. Execute once
with runExit. Return success:<value> for success, interrupted for a cause containing interruption,
defect for a cause containing a defect, failure otherwise, in that priority order. Never throw
merely because the Task has a typed failure, defect, or interruption.`,
    reference: `import {Cause, type ResultTask} from 'resultar'
export const describe = async (task: ResultTask<number, string>, signal?: AbortSignal): Promise<string> => {
  const exit = await task.runExit({signal})
  if (exit._tag === 'Success') return 'success:' + exit.value
  if (Cause.hasInterrupts(exit.cause)) return 'interrupted'
  if (Cause.hasDies(exit.cause)) return 'defect'
  return 'failure'
}`,
    types: `import {describe} from './solution.mjs'
export type Check = Assert<Equal<ReturnType<typeof describe>, Promise<string>>>`,
    checks: `const {ResultTask} = await import('resultar')
assert.equal(await solution.describe(ResultTask.ok(3)), 'success:3')
assert.equal(await solution.describe(ResultTask.err('expected')), 'failure')
assert.equal(await solution.describe(ResultTask.sync(() => {throw new Error('defect')})), 'defect')
const controller = new AbortController(); controller.abort()
assert.equal(await solution.describe(ResultTask.ok(0), controller.signal), 'interrupted')`,
    mutate: source => source.replace("return 'defect'", "return 'failure'"),
  },
  {
    id: 13,
    guidance: ['references/patterns.md', 'references/services.md'],
    contract: `Implement makeRepository(driver: (id: string, signal: AbortSignal) => Promise<number>).
The driver is an external SDK. Return an object with load(id: string): ResultTask<number, LoadError>.
Use the supplied LoadError with id and cause. Adapt the raw Promise directly with tryPromise;
do not construct ResultAsync just to convert it back to a Task. Neither makeRepository nor load
is async. Map synchronous driver throws and Promise rejections. Keep work lazy and repeatable,
and forward the Task cancellation signal.`,
    support: `import {createTaggedError} from 'resultar'
export class LoadError extends createTaggedError({name: 'LoadError', message: 'Load failed for $id'}) {}`,
    reference: `import {ResultTask} from 'resultar'
import {LoadError} from './contract.mjs'
export const makeRepository = (driver: (id: string, signal: AbortSignal) => Promise<number>) => ({
  load: (id: string): ResultTask<number, LoadError> => ResultTask.tryPromise({
    try: signal => driver(id, signal),
    catch: cause => new LoadError({id, cause}),
  }),
})`,
    types: `import {makeRepository} from './solution.mjs'
import type {LoadError} from './contract.mjs'
import type {ResultTask} from 'resultar'
export type Check = Assert<Equal<ReturnType<ReturnType<typeof makeRepository>['load']>, ResultTask<number, LoadError>>>`,
    checks: `const {LoadError} = await import('./contract.mjs')
const {Cause} = await import('resultar')
let calls = 0
const repository = solution.makeRepository(async (id, signal) => {assert.equal(id, '1'); assert.equal(signal.aborted, false); return ++calls})
const task = repository.load('1')
assert.equal(calls, 0)
assert.equal(await task.runPromise(), 1); assert.equal(await task.runPromise(), 2)
const cause = new Error('driver')
for (const driver of [() => {throw cause}, () => Promise.reject(cause)]) {
  const failed = await solution.makeRepository(driver).load('bad').runResult()
  assert.equal(failed.isErr(), true)
  if (failed.isErr()) {assert.ok(LoadError.is(failed.error)); assert.equal(failed.error.id, 'bad'); assert.equal(failed.error.cause, cause)}
}
const controller = new AbortController()
let started!: () => void
const ready = new Promise<void>(resolve => {started = resolve})
let aborted = false
const pending = solution.makeRepository((_id, signal) => new Promise<number>((_resolve, reject) => {
  signal.addEventListener('abort', () => {aborted = true; reject(new Error('cancelled'))}, {once: true})
  started()
})).load('1').runExit({signal: controller.signal})
await ready; controller.abort()
const exit = await pending
assert.equal(aborted, true); assert.equal(exit._tag, 'Failure')
if (exit._tag === 'Failure') assert.equal(Cause.hasInterrupts(exit.cause), true)`,
    mutate: source => source.replace('load: (id: string): ResultTask<number, LoadError>', 'load: async (id: string)'),
  },
  {
    id: 14,
    guidance: ['references/anti-patterns.md', 'manual/packages/check/README.md'],
    contract: `Use LoadError from ./contract.mjs. Export loadTask(driver: (signal: AbortSignal) => Promise<number>)
and loadEager(driver: () => Promise<number>) without return type annotations on either function.
loadTask adapts driver into a lazy, repeatable ResultTask using ResultTask.tryPromise and LoadError;
loadEager adapts driver into an eager ResultAsync using tryResultAsync and LoadError. Do not mark
either factory async (never return Promise<ResultTask<...>> or Promise<Result<...>>).`,
    support: `import {createTaggedError} from 'resultar'
export class LoadError extends createTaggedError({name: 'LoadError', message: 'Load failed'}) {}`,
    reference: `import {ResultTask, tryResultAsync} from 'resultar'
import {LoadError} from './contract.mjs'
export const loadTask = (driver: (signal: AbortSignal) => Promise<number>) =>
  ResultTask.tryPromise({try: driver, catch: cause => new LoadError({cause})})
export const loadEager = (driver: () => Promise<number>) =>
  tryResultAsync(driver, cause => new LoadError({cause}))`,
    types: `import {loadTask, loadEager} from './solution.mjs'
export type TaskParams = Assert<Equal<Parameters<typeof loadTask>, [(signal: AbortSignal) => Promise<number>]>>
export type EagerParams = Assert<Equal<Parameters<typeof loadEager>, [() => Promise<number>]>>`,
    checks: `const {isResultTask} = await import('resultar')
const {LoadError} = await import('./contract.mjs')
const api = solution as unknown as {
  loadTask: (driver: (signal: AbortSignal) => Promise<number>) => {runPromise(): Promise<number>; runResult(): PromiseLike<{isErr(): boolean; error?: unknown}>}
  loadEager: (driver: () => Promise<number>) => PromiseLike<{isOk(): boolean; isErr(): boolean; value?: unknown; error?: unknown}>
}
let taskCalls = 0
const task = api.loadTask(async signal => { assert.equal(signal.aborted, false); return ++taskCalls })
assert.equal(isResultTask(task), true)
assert.equal(taskCalls, 0)
assert.equal(await task.runPromise(), 1)
assert.equal(await task.runPromise(), 2)
let eagerCalls = 0
const eager = api.loadEager(async () => ++eagerCalls)
assert.equal(eagerCalls, 1)
assert.equal(eager instanceof Promise, false)
const okRes = await eager
assert.equal(okRes.isOk(), true); assert.equal(okRes.value, 1)
const boom = new Error('boom')
const errTask = await api.loadTask(async () => { throw boom }).runResult()
assert.equal(errTask.isErr(), true); assert.ok(LoadError.is(errTask.error)); if (LoadError.is(errTask.error)) assert.equal(errTask.error.cause, boom)
const errEager = await api.loadEager(async () => { throw boom })
assert.equal(errEager.isErr(), true); assert.ok(LoadError.is(errEager.error)); if (LoadError.is(errEager.error)) assert.equal(errEager.error.cause, boom)`,
    mutate: source => source.replace('export const loadTask = (', 'export const loadTask = async (').replace('export const loadEager = (', 'export const loadEager = async ('),
  },
  {
    id: 15,
    guidance: ['references/services.md', 'manual/packages/request/README.md', 'manual/packages/request-zod/README.md'],
    contract: `Use ApiError from ./contract.mjs. Export fetchAccountTask(request: (signal: AbortSignal) => Promise<Response>)
using requestJsonZodTask from resultar-request-zod. Validate {id: string, active: boolean} with Zod and
transform to {accountId: string, active: boolean}. Map 404 -> reason 'not-found', http -> reason 'http',
invalidJson -> reason 'invalid-json', request -> reason 'request', and validation -> reason 'validation'
into ApiError (preserving cause on request and invalidJson). Retry up to 2 times with delayMs: 25 and
backoff: 2. Return the lazy ResultTask directly without async.`,
    support: `import {createTaggedError} from 'resultar'
import type {FetchJsonResponseData} from 'resultar-request'
export type TransportResponse = FetchJsonResponseData
export class ApiError extends createTaggedError({name: 'ApiError', message: 'API failed: $reason'}).withProps<{
  readonly reason: 'not-found' | 'http' | 'invalid-json' | 'request' | 'validation'
}>() {}`,
    reference: `import {z} from 'zod'
import {requestJsonZodTask, type RequestJsonMapError} from 'resultar-request-zod'
import {ApiError, type TransportResponse} from './contract.mjs'
const schema = z.object({id: z.string(), active: z.boolean()}).transform(({id, active}) => ({accountId: id, active}))
const mapError = {
  404: () => new ApiError({reason: 'not-found'}),
  http: () => new ApiError({reason: 'http'}),
  invalidJson: ({cause}) => new ApiError({reason: 'invalid-json', cause}),
  request: ({cause}) => new ApiError({reason: 'request', cause}),
  validation: () => new ApiError({reason: 'validation'}),
} satisfies RequestJsonMapError
export const fetchAccountTask = (request: (signal: AbortSignal) => Promise<TransportResponse>) =>
  requestJsonZodTask({
    request,
    schema,
    mapError,
    retry: {times: 2, delayMs: 25, backoff: 2, jittered: 0},
  })`,
    types: `import {fetchAccountTask} from './solution.mjs'
import type {ApiError} from './contract.mjs'
import type {ResultTask} from 'resultar'
export type Check = Assert<Equal<ReturnType<typeof fetchAccountTask>, ResultTask<{accountId: string; active: boolean}, ApiError>>>`,
    checks: `const {Cause} = await import('resultar')
const {ApiError} = await import('./contract.mjs')
let calls = 0
const task = solution.fetchAccountTask(async signal => {
  assert.equal(signal.aborted, false)
  calls++
  return Response.json({id: 'acc_' + calls, active: true})
})
assert.equal(calls, 0)
assert.deepEqual(await task.runPromise(), {accountId: 'acc_1', active: true})
assert.deepEqual(await task.runPromise(), {accountId: 'acc_2', active: true})

// Stage-accurate classification: request-stage SyntaxError maps to 'request' and retries
let syntaxCalls = 0
const delays: number[] = []
const requestSyntax = await solution.fetchAccountTask(async () => {
  syntaxCalls++
  throw new SyntaxError('invalid request url')
}).runResult({clock: {now: () => 0, random: () => 0.5, sleep: async ms => { delays.push(ms) }}})
assert.equal(syntaxCalls, 3)
assert.deepEqual(delays, [25, 50])
assert.equal(requestSyntax.isErr(), true)
if (requestSyntax.isErr()) { assert.ok(ApiError.is(requestSyntax.error)); assert.equal(requestSyntax.error.reason, 'request') }

// Safe HTTP error construction with circular headers
const circularHeaders: Record<string, unknown> = {}
circularHeaders.self = circularHeaders
const circularRes = await solution.fetchAccountTask(async () => ({
  headers: circularHeaders,
  status: 404,
  json: async () => ({}),
  text: async () => 'missing',
})).runResult()
assert.equal(circularRes.isErr(), true)
if (circularRes.isErr()) assert.equal(circularRes.error.reason, 'not-found')

// Cancellation stops retries immediately
const controller = new AbortController()
let cancelAttempts = 0
const exit = await solution.fetchAccountTask(async () => {
  cancelAttempts++
  return new Response('unavailable', {status: 503})
}).runExit({
  signal: controller.signal,
  clock: {now: () => 0, random: () => 0.5, sleep: async () => { controller.abort('stop') }},
})
assert.equal(cancelAttempts, 1)
assert.equal(exit._tag, 'Failure')
if (exit._tag === 'Failure') assert.equal(Cause.hasInterrupts(exit.cause), true)`,
    mutate: source => source.replace('times: 2', 'times: 0'),
  },
];
