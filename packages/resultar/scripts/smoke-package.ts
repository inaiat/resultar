import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type PackFile = Readonly<{ path: string }>
type PackManifest = Readonly<{ files: readonly PackFile[] }>

const rootDir = fileURLToPath(new URL('..', import.meta.url))

const requiredFiles = [
  'LICENSE',
  'README.md',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/result.d.ts',
  'dist/result.js',
  'dist/task.d.ts',
  'dist/task.js',
  'dist/match.d.ts',
  'dist/match.js',
  'dist/tagged.d.ts',
  'dist/tagged.js',
  'dist/retry.d.ts',
  'dist/retry.js',
  'dist/function.d.ts',
  'dist/function.js',
  'dist/async.d.ts',
  'dist/async.js',
  'package.json',
] as const

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

const isPackFile = (value: unknown): value is PackFile =>
  isRecord(value) && typeof value['path'] === 'string'

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) && Array.isArray(value['files']) && value['files'].every(isPackFile)

const parseJsonArrayFromNpmOutput = (packOutput: string): unknown => {
  const trimmed = packOutput.trim()
  let index = trimmed.indexOf('[')

  while (index >= 0) {
    try {
      return JSON.parse(trimmed.slice(index)) as unknown
    } catch {
      index = trimmed.indexOf('[', index + 1)
    }
  }

  throw new TypeError('npm pack did not include JSON output')
}

const parsePackedFiles = (packOutput: string): readonly string[] => {
  const parsed = parseJsonArrayFromNpmOutput(packOutput)

  if (!Array.isArray(parsed) || !isPackManifest(parsed[0])) {
    throw new TypeError('npm pack returned an unexpected manifest shape')
  }

  return parsed[0].files.map((file) => file.path)
}

for (const file of requiredFiles) {
  if (!existsSync(path.join(rootDir, file))) {
    throw new Error(`Missing package smoke file: ${file}`)
  }
}

const entrypoint = (await import(
  pathToFileURL(path.join(rootDir, 'dist/index.js')).href
)) as Record<string, unknown>
const expectedExports = [
  'AbortError',
  'Cause',
  'Clock',
  'Deferred',
  'DisposableResult',
  'Fiber',
  'Match',
  'MissingServiceError',
  'Queue',
  'Ref',
  'Result',
  'ResultTask',
  'ResultTaskCauseError',
  'ResultTaskTypeId',
  'ResultTaskYieldTypeId',
  'Retry',
  'Scheduler',
  'Semaphore',
  'ServiceTagTypeId',
  'TaskLocal',
  'Tracer',
  'VirtualClock',
  'constant',
  'createTaggedError',
  'err',
  'findCause',
  'flow',
  'fromThrowable',
  'identity',
  'isAbortError',
  'isError',
  'isRedacted',
  'isResultTask',
  'isServiceTag',
  'matchError',
  'matchErrorPartial',
  'ok',
  'pipe',
  'redact',
  'revealRedacted',
  'runSync',
  'serviceTag',
  'taggedEnum',
  'tryResult',
  'unit',
] as const
const actualExports = Object.keys(entrypoint).toSorted()

if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(
    `Unexpected public exports:\nactual: ${actualExports.join(', ')}\nexpected: ${expectedExports.join(', ')}`,
  )
}

const asyncEntrypoint = (await import(
  pathToFileURL(path.join(rootDir, 'dist/async.js')).href
)) as Record<string, unknown>
const expectedAsyncExports = [
  'DisposableResultAsync',
  'ResultAsync',
  'asyncAndThen',
  'asyncMap',
  'errAsync',
  'fromCallback',
  'fromPromise',
  'fromSafePromise',
  'fromThrowableAsync',
  'okAsync',
  'runPromise',
  'safeTry',
  'tryAsync',
  'tryCatchAsync',
  'tryResultAsync',
  'unitAsync',
] as const
const actualAsyncExports = Object.keys(asyncEntrypoint).toSorted()

if (JSON.stringify(actualAsyncExports) !== JSON.stringify(expectedAsyncExports)) {
  throw new Error(
    `Unexpected async subpath exports:\nactual: ${actualAsyncExports.join(', ')}\nexpected: ${expectedAsyncExports.join(', ')}`,
  )
}

const asyncDeclarations = readFileSync(path.join(rootDir, 'dist/async.d.ts'), 'utf8')
if (!asyncDeclarations.includes('@deprecated')) {
  throw new Error('Expected @deprecated JSDoc annotations in dist/async.d.ts')
}

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: rootDir,
  encoding: 'utf8',
})
const packedFiles = parsePackedFiles(packOutput).toSorted()

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed package is missing required file: ${file}`)
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|package\.json|dist\/[^/]+\.(?:js|d\.ts|js\.map))$/u
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file))

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed package contains unexpected files:\n${unexpectedFiles.join('\n')}`)
}

process.stdout.write(`Package smoke passed with ${packedFiles.length} packed files.\n`)

const declarations = readFileSync(path.join(rootDir, 'dist/index.d.ts'), 'utf8')
if (declarations.includes('toTapContinuationStep')) {
  throw new Error('Internal continuation helper leaked into public declarations')
}

execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import assert from 'node:assert/strict';
import * as resultar from './dist/index.js';
import {Cause, constant, createTaggedError, Fiber, flow, identity, Match, ok, pipe, Result, ResultTask, Retry, Scheduler} from './dist/index.js';
import {ResultAsync, asyncAndThen, asyncMap, okAsync} from './dist/async.js';
const UntypedMissing = createTaggedError({ name: 'Missing', message: 'Missing $id' });
const TypedMissing = UntypedMissing.withProps();
const missing = new TypedMissing({ id: 'user_1', details: { source: 'database' } });
assert.equal(missing.id, 'user_1');
assert.equal(missing.message, 'Missing user_1');
assert.equal(TypedMissing.is(missing), true);
assert.equal(TypedMissing.is(new UntypedMissing({ id: 1 })), false);
assert.equal(TypedMissing.err({ id: 'user_2' })._unsafeUnwrapErr().id, 'user_2');
assert.deepEqual(missing.toJSON().details, { source: 'database' });
class GetterProps { get id() { return 'user_getter'; } }
const getterMissing = new TypedMissing(new GetterProps());
assert.equal(getterMissing.id, 'user_getter');
assert.equal(getterMissing.message, 'Missing user_getter');
assert.equal(TypedMissing.is(getterMissing), true);
assert.equal(getterMissing.toJSON().id, 'user_getter');
assert.equal(resultar.Result.try, resultar.tryResult);
const returned = ok('same-result');
assert.equal(Result.gen(function* () { return 'plain-success'; })._unsafeUnwrap(), 'plain-success');
assert.equal((await ResultAsync.gen(async function* () { const value = yield* okAsync('async-success'); return value; }))._unsafeUnwrap(), 'async-success');
assert.equal(Result.gen(function* () { yield* resultar.err('early-error'); return 'unreachable'; })._unsafeUnwrapErr(), 'early-error');
assert.equal(Result.gen(function* () { return yield* returned; })._unsafeUnwrap(), 'same-result');
assert.equal(returned.inspect(() => { throw new Error('observer'); }), returned);
assert.equal(await ResultTask.runPromise(ResultTask.ok(1).andThen(value => ResultTask.ok(value + 1))), 2);
assert.equal(await ResultTask.runPromise(ResultTask.err('old').orElse(() => ResultTask.ok('kept'))), 'kept');
assert.equal(Result.fromNullishOr(undefined, () => 'missing')._unsafeUnwrapErr(), 'missing');
assert.equal(pipe(0, Result.fromNullishOr(() => 'missing'))._unsafeUnwrap(), 0);
assert.equal(Result.liftPredicate(2, (value) => value > 0, () => 'invalid')._unsafeUnwrap(), 2);
assert.equal(pipe(-1, Result.liftPredicate((value) => value > 0, () => 'invalid'))._unsafeUnwrapErr(), 'invalid');
const cause = {_tag:'Sequential', left: {_tag:'Fail', error:'query'}, right: {_tag:'Die', defect:'close'}};
assert.equal(Cause.hasFails(cause), true);
assert.equal(Cause.hasDies(cause), true);
assert.equal(Cause.hasInterrupts(cause), false);
assert.equal(Cause.findError(cause)._unsafeUnwrap(), 'query');
assert.equal(Cause.pretty(cause), 'Fail: query\\nDie: close');
assert.equal(pipe(ok(2), Result.map(value => value * 3), Result.andThen(value => ok(String(value))), Result.match({ok: value => value, err: () => 'failed'})), '6');
assert.equal((await pipe(ResultAsync.ok(2), ResultAsync.map(value => value * 3), ResultAsync.andThen(value => ok(String(value)))))._unsafeUnwrap(), '6');
assert.equal((await asyncMap(ok(2), async value => value * 3))._unsafeUnwrap(), 6);
assert.equal((await asyncAndThen(ok(2), value => okAsync(value * 4)))._unsafeUnwrap(), 8);
assert.equal(await ResultAsync.err('boom').match({ok: () => 'ok', err: error => error}), 'boom');
const normalize = flow((value) => value.trim(), (value) => value.toLowerCase());
assert.equal(pipe(' ADA ', normalize), 'ada');
assert.equal(ok('Ready').match({ok: identity, err: constant('Unavailable')}), 'Ready');
assert.equal(Match.value('Ada').pipe(Match.when(Match.string, (value) => value.length), Match.exhaustive), 3);
const label = Match.fn((prefix, input) => input).pipe(Match.tagsExhaustive({Created: (event, prefix) => prefix + event.id}));
assert.equal(label('id:', {_tag: 'Created', id: '1'}), 'id:1');
assert.equal(Match.value(0).when(1, () => true).result().isErr(), true);
const lazy = ResultTask.fn(function* (value) { return yield* ResultTask.ok(value); });
const task = lazy(42);
assert.equal(await ResultTask.runPromise(task), 42);
assert.equal(await ResultTask.runPromise(task), 42);
assert.equal(typeof Scheduler.live.yield, 'function');
const observedFiber = ResultTask.gen(function* () {
  const fiber = yield* ResultTask.forkChild(ResultTask.err('child-failure'));
  return yield* Fiber.await(fiber);
});
assert.deepEqual(await ResultTask.runPromise(observedFiber), {_tag: 'Failure', cause: {_tag: 'Fail', error: 'child-failure'}});
const rootFiber = ResultTask.runFork(ResultTask.ok('root-fiber'));
assert.equal(Number.isSafeInteger(rootFiber.id), true);
let rootSnapshot;
const removeRootObserver = Fiber.addObserver(rootFiber, exit => { rootSnapshot = exit; });
assert.equal(await ResultTask.runPromise(Fiber.join(rootFiber, {interruption: 'detach'})), 'root-fiber');
assert.deepEqual(Fiber.poll(rootFiber), {_tag: 'Success', value: 'root-fiber'});
assert.deepEqual(rootSnapshot, Fiber.poll(rootFiber));
removeRootObserver();
const retryPolicy = Retry.policy({times: 1, delayMs: 0, backoff: 2, jittered: 0.2});
assert.equal(Object.isFrozen(retryPolicy), true);
let taskAttempts = 0;
assert.equal(await ResultTask.runPromise(ResultTask.sync(() => ++taskAttempts).andThen(attempt => attempt === 1 ? ResultTask.err('retry') : ResultTask.ok('ready')).retry(retryPolicy)), 'ready');
const timeoutClock = resultar.Clock.virtual();
const detached = ResultTask.tryPromise({try: () => new Promise(() => {}), catch: () => 'unexpected', interruption: 'detach'}).timeout(1, () => 'timed-out');
const detachedRun = ResultTask.runResult(detached, {clock: timeoutClock});
await timeoutClock.advanceBy(1);
assert.equal((await detachedRun)._unsafeUnwrapErr(), 'timed-out');
assert.equal(await ResultTask.runPromise(ResultTask.err({_tag:'Missing'}).catchTags({Missing: () => ResultTask.ok('guest')})), 'guest');
let disposed = 0;
await ResultTask.runPromise(ResultTask.acquireDisposable(ResultTask.ok({[Symbol.asyncDispose]: async () => {disposed++;}})));
assert.equal(disposed, 1);`,
  ],
  { cwd: rootDir, stdio: 'inherit' },
)

const consumerDirectory = mkdtempSync(path.join(tmpdir(), 'resultar-instance-runners-'))
try {
  const archive = path.join(consumerDirectory, 'resultar.tgz')
  execFileSync('pnpm', ['--config.ignore-scripts=true', 'pack', '--out', archive], {
    cwd: rootDir,
    stdio: 'pipe',
  })
  const installed = path.join(consumerDirectory, 'node_modules', 'resultar')
  mkdirSync(installed, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', installed])
  const consumer = path.join(consumerDirectory, 'instance-runners.mts')
  writeFileSync(
    consumer,
    `import { Fiber, ResultTask, type Result, type Exit, type FiberHandle } from 'resultar';
import { ok as subOk } from 'resultar/result';
import { Deferred as SubDeferred, Queue as SubQueue, Ref as SubRef, TaskLocal as SubLocal, Tracer as SubTracer } from 'resultar/task';
import { Match as SubMatch } from 'resultar/match';
import { createTaggedError as subTaggedError, redact as subRedact } from 'resultar/tagged';
import { Retry as SubRetry } from 'resultar/retry';
import { pipe as subPipe } from 'resultar/function';
if (subPipe(subOk(20), (r) => r.map((n) => n + 22)).unwrapOr(0) !== 42) throw new Error('Subpath result/function failed');
if (SubMatch.value(1).when(1, () => 'one').orElse(() => 'other') !== 'one') throw new Error('Subpath match failed');
const SubErr = subTaggedError({ name: 'SubErr', message: 'Secret $secret' });
if (!new SubErr({ secret: subRedact('top') }).message.includes('<redacted>')) throw new Error('Subpath tagged failed');
if (SubRetry.policy({ times: 1, maxDelayMs: 50 }).times !== 1) throw new Error('Subpath retry failed');
const subRef = SubRef.make(1);
const subLocal = SubLocal.make('def');
const subTracer = SubTracer.memory();
const subDef = SubDeferred.make<number>();
const subQ = SubQueue.bounded<number>(2);
if (subRef.updateAndGet((n) => n + 1).runSync().unwrapOr(0) !== 2) throw new Error('Subpath ref/runSync failed');
if (subLocal.locally('x', subLocal.get()).withSpan('smoke').runSync({ tracer: subTracer }).unwrapOr('') !== 'x') throw new Error('Subpath local/tracer failed');
if (subTracer.spans.length !== 1) throw new Error('Subpath tracer span missing');
if (!subDef.succeed(7).runSync().unwrapOr(false) || subDef.await().runSync().unwrapOr(0) !== 7) throw new Error('Subpath deferred failed');
if (!subQ.offer(9).runSync().unwrapOr(false) || subQ.take().runSync().unwrapOr(0) !== 9) throw new Error('Subpath queue failed');
let executions = 0;
const task = ResultTask.sync(() => ++executions);
const result: Result<number, never> = await task.runResult();
if (!result.isOk() || result.value !== 1) throw new Error('Invalid Result boundary');
const value: number = await task.runPromise();
if (value !== 2) throw new Error('Invalid Promise boundary');
const exit: Exit<number, never> = await task.runExit();
if (exit._tag !== 'Success' || exit.value !== 3) throw new Error('Invalid Exit boundary');
const fiber: FiberHandle<number, never> = task.runFork();
const forked = await Fiber.await(fiber).runPromise();
if (forked._tag !== 'Success' || forked.value !== 4) throw new Error('Invalid Fiber boundary');
if (await ResultTask.runPromise(task) !== 5) throw new Error('Static runner changed');
const Config = ResultTask.service<{readonly value: number}>()('config');
const workflow = ResultTask.gen(function*() {
 const config = yield* Config;
 yield* ResultTask.acquireRelease({
  acquire: ResultTask.ok(config.value),
  release: () => ResultTask.err('release' as const),
 });
 return config.value;
});
const options = {services: {config: {value: 42}}};
const release: Result<number, 'release'> = await workflow.runResult(options);
if (!release.isErr() || release.error !== 'release') throw new Error('Missing release failure');
const releasedExit: Exit<number, 'release'> = await workflow.runExit(options);
if (releasedExit._tag !== 'Failure') throw new Error('Missing failed Exit');
const releasedFiber: FiberHandle<number, 'release'> = workflow.runFork(options);
if ((await Fiber.await(releasedFiber).runPromise())._tag !== 'Failure') throw new Error('Missing failed fiber');
if (false) {
 const promised: Promise<number> = workflow.runPromise(options);
 // @ts-expect-error Required services must be supplied.
 workflow.runResult();
 // @ts-expect-error Required services must be supplied.
 workflow.runPromise();
 // @ts-expect-error Required services must be supplied.
 workflow.runExit();
 // @ts-expect-error Required services must be supplied.
 workflow.runFork();
 // @ts-expect-error Run options cannot widen the service contract.
 workflow.runResult({services: {config: {value: 'wrong'}}});
 // @ts-expect-error Run options cannot widen the service contract.
 workflow.runPromise({services: {config: {value: 'wrong'}}});
 // @ts-expect-error Run options cannot widen the service contract.
 workflow.runExit({services: {config: {value: 'wrong'}}});
 // @ts-expect-error Run options cannot widen the service contract.
 workflow.runFork({services: {config: {value: 'wrong'}}});
 // @ts-expect-error Requirement-free tasks reject extra services.
 task.runResult(options);
 const {runResult, runPromise, runExit, runFork} = task;
 // @ts-expect-error A runner needs its Task receiver.
 runResult();
 // @ts-expect-error A runner needs its Task receiver.
 runPromise();
 // @ts-expect-error A runner needs its Task receiver.
 runExit();
 // @ts-expect-error A runner needs its Task receiver.
 runFork();
 // @ts-expect-error Task does not become a PromiseLike.
 const implicit: PromiseLike<number> = task;
 // @ts-expect-error The interpreter's run method remains private.
 task.run();
}
`,
  )
  execFileSync(
    path.join(rootDir, 'node_modules/.bin/tsc'),
    [
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--target',
      'ESNext',
      consumer,
    ],
    { stdio: 'inherit' },
  )
  execFileSync(process.execPath, [consumer], { stdio: 'inherit' })
  process.stdout.write('Packed ResultTask instance runners passed types and execution.\n')

  // Isolated ESM subpath smoke executions (each in its own Node process without importing root `resultar`).
  const isolatedSubpaths: readonly Readonly<{ readonly name: string; readonly code: string }>[] = [
    {
      name: 'resultar/task',
      code: `import assert from 'node:assert/strict';
import { ResultTask } from 'resultar/task';
const pending = ResultTask.ok(42).runResult();
assert.equal(pending instanceof Promise, true);
const result = await pending;
assert.equal(result.isOk(), true);
assert.equal(result.value, 42);`,
    },
    {
      name: 'resultar/result',
      code: `import assert from 'node:assert/strict';
import { ok, Result } from 'resultar/result';
const result = Result.gen(function* () {
  const a = yield* ok(20);
  const b = yield* ok(22);
  return a + b;
});
assert.equal(result.isOk(), true);
assert.equal(result.value, 42);`,
    },
    {
      name: 'resultar/async',
      code: `import assert from 'node:assert/strict';
import { ok } from 'resultar/result';
import { ResultTask } from 'resultar/task';
import { ResultAsync, okAsync, errAsync, asyncMap, safeTry } from 'resultar/async';
const genResult = await ResultAsync.gen(async function* () {
  const a = yield* okAsync(20);
  const b = yield* ok(22);
  return a + b;
});
assert.equal(genResult.isOk(), true);
assert.equal(genResult.value, 42);
const mapped = await asyncMap(ok(2), async (x) => x * 3);
assert.equal(mapped.isOk(), true);
assert.equal(mapped.value, 6);
const fromTaskRes = await ResultAsync.fromTask(ResultTask.ok(99));
assert.equal(fromTaskRes.isOk() && fromTaskRes.value, 99);
let attempts = 0;
const retried = await ResultAsync.retry(() => (++attempts < 2 ? errAsync('retry') : okAsync('ok')), { times: 1 });
assert.equal(retried.isOk() && retried.value, 'ok');
let released = false;
const withRes = await ResultAsync.withResource({
  acquire: () => okAsync('conn'),
  use: (conn) => okAsync(conn + ':used'),
  release: () => { released = true; },
});
assert.equal(withRes.isOk() && withRes.value, 'conn:used');
assert.equal(released, true);
const cbRes = await ResultAsync.fromCallback({
  subscribe: (ctx) => { ctx.resolve('cb'); },
  catch: (e) => String(e),
});
assert.equal(cbRes.isOk() && cbRes.value, 'cb');
let tapped = 0;
const tapRes = await okAsync(5).tap((v) => { tapped += v; }).tapError(() => { tapped = -1; });
assert.equal(tapRes.isOk() && tapRes.value, 5);
assert.equal(tapped, 5);
const safeRes = await safeTry(async function* () {
  const v = yield* okAsync(12);
  return ok(v + 3);
});
assert.equal(safeRes.isOk() && safeRes.value, 15);`,
    },
  ]

  for (const subpath of isolatedSubpaths) {
    execFileSync(process.execPath, ['--input-type=module', '-e', subpath.code], {
      cwd: consumerDirectory,
      stdio: 'inherit',
    })
  }
  process.stdout.write(
    `Isolated ESM subpath smoke passed for: ${isolatedSubpaths.map((item) => item.name).join(', ')}.\n`,
  )
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true })
}
