package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const v5ResultarTypes = `
export interface Result<T, E = never> {
  readonly value: T
  readonly error: E
  isOk(): boolean
  isErr(): boolean
  map<U>(fn: (value: T) => U): Result<U, E>
  mapErr<F>(fn: (error: E) => F): Result<T, F>
  andThen<U, F>(fn: (value: T) => Result<U, F>): Result<U, E | F>
  orElse<U, F>(fn: (error: E) => Result<U, F>): Result<T | U, F>
  inspect(fn: (value: T) => void): Result<T, E>
  inspectError(fn: (error: E) => void): Result<T, E>
}
export type StrictResult<T, E extends Error = Error> = Result<T, E>
export interface ResultTaskScope<E = never> { readonly _scope: E }
export interface ResultTaskService<Id extends string, S> { readonly _id: Id; readonly _svc: S }
export interface ResultTask<A, E = never, R = never> {
  readonly _a: A
  readonly _e: E
  readonly _r: R
  map<B>(fn: (value: A) => B): ResultTask<B, E, R>
  mapErr<F>(fn: (error: E) => F): ResultTask<A, F, R>
  andThen<B, F, R2>(fn: (value: A) => ResultTask<B, F, R2>): ResultTask<B, E | F, R | R2>
  orElse<B, F, R2>(fn: (error: E) => ResultTask<B, F, R2>): ResultTask<A | B, F, R | R2>
  tap<E2 = never, R2 = never>(fn: (value: A) => ResultTask<unknown, E2, R2> | Promise<unknown> | void): ResultTask<A, E | E2, R | R2>
  tapError<E2 = never, R2 = never>(fn: (error: E) => ResultTask<unknown, E2, R2> | Promise<unknown> | void): ResultTask<A, E | E2, R | R2>
  inspect(fn: (value: A) => void): ResultTask<A, E, R>
  inspectError(fn: (error: E) => void): ResultTask<A, E, R>
  unwrapOr<B>(defaultValue: B): ResultTask<A | B, never, R>
  runResult(): Promise<Result<A, E>>
  runPromise(): Promise<A>
  [Symbol.iterator](): Generator<ResultTask<never, E, R>, A, unknown>
}
export type StrictResultTask<T, E extends Error = Error, R = never> = ResultTask<T, E, R>
export declare const ResultTask: {
  ok<A>(value: A): ResultTask<A, never, never>
  err<E>(error: E): ResultTask<never, E, never>
  gen<Y, A>(body: () => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): ResultTask<A, never, never>
}
export declare function ok<T>(value: T): Result<T, never>
export declare function err<E>(error: E): Result<never, E>
`

const v5ResultarAsyncTypes = `
import type { Result } from './index.js'
export interface ResultAsync<T, E = never> extends PromiseLike<Result<T, E>> {
  map<U>(fn: (value: T) => U | Promise<U>): ResultAsync<U, E>
  mapErr<F>(fn: (error: E) => F | Promise<F>): ResultAsync<T, F>
  inspect(fn: (value: T) => void | Promise<void>): ResultAsync<T, E>
  inspectError(fn: (error: E) => void | Promise<void>): ResultAsync<T, E>
}
export type StrictResultAsync<T, E extends Error = Error> = ResultAsync<T, E>
export declare function okAsync<T>(value: T): ResultAsync<T, never>
`

func writeV5Fixture(t *testing.T, source string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"package.json": `{"type":"module"}`,
		"node_modules/resultar/package.json": `{
  "name": "resultar",
  "type": "module",
  "exports": {
    ".": { "types": "./index.d.ts" },
    "./async": { "types": "./async.d.ts" }
  }
}`,
		"node_modules/resultar/index.d.ts": v5ResultarTypes,
		"node_modules/resultar/async.d.ts": v5ResultarAsyncTypes,
		"tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}`,
		"src/fixture.ts": source,
	}
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestNoAwaitResultTaskRule(t *testing.T) {
	if config.Defaults().NoAwaitResultTask != config.SeverityError {
		t.Fatalf("expected NoAwaitResultTask default to be error, got %q", config.Defaults().NoAwaitResultTask)
	}

	source := `import { ResultTask, type Result, type ResultTaskScope, type ResultTaskService, type StrictResultTask } from "resultar"

type Db = ResultTaskService<"db", { query(): void }>
declare const lookup: () => ResultTask<string, Error>
declare const scopedLookup: () => ResultTask<string, Error, ResultTaskScope<Error>>
declare const strictLookup: () => StrictResultTask<string, Error>
declare const dbLookup: () => ResultTask<string, Error, Db>
declare const mixedLookup: () => ResultTask<string, Error> | Promise<string>
declare function consumeResult(r: Result<string, Error>): void

// 1. Narrowed Task, no service requirements, surrounding positively expects Result -> error + .runResult() fix
export async function okFixResultMember() {
  const res = await lookup()
  return res.isOk()
}
export async function okFixScoped(): Promise<Result<string, Error>> {
  const res = await scopedLookup()
  return res
}
export async function okFixStrict(): Promise<Result<string, Error>> {
  return await strictLookup()
}
export const okFixContextualReturn: () => Promise<Result<string, Error>> = async () => await lookup()

// 2. Unannotated / inferred return without Result evidence -> diagnostic ONLY, no .runResult() fix
export async function noFixInferredReturn() {
  return await lookup()
}
export async function noFixInferredVar() {
  const pending = await lookup()
  return pending
}
export const noFixInferredArrow = async () => await lookup()
export async function okFixArg() {
  consumeResult(await lookup() as unknown as Result<string, Error>)
}

// 3. Surrounding expects non-Result value (not Result) -> diagnostic only, no .runResult() fix
export async function noFixNonResultReturn(): Promise<string> {
  return (await lookup()) as unknown as string
}
export async function noFixDiscarded() {
  await lookup()
}

// 4. Missing services -> diagnostic only, no edit
export async function noFixMissingServices() {
  const res = await dbLookup()
  return res.isOk()
}

// 5. Mixed union -> diagnostic only, no edit
export async function noFixMixedUnion() {
  const res = await mixedLookup()
  return res
}

// 6. Inside ResultTask.gen -> diagnostic explaining yield*, no edit, and no duplicate no-await-in-result-task-gen
export const insideGen = ResultTask.gen(async function* () {
  const res = await lookup()
  return res
})

declare const labelled: ResultTask<{ label: string }, Error>
declare const optionalValue: ResultTask<{ value: number } | undefined, Error>
export async function mixedKeys() { const {value, label} = await labelled; return [value, label] }
export async function ambiguousDirect() { return (await optionalValue).value }
export async function ambiguousAlias() { const res = await optionalValue; return res.value }

// 7. Valid execution boundary: awaiting .runResult() or .runPromise() -> 0 findings
export async function validBoundary(): Promise<Result<string, Error>> {
  const value = await lookup().runPromise()
  void value
  return await lookup().runResult()
}
`
	dir := writeV5Fixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v, diagnostics: %v", err, diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.UnsafeResultTypeAssertion = config.SeverityOff
	options.NoPromiseResultar = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}

	var awaitFindings []Finding
	for _, f := range findings {
		if f.Rule == "no-await-in-result-task-gen" {
			t.Fatalf("expected no-await-result-task to replace duplicate no-await-in-result-task-gen on await task, got %#v", f)
		}
		if f.Rule == "no-await-result-task" {
			awaitFindings = append(awaitFindings, f)
		}
	}

	if len(awaitFindings) != 16 {
		t.Fatalf("expected 16 no-await-result-task findings, got %d: %#v", len(awaitFindings), awaitFindings)
	}

	// Verify autofix availability per case.
	type expectCase struct {
		wantFix      bool
		wantContains string
	}
	expectations := []expectCase{
		{true, ".runResult()"},      // okFixResultMember
		{true, ".runResult()"},      // okFixScoped
		{true, ".runResult()"},      // okFixStrict
		{true, ".runResult()"},      // okFixContextualReturn
		{false, ".runResult()"},     // noFixInferredReturn
		{false, ".runResult()"},     // noFixInferredVar
		{false, ".runResult()"},     // noFixInferredArrow
		{false, ".runResult()"},     // okFixArg (cast to unknown as Result wraps await)
		{false, ".runResult()"},     // noFixNonResultReturn
		{false, ".runResult()"},     // noFixDiscarded
		{false, ".provideServices"}, // noFixMissingServices
		{false, "union containing"}, // noFixMixedUnion
		{false, "yield*"},           // insideGen
		{false, ".runResult()"},     // mixedKeys
		{false, ".runResult()"},     // ambiguousDirect
		{false, ".runResult()"},     // ambiguousAlias
	}
	for i, exp := range expectations {
		f := awaitFindings[i]
		if f.Severity != config.SeverityError {
			t.Errorf("finding %d severity = %q, want error", i, f.Severity)
		}
		if !strings.Contains(f.Message, exp.wantContains) {
			t.Errorf("finding %d message = %q, want substring %q", i, f.Message, exp.wantContains)
		}
		hasFix := len(f.Fixes) > 0
		if hasFix != exp.wantFix {
			t.Errorf("finding %d (line %d) hasFix=%v, want %v (finding: %#v)", i, f.Line, hasFix, exp.wantFix, f)
		}
		if hasFix && f.Fixes[0].Edits[0].NewText != ".runResult()" {
			t.Errorf("finding %d fix text = %q, want .runResult()", i, f.Fixes[0].Edits[0].NewText)
		}
	}
}

func TestPreferTapAndInspectV5Semantics(t *testing.T) {
	source := `import type { Result, ResultTask } from "resultar"
import type { ResultAsync } from "resultar/async"

declare const res: Result<number, Error>
declare const task: ResultTask<number, Error>
declare const ra: ResultAsync<number, Error>
declare function log(v: unknown): void

let count = 0

// 1. ResultTask -> suggests tap / tapError with safe fix
export const t1 = task.map((x) => {
  const local = { get current(): number { return x } }
  log(local.current)
  log(x)
  return x
})
export const t2 = task.mapErr((e) => {
  log(e)
  return e
})

// 2. Result with throwing/call effect -> suggests inspect / inspectError, guidance only (no autofix)
export const r1 = res.map((x) => {
  log(x)
  return x
})
export const r2 = res.mapErr((e) => {
  log(e)
  return e
})

// 3. Result with simple non-throwing mutation -> suggests inspect with safe fix
export const rSafe = res.map((x) => {
  count += 1
  return x
})

// 4. ResultAsync -> suggests inspect / inspectError (NEVER tap / tapError!), guidance only
export const a1 = ra.map((x) => {
  log(x)
  return x
})
export const a2 = ra.mapErr((e) => {
  log(e)
  return e
})
declare const optional: ResultTask<number | undefined, Error | undefined>
export const defaultValue = optional.map((x = 7) => { log(x); return x })
export const restValue = optional.map((...xs) => { log(xs); return xs })
export const defaultError = optional.mapErr((e = new Error()) => { log(e); return e })
export const restError = optional.mapErr((...es) => { log(es); return es })
declare const account: Result<{ status: number }, { status: number }>
export const getterRead = account.map(x => { void x.status; return x })
export const computedGetterRead = account.mapErr(x => { void x["status"]; return x })
export const destructuredGetter = account.map(x => { const { status } = x; void status; return x })
export const spreadGetter = account.map(x => { void { ...x }; return x })
declare const big: Result<bigint, bigint>
export const divides = big.mapErr(x => { void (x / 0n); return x })
export const generator = task.map(function* (x) { yield x + 1; return x })
export const generatorError = task.mapErr(function* (e) { yield e.message; return e })
export const changed = task.map(x => { x += 10; return x })
export const reassigned = task.mapErr(e => { e = new Error(); return e })
export const shadow = task.map(x => { if (x) { const x = 2; return x }; return x })
export const empty = task.map(x => { if (x) return; return x })
void count
`
	dir := writeV5Fixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v, diagnostics: %v", err, diagnostics)
	}
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}

	type wantRow struct {
		rule    string
		suggest string
		wantFix bool
	}
	wants := []wantRow{
		{"prefer-tap", "`tap`", true},                 // t1
		{"prefer-tap-error", "`tapError`", true},      // t2
		{"prefer-tap", "`inspect`", false},            // r1
		{"prefer-tap-error", "`inspectError`", false}, // r2
		{"prefer-tap", "`inspect`", true},             // rSafe
		{"prefer-tap", "`inspect`", false},            // a1
		{"prefer-tap-error", "`inspectError`", false}, // a2
		{"prefer-tap", "`inspect`", false},            // getterRead
		{"prefer-tap-error", "`inspectError`", false}, // computedGetterRead
		{"prefer-tap", "`inspect`", false},            // destructuredGetter
		{"prefer-tap", "`inspect`", false},            // spreadGetter
		{"prefer-tap-error", "`inspectError`", false}, // divides
	}
	if len(findings) != len(wants) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(wants), findings)
	}
	for i, w := range wants {
		f := findings[i]
		if f.Rule != w.rule || !strings.Contains(f.Message, w.suggest) {
			t.Errorf("finding %d = (%s, %q), want (%s, contains %s)", i, f.Rule, f.Message, w.rule, w.suggest)
		}
		if (len(f.Fixes) > 0) != w.wantFix {
			t.Errorf("finding %d (line %d) hasFix=%v, want %v", i, f.Line, len(f.Fixes) > 0, w.wantFix)
		}
	}

	// Apply every emitted autofix and verify the resulting TypeScript compiles with 0 semantic errors (no TS2345).
	fixed := source
	for i := len(findings) - 1; i >= 0; i-- {
		f := findings[i]
		if len(f.Fixes) == 0 {
			continue
		}
		for j := len(f.Fixes[0].Edits) - 1; j >= 0; j-- {
			edit := f.Fixes[0].Edits[j]
			fixed = fixed[:edit.Start] + edit.NewText + fixed[edit.Start+edit.Length:]
		}
	}
	if strings.Contains(fixed, "task.tap((x) => {\n  log(x)\n  return x") {
		t.Fatalf("expected trailing return x to be stripped in task.tap autofix:\n%s", fixed)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "fixture.ts"), []byte(fixed), 0o644); err != nil {
		t.Fatal(err)
	}
	reopened, rediags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(rediags) > 0 {
		t.Fatalf("fixed file failed project.Open: err=%v, diagnostics=%v\n%s", err, rediags, fixed)
	}
	ctx := context.Background()
	if syn := reopened.Program.GetSyntacticDiagnostics(ctx, nil); len(syn) > 0 {
		t.Fatalf("fixed file has syntactic diagnostics: %v\n%s", syn, fixed)
	}
	if sem := reopened.Program.GetSemanticDiagnostics(ctx, nil); len(sem) > 0 {
		t.Fatalf("fixed file has semantic diagnostics (e.g. TS2345): %v\n%s", sem, fixed)
	}
}

func TestComputedPropertyKeysNeverPanicInRules(t *testing.T) {
	source := `import { ResultTask } from "resultar"
declare const Result: {
  gen<T>(opts: { readonly [key: symbol]: unknown; try: () => Generator<never, T, unknown> }): T
  try<T, E>(opts: { readonly [key: symbol]: unknown; try: () => T; catch: (e: unknown) => E }): T
}
declare function createTaggedError(opts: { readonly [key: symbol]: unknown; name: string }): new () => Error

const sym = Symbol("meta")

export class CustomErr extends createTaggedError({
  [sym]: 1,
  name: "CustomErr",
}) {}

export const g = Result.gen({
  [sym]: true,
  *try() {
    return 42
  },
})

export const tr = Result.try({
  [sym]: "tag",
  try: () => 1,
  catch: () => new CustomErr(),
})

export const taskGuard = ResultTask.ok(42).map((x) => {
  if (x < 0) return x
  void sym
  return x
})
`
	dir := writeV5Fixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v, diagnostics: %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	// Verify early-guard + trailing-return `prefer-tap` autofix compiles cleanly too.
	for _, f := range findings {
		if f.Rule == "prefer-tap" && len(f.Fixes) == 1 {
			edited := source
			for j := len(f.Fixes[0].Edits) - 1; j >= 0; j-- {
				e := f.Fixes[0].Edits[j]
				edited = edited[:e.Start] + e.NewText + edited[e.Start+e.Length:]
			}
			if err := os.WriteFile(filepath.Join(dir, "src", "fixture.ts"), []byte(edited), 0o644); err != nil {
				t.Fatal(err)
			}
			reopened, rediags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
			if err != nil || len(rediags) > 0 {
				t.Fatalf("reopen failed: %v %v\n%s", err, rediags, edited)
			}
			if sem := reopened.Program.GetSemanticDiagnostics(context.Background(), nil); len(sem) > 0 {
				t.Fatalf("early-guard prefer-tap autofix caused semantic errors: %v\n%s", sem, edited)
			}
		}
	}
}

func TestV5NoPromiseResultarDistinction(t *testing.T) {
	source := `import type { Result, ResultTask, StrictResult, StrictResultTask } from "resultar"

declare const lookup: () => ResultTask<string, Error>
declare const strictLookup: () => StrictResultTask<string, Error>

export const load = async () => lookup()               // diagnostic (Promise<ResultTask<...>>)
export const loadStrict = async () => strictLookup()   // diagnostic (Promise<StrictResultTask<...>>)
export const run = () => lookup().runResult()          // valid (Promise<Result<...>>)
export interface Session {
  close(): Promise<Result<void, Error>>                // valid public boundary
  ready(): Promise<StrictResult<void, Error>>          // valid public boundary
}
`
	dir := writeV5Fixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v, diagnostics: %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 2 {
		t.Fatalf("expected exactly 2 no-promise-resultar findings (load & loadStrict), got %d: %#v", len(findings), findings)
	}
	for _, f := range findings {
		if f.Rule != "no-promise-resultar" || f.Severity != config.SeverityError {
			t.Fatalf("unexpected finding: %#v", f)
		}
	}
}

func TestNoAwaitResultTaskPreservesExplicitLaterExecution(t *testing.T) {
	source := `import type { ResultTask, ResultTaskService } from "resultar"

type Db = ResultTaskService<"db", { query(): void }>
declare const task: ResultTask<string, Error>
declare const dbTask: ResultTask<string, Error, Db>
declare function runTask(t: ResultTask<string, Error>): Promise<string>

// 1. Variable later executed via .runPromise() -> remove await, do NOT insert .runResult()
export async function deferredRunPromise() {
  const later = await task
  return await later.runPromise()
}

// 2. Variable chained and later executed via .runResult() -> remove await
export async function deferredChainedRun() {
  const later = await task
  return await later.map((v) => v + "!").runResult()
}

// 3. Variable explicitly typed as ResultTask -> remove await
export async function explicitTaskType() {
  const later: ResultTask<string, Error> = await task
  return await later.runPromise()
}

// 4. Service-requiring task passed/executed explicitly later -> remove await is still safe
export async function deferredServiceTask() {
  const later = await dbTask
  return later.runPromise
}

// 5. Passed to helper expecting ResultTask -> remove await
export async function passedToTaskHelper() {
  const later = await task
  return await runTask(later)
}

// 6. Direct property access (await task).runPromise() -> remove await
export async function directTaskRunnerAccess() {
  return await (await task).runPromise()
}

// 7. Shared Result/ResultTask operators (.inspect, .inspectError, .unwrapOr) chained into .runPromise() -> remove await
export async function deferredInspectRunPromise() {
  const later = await task
  return await later.inspect(() => {}).runPromise()
}

export async function deferredInspectErrorUnwrapRunPromise() {
  const later = await task
  return await later.inspectError(() => {}).unwrapOr("fallback").runPromise()
}

export async function directInspectChainRunPromise() {
  return await (await task).inspect(() => {}).runPromise()
}

export async function multiLineDerivedTaskChain() {
  const later = await task
  const logged = later.inspect(() => {})
  return await logged.runPromise()
}
`
	dir := writeV5Fixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v, diagnostics: %v", err, diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseResultar = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}

	var awaitFindings []Finding
	for _, f := range findings {
		if f.Rule == "no-await-result-task" {
			awaitFindings = append(awaitFindings, f)
		}
	}
	if len(awaitFindings) != 10 {
		t.Fatalf("expected 10 no-await-result-task findings, got %d: %#v", len(awaitFindings), awaitFindings)
	}

	// Apply fixes in reverse offset order and verify the rewritten TypeScript compiles cleanly.
	fixed := source
	for i := len(awaitFindings) - 1; i >= 0; i-- {
		f := awaitFindings[i]
		if len(f.Fixes) != 1 {
			t.Fatalf("finding %d (line %d): expected 1 fix, got %#v", i, f.Line, f.Fixes)
		}
		if f.Fixes[0].Title != "Remove redundant await on ResultTask" {
			t.Fatalf("finding %d (line %d): got fix title %q, want remove await fix", i, f.Line, f.Fixes[0].Title)
		}
		edit := f.Fixes[0].Edits[0]
		fixed = fixed[:edit.Start] + edit.NewText + fixed[edit.Start+edit.Length:]
	}

	if strings.Contains(fixed, ".runResult().runPromise()") || strings.Contains(fixed, "const later = await") {
		t.Fatalf("unexpected autofix result:\n%s", fixed)
	}
	if !strings.Contains(fixed, "const later = task\n  return await later.runPromise()") {
		t.Fatalf("expected `const later = task` preserving explicit later.runPromise():\n%s", fixed)
	}

	// Verify the fixed file compiles with zero syntactic AND semantic TypeScript diagnostics
	// and zero remaining no-await-result-task findings.
	if err := os.WriteFile(filepath.Join(dir, "src", "fixture.ts"), []byte(fixed), 0o644); err != nil {
		t.Fatal(err)
	}
	reopened, rediags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(rediags) > 0 {
		t.Fatalf("fixed file failed project.Open: err=%v, diagnostics=%v\n%s", err, rediags, fixed)
	}
	ctx := context.Background()
	if syn := reopened.Program.GetSyntacticDiagnostics(ctx, nil); len(syn) > 0 {
		t.Fatalf("fixed file has syntactic diagnostics: %v\n%s", syn, fixed)
	}
	if sem := reopened.Program.GetSemanticDiagnostics(ctx, nil); len(sem) > 0 {
		t.Fatalf("fixed file has semantic diagnostics: %v\n%s", sem, fixed)
	}
	refindings, err := Run(ctx, reopened.Program, reopened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range refindings {
		if f.Rule == "no-await-result-task" {
			t.Fatalf("expected 0 remaining no-await-result-task findings after fix, got %#v", f)
		}
	}
}
