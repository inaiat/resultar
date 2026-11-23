package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

func applySingleFix(source string, fix Fix) string {
	edits := append([]TextEdit(nil), fix.Edits...)
	sort.Slice(edits, func(i, j int) bool {
		if edits[i].Start != edits[j].Start {
			return edits[i].Start > edits[j].Start
		}
		return edits[i].Length > edits[j].Length
	})
	out := source
	for _, edit := range edits {
		out = out[:edit.Start] + edit.NewText + out[edit.Start+edit.Length:]
	}
	return out
}

func applyAllCorrectionFixes(source string, findings []Finding) string {
	var allEdits []TextEdit
	for _, f := range findings {
		for _, fix := range f.Fixes {
			if fix.Kind == FixCorrection && len(fix.Edits) > 0 {
				allEdits = append(allEdits, fix.Edits...)
				break
			}
		}
	}
	sort.Slice(allEdits, func(i, j int) bool {
		if allEdits[i].Start != allEdits[j].Start {
			return allEdits[i].Start > allEdits[j].Start
		}
		return allEdits[i].Length > allEdits[j].Length
	})
	out := source
	for _, edit := range allEdits {
		out = out[:edit.Start] + edit.NewText + out[edit.Start+edit.Length:]
	}
	return out
}

func TestParseSuppressionsUnicodeAndDoubleDashJustification(t *testing.T) {
	source := `type Result<T, E> = { value: T; error: E }
declare function save(): Result<string, Error>
// Ⱥ İ prefix before RESULTAR-CHECK-DISABLE-NEXT-LINE no-discard -- keep this reason
save()
export function boundary() {
  // Ⱥ İ RESULTAR-CHECK-DISABLE-NEXT-LINE no-throw -- native framework boundary
  throw new Error("boom")
}
// Ⱥ İ resultar-check-disable-next-line no-discard -- unused reason to preserve
export const clean1 = 1
// resultar-check-disable-next-line no-discard no-unknown-result-error -- partial reason
save()
// resultar-check-disable-next-line no-discard // slash reason -- with dashes
save()
// resultar-check-disable-next-line no-discard -- dash reason // with slashes
save()
`
	dir := writeFixture(t, source)
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoThrow = config.SeverityError
	opts.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}

	// Only 2 unused-suppression findings:
	// 1. clean1's unused no-discard (with -- reason preserved)
	// 2. partial line's unused no-unknown-result-error (with no-discard and -- reason preserved)
	if len(findings) != 2 {
		t.Fatalf("expected 2 findings, got %d: %#v", len(findings), findings)
	}
	for _, f := range findings {
		if f.Rule != "unused-suppression" || len(f.Fixes) != 1 {
			t.Fatalf("expected unused-suppression with fix, got %#v", f)
		}
	}

	fixed := applyAllCorrectionFixes(source, findings)
	if !strings.Contains(fixed, "// Ⱥ İ  -- unused reason to preserve") {
		t.Fatalf("expected -- reason preserved when removing whole unused directive:\n%s", fixed)
	}
	if !strings.Contains(fixed, "// resultar-check-disable-next-line no-discard  -- partial reason") {
		t.Fatalf("expected -- reason and used rule preserved when removing single unused rule:\n%s", fixed)
	}
	if strings.Contains(fixed, "no-unknown-result-error") {
		t.Fatalf("expected unused rule removed:\n%s", fixed)
	}
}

func TestPreferAsVoidSkipsSideEffectfulVoidOperands(t *testing.T) {
	source := stage1And2Fixture + `
declare const res: Result<number, string>
declare const task: ResultTask<number, string>
declare function log(x: unknown): void
let counter = 0

// Side-effectful void operands must NOT trigger prefer-as-void
export const sideCall = task.map((x) => void log(x))
export const sideConsole = res.map((x) => void console.log(x))
export const sideAssign = task.map((x) => void (counter = x))
export const sideInc = task.map(() => void counter++)
export const sidePreInc = task.map(() => void ++counter)

// Side-effect-free void / undefined expressions MUST trigger prefer-as-void
export const pureUndef = res.map(() => undefined)
export const pureVoid0 = task.map(() => void 0)
export const pureVoidStr = task.map(() => void "")
export const pureVoidBool = task.map(() => void true)
export const pureVoidNull = task.map(() => void null)
export const pureVoidUndef = task.map(() => void undefined)
void counter
`
	dir := writeFixture(t, source)
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	var voidFindings []Finding
	for _, f := range findings {
		if f.Rule == "prefer-as-void" {
			voidFindings = append(voidFindings, f)
		}
	}
	if len(voidFindings) != 6 {
		t.Fatalf("expected 6 prefer-as-void findings (pure only), got %d: %#v", len(voidFindings), voidFindings)
	}
	fixed := applyAllCorrectionFixes(source, voidFindings)
	if !strings.Contains(fixed, "void log(x)") || !strings.Contains(fixed, "void console.log(x)") ||
		!strings.Contains(fixed, "void (counter = x)") || !strings.Contains(fixed, "void counter++") {
		t.Fatalf("side-effectful void expressions must be untouched:\n%s", fixed)
	}
	if strings.Contains(fixed, "void 0") || strings.Contains(fixed, "() => undefined") {
		t.Fatalf("pure void/undefined maps must be rewritten to asVoid():\n%s", fixed)
	}
}

func TestPreferMapAndPreferMapErrCompleteFixesAndSafeOmissions(t *testing.T) {
	source := `
export interface Result<T, E = never> {
  readonly value: T
  readonly error: E
  map<U>(fn: (value: T) => U): Result<U, E>
  mapErr<F>(fn: (error: E) => F): Result<T, F>
  andThen<U, F>(fn: (value: T) => Result<U, F>): Result<U, E | F>
  orElse<U, F>(fn: (error: E) => Result<U, F>): Result<T | U, F>
}
export interface ResultTask<A, E = never, R = never> {
  readonly value: A
  readonly error: E
  readonly requirements: R
  map<B>(fn: (value: A) => B): ResultTask<B, E, R>
  mapErr<F>(fn: (error: E) => F): ResultTask<A, F, R>
  andThen<B, F, R2>(fn: (value: A) => ResultTask<B, F, R2>): ResultTask<B, E | F, R | R2>
  flatMap<B, F, R2>(fn: (value: A) => ResultTask<B, F, R2>): ResultTask<B, E | F, R | R2>
  orElse<B, F, R2>(fn: (error: E) => ResultTask<B, F, R2>): ResultTask<A | B, F, R | R2>
  catchAll<B, F, R2>(fn: (error: E) => ResultTask<B, F, R2>): ResultTask<A | B, F, R | R2>
}
declare const ResultTask: {
  ok<A>(value: A): ResultTask<A>
  succeed<A>(value: A): ResultTask<A>
  err<E>(error: E): ResultTask<never, E>
  fail<E>(error: E): ResultTask<never, E>
}
declare function ok<T>(value: T): Result<T, never>
declare function ok(): Result<undefined, never>
declare function err<E>(error: E): Result<never, E>
declare class AppError extends Error {
  readonly _tag = 'AppError'
  static taskErr(msg: string): ResultTask<never, AppError>
}
declare const res: Result<number, string>
declare const task: ResultTask<number, string>

// Safe to fix (method rename + constructor unwrap):
export const m1 = res.andThen((x) => ok(x + 1))
export const m2 = res.andThen((x) => ok({ count: x }))
export const m3 = res.andThen((x) => {
  const y = x * 2
  return ok(y)
})
export const m4 = task.flatMap((x) => ResultTask.succeed(x + 1))
export const e1 = res.orElse((e) => err("wrapped:" + e))
export const e2 = res.orElse((e) => err({ code: e }))
export const e3 = task.catchAll((e) => ResultTask.fail(e))

// Unsafe to unwrap -> diagnostic WITHOUT FixCorrection:
export const u1 = res.andThen(() => ok())
export const u2 = task.orElse(() => AppError.taskErr("bad"))
export const u3 = res.andThen((x) => {
  if (x > 0) {
    return ok(1)
  }
  return ok(2)
})
export const u4 = res.andThen((x): Result<number, never> => ok(x + 1))
`
	dir := writeFixture(t, source)
	path := filepath.Join(dir, "fixture.ts")
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	opts.PreferOrElseSucceed = config.SeverityOff
	opts.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}

	fixedCount := 0
	unfixedCount := 0
	for _, f := range findings {
		if f.Rule != "prefer-map" && f.Rule != "prefer-map-err" {
			continue
		}
		if len(f.Fixes) > 0 {
			fixedCount++
		} else {
			unfixedCount++
		}
	}
	if fixedCount != 7 || unfixedCount != 4 {
		t.Fatalf("expected 7 fixed and 4 unfixed prefer-map/prefer-map-err findings, got fixed=%d unfixed=%d: %#v", fixedCount, unfixedCount, findings)
	}

	fixed := applyAllCorrectionFixes(source, findings)
	for _, want := range []string{
		`export const m1 = res.map((x) => x + 1)`,
		`export const m2 = res.map((x) => ({ count: x }))`,
		"export const m3 = res.map((x) => {\n  const y = x * 2\n  return y\n})",
		`export const m4 = task.map((x) => x + 1)`,
		`export const e1 = res.mapErr((e) => "wrapped:" + e)`,
		`export const e2 = res.mapErr((e) => ({ code: e }))`,
		`export const e3 = task.mapErr((e) => e)`,
		`export const u1 = res.andThen(() => ok())`,
		`export const u2 = task.orElse(() => AppError.taskErr("bad"))`,
		`export const u4 = res.andThen((x): Result<number, never> => ok(x + 1))`,
	} {
		if !strings.Contains(fixed, want) {
			t.Fatalf("expected fixed output to contain %q:\n%s", want, fixed)
		}
	}

	// Re-open with overlay: must compile with 0 semantic errors and produce 0 prefer-and-then oscillation!
	next, nextDiags, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: fixed})
	if err != nil || len(nextDiags) > 0 {
		t.Fatalf("reopen: %v %v\n%s", err, nextDiags, fixed)
	}
	if sem := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(sem) > 0 {
		t.Fatalf("fixed code has semantic diagnostics: %v\n%s", sem, fixed)
	}
	nextFindings, err := Run(context.Background(), next.Program, next.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range nextFindings {
		if f.Rule == "prefer-and-then" {
			t.Fatalf("prefer-map fix oscillated into prefer-and-then: %#v\n%s", f, fixed)
		}
		if (f.Rule == "prefer-map" || f.Rule == "prefer-map-err") && len(f.Fixes) > 0 {
			t.Fatalf("expected no remaining fixable prefer-map/prefer-map-err findings, got %#v", f)
		}
	}
}

func TestPreferOrElseSucceedFixSideEffectsAndObjectLiteral(t *testing.T) {
	source := stage1And2Fixture + `
declare const res: Result<{ count: number }, string>
declare function log(msg: string): void

export const objConcise = res.orElse(() => ok({ count: 0 }))
export const objBlock = res.orElse(() => { return ok({ count: 1 }) })
export const withSideEffect = res.orElse(() => {
  log("fallback")
  return ok({ count: 2 })
})
`
	dir := writeFixture(t, source)
	path := filepath.Join(dir, "fixture.ts")
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	var orElseFindings []Finding
	for _, f := range findings {
		if f.Rule == "prefer-or-else-succeed" {
			orElseFindings = append(orElseFindings, f)
		}
	}
	if len(orElseFindings) != 3 {
		t.Fatalf("expected 3 prefer-or-else-succeed findings, got %d: %#v", len(orElseFindings), orElseFindings)
	}
	if len(orElseFindings[0].Fixes) != 1 || len(orElseFindings[1].Fixes) != 1 || len(orElseFindings[2].Fixes) != 0 {
		t.Fatalf("expected fixes on concise & single-return block only, not side-effect block: %#v", orElseFindings)
	}

	fixed := applyAllCorrectionFixes(source, orElseFindings)
	if !strings.Contains(fixed, "res.orElseSucceed(() => ({ count: 0 }))") ||
		!strings.Contains(fixed, "res.orElseSucceed(() => ({ count: 1 }))") ||
		!strings.Contains(fixed, `log("fallback")`) {
		t.Fatalf("unexpected fixed output:\n%s", fixed)
	}
	next, nextDiags, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: fixed})
	if err != nil || len(nextDiags) > 0 {
		t.Fatalf("reopen: %v %v\n%s", err, nextDiags, fixed)
	}
	if sem := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(sem) > 0 {
		t.Fatalf("fixed code has semantic diagnostics: %v\n%s", sem, fixed)
	}
}

func TestUnnecessaryPipeOriginSpreadAndParenthesization(t *testing.T) {
	source := `import { pipe } from "resultar"

declare const a: number
declare const b: number
declare const flag: boolean
declare const fn1: (n: number) => number
declare const fn2: (n: number) => number
declare const tag1: (s: TemplateStringsArray) => string
declare const tag2: (s: TemplateStringsArray) => string
declare const args: [number]

// Unrelated local pipe functions must NOT be flagged
export function localPipeScope() {
  const pipe = (x: number) => x + 1
  return pipe(10)
}
export function localPipeDecl() {
  function pipe(x: number) { return x * 2 }
  return pipe(10)
}

// SpreadElement must NOT be flagged
export const spreadCall = pipe(...args)

// Resultar single-arg pipe in tricky parent AST contexts MUST parenthesize safely
export const bin = pipe(a + b) * 2
export const unary = !pipe(a || b)
export const cond = pipe(flag ? a : b).toString()
export const callCallee = pipe(flag ? fn1 : fn2)(1)
export const tagged = pipe(flag ? tag1 : tag2)` + "`hi`" + `
export const arrowObj = () => pipe({ a: 1 })
export const numMember = pipe(1).toString()
`
	dir := t.TempDir()
	files := map[string]string{
		"package.json":                       `{"type":"module"}`,
		"node_modules/resultar/package.json": `{"name":"resultar","type":"module","types":"index.d.ts"}`,
		"node_modules/resultar/index.d.ts":   `export declare function pipe<A>(value: A): A`,
		"tsconfig.json": `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
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
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	var pipeFindings []Finding
	for _, f := range findings {
		if f.Rule == "unnecessary-pipe" {
			pipeFindings = append(pipeFindings, f)
		}
	}
	if len(pipeFindings) != 7 {
		t.Fatalf("expected 7 unnecessary-pipe findings, got %d: %#v", len(pipeFindings), pipeFindings)
	}
	fixed := applyAllCorrectionFixes(source, pipeFindings)
	for _, want := range []string{
		`return pipe(10)`,
		`pipe(...args)`,
		`export const bin = (a + b) * 2`,
		`export const unary = !(a || b)`,
		`export const cond = (flag ? a : b).toString()`,
		`export const callCallee = (flag ? fn1 : fn2)(1)`,
		"export const tagged = (flag ? tag1 : tag2)`hi`",
		`export const arrowObj = () => ({ a: 1 })`,
		`export const numMember = (1).toString()`,
	} {
		if !strings.Contains(fixed, want) {
			t.Fatalf("expected %q in fixed output:\n%s", want, fixed)
		}
	}
	path := filepath.Join(dir, "src", "fixture.ts")
	next, nextDiags, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: fixed})
	if err != nil || len(nextDiags) > 0 {
		t.Fatalf("reopen: %v %v\n%s", err, nextDiags, fixed)
	}
	if sem := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(sem) > 0 {
		t.Fatalf("fixed code has semantic diagnostics: %v\n%s", sem, fixed)
	}
}

func TestNamedResultTaskFnSpanOverloadTriggersAllGeneratorRules(t *testing.T) {
	source := `
export interface Result<T, E = never> { readonly value: T; readonly error: E }
export interface ResultTask<A, E = never, R = never> {
  readonly value: A; readonly error: E; readonly requirements: R
  runPromise(): Promise<A>
  [Symbol.iterator](): Generator<ResultTask<never, E, R>, A, unknown>
}
declare class AppError extends Error {
  readonly _tag = 'AppError'
  static taskErr(msg: string): ResultTask<never, AppError>
}
declare const ResultTask: {
  ok<A>(value: A): ResultTask<A>
  err<E>(error: E): ResultTask<never, E>
  acquireDisposable<A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R>
  fn<Y, A>(spanName: string, body: () => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): () => ResultTask<A>
}
declare const task: ResultTask<number, string>
declare const res: Result<number, string>

export const namedBad1 = ResultTask.fn("orders.create", function* () {
  yield task
  yield* ResultTask.err(new AppError("x"))
  void task.runPromise()
  return ResultTask.ok(1)
})
export const namedUnscoped = ResultTask.fn("orders.acquire", function* () {
  return yield* ResultTask.acquireDisposable(task)
})
export const namedAwait = ResultTask.fn("orders.await", async function* () {
  const a = await res
  const b = await task
  return a + b
})
`
	dir := writeFixture(t, source)
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	opts.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, f := range findings {
		counts[f.Rule]++
	}
	for _, rule := range []string{
		"yield-star-in-result-task-gen",
		"require-return-yield-star",
		"no-unnecessary-err-wrap-in-gen",
		"no-run-inside-gen",
		"no-result-in-task-gen",
		"no-unscoped-acquire-release",
		"no-await-in-result-task-gen",
		"no-await-result-task",
	} {
		if counts[rule] < 1 {
			t.Fatalf("expected named ResultTask.fn to trigger %s, counts=%v findings=%#v", rule, counts, findings)
		}
	}
}

func TestRFC0010APIsNoDiscardAndNoRunInsideGen(t *testing.T) {
	source := `
export interface Result<A, E = never> { readonly value: A; readonly error: E }
export interface Exit<A, E> { readonly _tag: 'Success' | 'Failure'; readonly value?: A; readonly error?: E }
export interface TaskClock { now(): number }
export interface TaskTracer { startSpan(): void }
export interface TaskScheduler { schedule(): void }
export declare class VirtualClock implements TaskClock {
  now(): number
  runToCompletion<A, E>(task: ResultTask<A, E>): Promise<Exit<A, E>>
}
export interface ResultTask<A, E = never, R = never> {
  readonly value: A; readonly error: E; readonly requirements: R
  repeat(opts: { times: number }): ResultTask<A, E, R>
  withSpan(name: string): ResultTask<A, E, R>
  provideClock(clock: TaskClock): ResultTask<A, E, R>
  provideTracer(tracer: TaskTracer): ResultTask<A, E, R>
  provideScheduler(scheduler: TaskScheduler): ResultTask<A, E, R>
  runSync(): Result<A, E>
  runSyncExit(): Exit<A, E>
  [Symbol.iterator](): Generator<ResultTask<never, E, R>, A, unknown>
}
declare const ResultTask: {
  ok<A>(value: A): ResultTask<A>
  gen<Y, A>(body: () => Generator<Y, A, unknown>): ResultTask<A>
  repeat<A, E, R>(task: ResultTask<A, E, R>, opts: { times: number }): ResultTask<A, E, R>
  repeat(opts: { times: number }): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  withSpan<A, E, R>(task: ResultTask<A, E, R>, name: string): ResultTask<A, E, R>
  withSpan(name: string): <A, E, R>(task: ResultTask<A, E, R>) => ResultTask<A, E, R>
  raceFirstAll<A, E, R>(tasks: readonly ResultTask<A, E, R>[]): ResultTask<A, E, R>
  provideClock<A, E, R>(task: ResultTask<A, E, R>, clock: TaskClock): ResultTask<A, E, R>
  provideTracer<A, E, R>(task: ResultTask<A, E, R>, tracer: TaskTracer): ResultTask<A, E, R>
  provideScheduler<A, E, R>(task: ResultTask<A, E, R>, scheduler: TaskScheduler): ResultTask<A, E, R>
  runSync<A, E>(task: ResultTask<A, E>): Result<A, E>
  runSyncExit<A, E>(task: ResultTask<A, E>): Exit<A, E>
}
declare function pipe<A, B>(a: A, ab: (a: A) => B): B
declare const clock: VirtualClock
declare const tracer: TaskTracer
declare const scheduler: TaskScheduler

export async function consumeAllRFC0010() {
  const t1 = ResultTask.ok(1)
  const r1 = t1.runSync()
  const t2 = ResultTask.ok(2)
  t2.runSyncExit()
  const t3 = ResultTask.ok(3)
  const r3 = ResultTask.runSync(t3)
  const t4 = ResultTask.ok(4)
  ResultTask.runSyncExit(t4)
  const t5 = ResultTask.ok(5)
  const rep = ResultTask.repeat(t5, { times: 2 })
  const t6 = ResultTask.ok(6)
  const span = ResultTask.withSpan(t6, "op")
  const t7 = ResultTask.ok(7)
  const t8 = ResultTask.ok(8)
  const raced = ResultTask.raceFirstAll([t7, t8])
  const t9 = ResultTask.ok(9)
  const pClock = ResultTask.provideClock(t9, clock)
  const t10 = ResultTask.ok(10)
  const pTracer = ResultTask.provideTracer(t10, tracer)
  const t11 = ResultTask.ok(11)
  const pSched = ResultTask.provideScheduler(t11, scheduler)
  const t12 = ResultTask.ok(12)
  const piped = pipe(t12, ResultTask.withSpan("piped"))
  const t13 = ResultTask.ok(13)
  await clock.runToCompletion(t13)
  return { r1, r3, rep, span, raced, pClock, pTracer, pSched, piped }
}

export const badRunInsideGen = () => ResultTask.gen(function* () {
  const t = ResultTask.ok(1)
  const a = t.runSync()
  const b = t.runSyncExit()
  const c = ResultTask.runSync(t)
  const d = ResultTask.runSyncExit(t)
  return { a, b, c, d }
})
`
	dir := writeFixture(t, source)
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityWarning
	opts.NoDiscardMode = "must-use"
	opts.NoRunInsideGen = config.SeverityWarning
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	noDiscard := 0
	noRun := 0
	for _, f := range findings {
		if f.Rule == "no-discard" {
			noDiscard++
		}
		if f.Rule == "no-run-inside-gen" {
			noRun++
		}
	}
	if noDiscard != 0 {
		t.Fatalf("expected 0 no-discard false positives on RFC 0010 APIs, got %d: %#v", noDiscard, findings)
	}
	if noRun != 4 {
		t.Fatalf("expected 4 no-run-inside-gen findings (instance & static runSync/runSyncExit), got %d: %#v", noRun, findings)
	}
}

func TestNoAwaitResultTaskAmbiguousTagAndCommentPreservation(t *testing.T) {
	ambiguousSource := `import type { ResultTask } from "resultar"

declare const taggedTask: ResultTask<{ readonly _tag: "User"; readonly id: string }, Error>
declare const customOkTask: ResultTask<{ isOk(): boolean }, Error>

export async function directTag() {
  return (await taggedTask)._tag
}
export async function aliasTag() {
  const res = await taggedTask
  return res._tag
}
export async function destructureTag() {
  const { _tag } = await taggedTask
  return _tag
}
export async function customIsOk() {
  return (await customOkTask).isOk()
}
`
	dir := writeV5Fixture(t, ambiguousSource)
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	opts.NoPromiseResultar = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	var ambiguousFindings []Finding
	for _, f := range findings {
		if f.Rule == "no-await-result-task" {
			ambiguousFindings = append(ambiguousFindings, f)
		}
	}
	if len(ambiguousFindings) != 4 {
		t.Fatalf("expected 4 ambiguous no-await-result-task findings, got %d: %#v", len(ambiguousFindings), ambiguousFindings)
	}
	for i, f := range ambiguousFindings {
		if len(f.Fixes) != 0 {
			t.Fatalf("finding %d (line %d) must not have fix for ambiguous success member: %#v", i, f.Line, f)
		}
	}

	commentSource := `import type { ResultTask } from "resultar"

declare const plainTask: ResultTask<string, Error>

export async function keepInlineComment() {
  const later = await /* keep inline */ plainTask
  return await later.runPromise()
}
export async function keepLineComment() {
  const later = await // keep line
    plainTask
  return await later.runPromise()
}
export async function keepReturnLineComment(): Promise<ResultTask<string, Error>> {
  return await // keep return line
    plainTask
}
`
	cdir := writeV5Fixture(t, commentSource)
	copened, cdiags, err := project.Open(filepath.Join(cdir, "tsconfig.json"))
	if err != nil || len(cdiags) > 0 {
		t.Fatalf("open: %v %v", err, cdiags)
	}
	cfindings, err := Run(context.Background(), copened.Program, copened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	var commentFindings []Finding
	for _, f := range cfindings {
		if f.Rule == "no-await-result-task" {
			commentFindings = append(commentFindings, f)
		}
	}
	if len(commentFindings) != 3 {
		t.Fatalf("expected 3 comment no-await-result-task findings, got %d: %#v", len(commentFindings), commentFindings)
	}
	for i, f := range commentFindings {
		if len(f.Fixes) != 1 {
			t.Fatalf("finding %d (line %d) expected removeAwaitFix, got %#v", i, f.Line, f)
		}
	}
	fixed := applyAllCorrectionFixes(commentSource, commentFindings)
	for _, comment := range []string{"/* keep inline */", "// keep line", "// keep return line"} {
		if !strings.Contains(fixed, comment) {
			t.Fatalf("expected comment %q preserved:\n%s", comment, fixed)
		}
	}
	cpath := filepath.Join(cdir, "src", "fixture.ts")
	next, nextDiags, err := project.OpenWithOverlay(copened.ConfigPath, map[string]string{cpath: fixed})
	if err != nil || len(nextDiags) > 0 {
		t.Fatalf("reopen: %v %v\n%s", err, nextDiags, fixed)
	}
	if syn := next.Program.GetSyntacticDiagnostics(context.Background(), nil); len(syn) > 0 {
		t.Fatalf("fixed code has syntactic diagnostics: %v\n%s", syn, fixed)
	}
	if sem := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(sem) > 0 {
		t.Fatalf("fixed code has semantic diagnostics: %v\n%s", sem, fixed)
	}
}

func TestGeneratorAutofixesBareYieldAndPrecedenceParens(t *testing.T) {
	source := `
export interface Result<T, E = never> {
  readonly value: T
  readonly error: E
  [Symbol.iterator](): Generator<Result<never, E>, T, unknown>
}
export interface ResultTask<A, E = never, R = never> {
  readonly value: A
  readonly error: E
  readonly requirements: R
  [Symbol.iterator](): Generator<ResultTask<never, E, R>, A, unknown>
}
declare const Result: {
  gen<Y, A>(body: () => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): Result<A>
}
declare const ResultTask: {
  gen<Y, A>(body: () => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): ResultTask<A>
}
declare const boolRes: Result<boolean, string>
declare const numRes: Result<number, string>

export const bareYield = ResultTask.gen(function* () {
  yield
  return 1
})

export const safeTryPrecedence = Result.gen(async function* () {
  const a = !await boolRes
  const b = await boolRes ? 1 : 2
  const c = 1 + await numRes
  const d = await numRes
  return a ? b + c + d : 0
})

export const taskGenPrecedence = ResultTask.gen(async function* () {
  const a = !await boolRes
  const b = await boolRes ? 1 : 2
  const c = 1 + await numRes
  return a ? b + c : 0
})
`
	dir := writeFixture(t, source)
	path := filepath.Join(dir, "fixture.ts")
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	opts := config.Defaults()
	opts.NoDiscard = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, opts)
	if err != nil {
		t.Fatal(err)
	}
	var bareYieldFinding *Finding
	var awaitFixes []Finding
	for i := range findings {
		f := findings[i]
		if f.Rule == "yield-star-in-result-task-gen" {
			bareYieldFinding = &findings[i]
		}
		if f.Rule == "no-await-in-safe-try" || f.Rule == "no-await-in-result-task-gen" {
			awaitFixes = append(awaitFixes, f)
		}
	}
	if bareYieldFinding == nil {
		t.Fatalf("expected yield-star-in-result-task-gen for bare yield, got %#v", findings)
	}
	if len(bareYieldFinding.Fixes) != 0 {
		t.Fatalf("bare yield must NOT attach yield* fix: %#v", bareYieldFinding.Fixes)
	}
	if len(awaitFixes) != 7 {
		t.Fatalf("expected 7 await findings across safeTry & ResultTask.gen, got %d: %#v", len(awaitFixes), awaitFixes)
	}

	fixed := applyAllCorrectionFixes(source, awaitFixes)
	for _, want := range []string{
		`const a = !(yield* boolRes)`,
		`const b = (yield* boolRes) ? 1 : 2`,
		`const c = 1 + (yield* numRes)`,
		`const d = yield* numRes`,
	} {
		if !strings.Contains(fixed, want) {
			t.Fatalf("expected %q in fixed output:\n%s", want, fixed)
		}
	}
	next, nextDiags, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: fixed})
	if err != nil || len(nextDiags) > 0 {
		t.Fatalf("reopen: %v %v\n%s", err, nextDiags, fixed)
	}
	if syn := next.Program.GetSyntacticDiagnostics(context.Background(), nil); len(syn) > 0 {
		t.Fatalf("fixed generator code has syntactic diagnostics: %v\n%s", syn, fixed)
	}
}

func TestConvertToFnRefactorSafetyGuards(t *testing.T) {
	source := stage1And2Fixture + `
declare const task: ResultTask<number, string>

// 1. Explicit return type annotation -> skip refactor (would drop return type)
export const annotated = (a: number): ResultTask<number, string> => ResultTask.gen(function* () {
  return (yield* task) + a
})

// 2. Recursive named FunctionExpression -> skip refactor (would drop binding name)
export const recursive = function step(n: number) {
  return ResultTask.gen(function* () {
    if (n <= 0) return 0
    return (yield* step(n - 1)) + 1
  })
}

// 3. Async inner generator inside ResultTask.gen -> skip refactor (never emit async function* for ResultTask.fn)
export const asyncTaskGen = (a: number) => ResultTask.gen(async function* () {
  return a + 1
})

// 4. Clean unannotated non-recursive sync generator -> SHOULD offer Convert to ResultTask.fn
export const cleanTask = (a: number) => ResultTask.gen(function* () {
  return (yield* task) + a
})
`
	dir := writeFixture(t, source)
	path := filepath.Join(dir, "fixture.ts")
	opened, diags, err := project.Open(filepath.Join(dir, "tsconfig.json"))
	if err != nil || len(diags) > 0 {
		t.Fatalf("open: %v %v", err, diags)
	}
	refactors, err := Refactors(context.Background(), opened.Program, path)
	if err != nil {
		t.Fatal(err)
	}
	fnRefactors := 0
	for _, fix := range refactors {
		if fix.Title == "Convert to ResultTask.fn" {
			fnRefactors++
			if strings.Contains(fix.Edits[0].NewText, "async function*") {
				t.Fatalf("must never emit async function* for ResultTask.fn: %#v", fix)
			}
			edited := applySingleFix(source, fix)
			if !strings.Contains(edited, "export const cleanTask = ResultTask.fn(") {
				t.Fatalf("unexpected refactor target:\n%s", edited)
			}
		}
	}
	if fnRefactors != 1 {
		t.Fatalf("expected exactly 1 safe Convert to ResultTask.fn refactor, got %d: %#v", fnRefactors, refactors)
	}
}

func TestTextEditsConflictZeroLengthInsertions(t *testing.T) {
	if !textEditsConflict(TextEdit{Start: 10, Length: 0, NewText: "a"}, TextEdit{Start: 10, Length: 0, NewText: "b"}) {
		t.Fatal("two zero-length insertions at identical Start must conflict")
	}
	if textEditsConflict(TextEdit{Start: 10, Length: 0, NewText: "a"}, TextEdit{Start: 11, Length: 0, NewText: "b"}) {
		t.Fatal("zero-length insertions at distinct offsets must not conflict")
	}
	if !textEditsConflict(TextEdit{Start: 10, Length: 0, NewText: "a"}, TextEdit{Start: 10, Length: 4, NewText: "b"}) {
		t.Fatal("zero-length insertion at start of replacement range must conflict")
	}
	if textEditsConflict(TextEdit{Start: 14, Length: 0, NewText: "a"}, TextEdit{Start: 10, Length: 4, NewText: "b"}) {
		t.Fatal("zero-length insertion right after replacement range must not conflict")
	}
}

func TestSameFilePathWindowsCaseInsensitivity(t *testing.T) {
	if !sameFilePathForOS(`C:\Repo\Src\App.ts`, `c:\repo\src\app.ts`, "windows") {
		t.Fatal("expected case-insensitive path match on windows")
	}
	if sameFilePathForOS(`/Repo/Src/App.ts`, `/repo/src/app.ts`, "linux") {
		t.Fatal("expected case-sensitive path match on linux")
	}
}
