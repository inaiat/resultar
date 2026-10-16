package analyzer

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/config"
	"github.com/microsoft/TypeScript/tsc/resultar-check/internal/project"
)

const stage1And2Fixture = `
export interface Result<A, E = never> {
  readonly value: A
  readonly error: E
  map<B>(fn: (value: A) => B): Result<B, E>
  andThen<B, E2>(fn: (value: A) => Result<B, E2>): Result<B, E | E2>
  flatMap<B, E2>(fn: (value: A) => Result<B, E2>): Result<B, E | E2>
  asyncAndThen<B, E2>(fn: (value: A) => ResultTask<B, E2, never>): ResultTask<B, E | E2, never>
  mapErr<E2>(fn: (error: E) => E2): Result<A, E2>
  mapError<E2>(fn: (error: E) => E2): Result<A, E2>
  orElse<B, E2>(fn: (error: E) => Result<B, E2>): Result<A | B, E2>
  catchAll<B, E2>(fn: (error: E) => Result<B, E2>): Result<A | B, E2>
  orElseSucceed<B>(fn: () => B): Result<A | B, never>
  tap(fn: (value: A) => void): Result<A, E>
  tapError(fn: (error: E) => void): Result<A, E>
  asVoid(): Result<void, E>
  filterOrElse<E2>(predicate: (value: A) => boolean, onFalse: (value: A) => E2): Result<A, E | E2>
  unwrapOr<B>(fallback: B): A | B
  unwrapOrThrow(): A
  _unsafeUnwrap(): A
  pipe(): Result<A, E>
  pipe<B>(ab: (a: Result<A, E>) => B): B
  [Symbol.iterator](): Generator<ErrResult<E>, A, unknown>
}
export interface ErrResult<E> extends Result<never, E> {}
export declare class ResultTask<A, E = never, R = never> implements PromiseLike<Result<A, E>> {
  readonly value: A
  readonly error: E
  readonly requirements: R
  then<TResult1 = Result<A, E>, TResult2 = never>(
    onfulfilled?: ((value: Result<A, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>
  map<B>(fn: (value: A) => B): ResultTask<B, E, R>
  andThen<B, E2, R2>(fn: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2>
  flatMap<B, E2, R2>(fn: (value: A) => ResultTask<B, E2, R2>): ResultTask<B, E | E2, R | R2>
  mapErr<E2>(fn: (error: E) => E2): ResultTask<A, E2, R>
  mapError<E2>(fn: (error: E) => E2): ResultTask<A, E2, R>
  orElse<B, E2, R2>(fn: (error: E) => ResultTask<B, E2, R2>): ResultTask<A | B, E2, R | R2>
  catchAll<B, E2, R2>(fn: (error: E) => ResultTask<B, E2, R2>): ResultTask<A | B, E2, R | R2>
  orElseSucceed<B>(fn: () => B): ResultTask<A | B, never, R>
  tap(fn: (value: A) => void): ResultTask<A, E, R>
  tapError(fn: (error: E) => void): ResultTask<A, E, R>
  asVoid(): ResultTask<void, E, R>
  filterOrElse<E2>(predicate: (value: A) => boolean, onFalse: (value: A) => E2): ResultTask<A, E | E2, R>
  unwrapOr<B>(fallback: B): ResultTask<A | B, never, R>
  pipe(): ResultTask<A, E, R>
  pipe<B>(ab: (a: ResultTask<A, E, R>) => B): B
  static ok<A>(value: A): ResultTask<A>
  static succeed<A>(value: A): ResultTask<A>
  static err<E>(error: E): ResultTask<never, E>
  static fail<E>(error: E): ResultTask<never, E>
  static die(defect: unknown): ResultTask<never, never>
  static fromResult<A, E>(result: Result<A, E>): ResultTask<A, E>
  static gen<Y, A>(body: () => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): ResultTask<A>
  static fn<Args extends readonly unknown[], Y, A>(body: (...args: Args) => Generator<Y, A, unknown> | AsyncGenerator<Y, A, unknown>): (...args: Args) => ResultTask<A>
  static scoped<A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R>
  static acquireRelease<A, E, R>(acquire: ResultTask<A, E, R>, release: (resource: A) => void): ResultTask<A, E, R>
  static acquireDisposable<A, E, R>(acquire: ResultTask<A, E, R>): ResultTask<A, E, R>
  static firstSuccessOf<A, E, R>(tasks: Iterable<ResultTask<A, E, R>>): ResultTask<A, E, R>
  static all<A, E, R>(tasks: Iterable<ResultTask<A, E, R>>): ResultTask<A[], E, R>
  static combine<A, E, R>(tasks: Iterable<ResultTask<A, E, R>>): ResultTask<A[], E, R>
  static forEach<T, A, E, R>(items: Iterable<T>, fn: (item: T) => ResultTask<A, E, R>): ResultTask<A[], E, R>
  static if<A, E, R>(cond: boolean, onTrue: ResultTask<A, E, R>, onFalse: ResultTask<A, E, R>): ResultTask<A, E, R>
  static raceWith<A, E, R>(left: ResultTask<A, E, R>, right: ResultTask<A, E, R>, opts: object): ResultTask<A, E, R>
  static withResource<A, E, R>(resource: ResultTask<A, E, R>, use: (a: A) => ResultTask<A, E, R>): ResultTask<A, E, R>
  static runPromise<A, E>(task: ResultTask<A, E, never>): Promise<Result<A, E>>
  static makeSemaphore(permits: number): Semaphore
  [Symbol.iterator](): Generator<ErrResult<E>, A, unknown>
}
export type ResultAsync<A, E = never> = ResultTask<A, E, never>
export interface Semaphore {
  withPermit<A, E, R>(task: ResultTask<A, E, R>): ResultTask<A, E, R>
  withPermits<A, E, R>(permits: number, task: ResultTask<A, E, R>): ResultTask<A, E, R>
}
export interface Fiber<A, E> {
  join(): ResultTask<A, E, never>
  await(): ResultTask<Result<A, E>, never, never>
  interrupt(): ResultTask<void, never, never>
}
export declare function ok<A>(value: A): Result<A, never>
export declare function err<E>(error: E): Result<never, E>
export declare function pipe<A>(a: A): A
export declare function pipe<A, B>(a: A, ab: (a: A) => B): B
export declare function runPromise<A, E>(task: ResultTask<A, E, never>): Promise<Result<A, E>>
export declare function runSync<A, E>(result: Result<A, E>): A
export declare const Result: {
  ok: typeof ok
  err: typeof err
  gen<Y, A>(body: () => Generator<Y, A, unknown>): Result<A, string>
  fn<Args extends readonly unknown[], Y, A>(body: (...args: Args) => Generator<Y, A, unknown>): (...args: Args) => Result<A, string>
  firstSuccessOf<A, E>(results: Iterable<Result<A, E>>): Result<A, E>
  combine<A, E>(results: Iterable<Result<A, E>>): Result<A[], E>
  forEach<T, A, E>(items: Iterable<T>, fn: (item: T) => Result<A, E>): Result<A[], E>
}
export declare class AppError extends Error {
  readonly _tag = 'AppError'
  static err(): Result<never, AppError>
  static taskErr(): ResultTask<never, AppError>
}
`

func TestStage1BranchFeaturesCoverage(t *testing.T) {
	source := stage1And2Fixture + `
declare const asyncVal: ResultAsync<number, string>
declare const taskVal: ResultTask<number, string, { readonly service: true }>
declare const fiber: Fiber<number, string>
declare const items: number[]

// 1. ResultAsync<T, E> is ResultTask<T, E, never>; chained methods return ResultTask<..., never>
export async function awaitChainedResultAsync(): Promise<Result<number, string>> {
  const chained = asyncVal.map((x) => x + 1)
  return await chained
}

// 2. Semaphore & Fiber & new ResultTask static consumers mark tracked tasks as handled
export function handledContainers() {
  const sem = ResultTask.makeSemaphore(2)
  const t1 = ResultTask.ok(1)
  const t2 = ResultTask.ok(2)
  const t3 = ResultTask.ok(3)
  const t4 = ResultTask.ok(4)
  const t5 = ResultTask.ok(5)
  const t6 = ResultTask.ok(6)
  const p1 = sem.withPermit(t1)
  const p2 = sem.withPermits(2, t2)
  const branch = ResultTask.if(true, t3, t4)
  const raced = ResultTask.raceWith(p1, p2, {})
  const piped = pipe(t5, (x) => x.map((n) => n + 1))
  const resourced = ResultTask.withResource(t6, () => ResultTask.ok(1))
  const joined = fiber.join()
  return ResultTask.all([branch, raced, piped, resourced, joined])
}

// 3. ResultTask.firstSuccessOf and ResultTask.forEach
export const taskFallback = () => taskVal.orElse(() => taskVal).orElse(() => taskVal)
export const taskMappedAll = () => ResultTask.all(items.map((x) => ResultTask.ok(x)))
export const taskMappedCombine = () => ResultTask.combine(items.map((x) => ResultTask.ok(x)))

// 4. Static constructor calls in prefer-map and prefer-map-err
export const staticMap = () => taskVal.andThen((x) => ResultTask.succeed(x + 1))
export const staticMapErr = () => taskVal.orElse((e) => ResultTask.fail(e))
export const taggedMapErr = () => taskVal.orElse(() => AppError.taskErr())

// 5. Result.gen and Result.fn enforce plain value returns
export const badResultGen = () => Result.gen(function* () {
  return Result.ok(1)
})
export const badResultFn = Result.fn(function* (x: number) {
  return ok(x)
})
`
	directory := writeFixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	options := config.Defaults()
	options.NoUnsafeAwait = config.SeverityWarning
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, f := range findings {
		counts[f.Rule]++
	}
	if counts["no-discard"] != 0 {
		t.Fatalf("expected 0 no-discard findings, got: %#v", findings)
	}
	if counts["no-unsafe-await"] != 0 {
		t.Fatalf("expected 0 no-unsafe-await findings on chained ResultAsync, got: %#v", findings)
	}
	if counts["prefer-first-success-of"] != 1 {
		t.Fatalf("expected 1 prefer-first-success-of on ResultTask, got %d: %#v", counts["prefer-first-success-of"], findings)
	}
	if counts["prefer-result-for-each"] != 2 {
		t.Fatalf("expected 2 prefer-result-for-each on ResultTask.all/combine, got %d: %#v", counts["prefer-result-for-each"], findings)
	}
	if counts["prefer-map"] != 1 {
		t.Fatalf("expected 1 prefer-map on ResultTask.succeed, got %d: %#v", counts["prefer-map"], findings)
	}
	if counts["prefer-map-err"] != 2 {
		t.Fatalf("expected 2 prefer-map-err on ResultTask.fail and AppError.taskErr, got %d: %#v", counts["prefer-map-err"], findings)
	}
	if counts["no-result-in-task-gen"] != 2 {
		t.Fatalf("expected 2 no-result-in-task-gen on Result.gen and Result.fn, got %d: %#v", counts["no-result-in-task-gen"], findings)
	}
}

func TestStage2NewRulesAndFixes(t *testing.T) {
	source := stage1And2Fixture + `
declare const res: Result<number, string>
declare const task: ResultTask<number, string>
declare const disposableTask: ResultTask<{ [Symbol.dispose](): void }, string>
declare function sideEffect(x: unknown): void

// 1. prefer-or-else-succeed
export const orElseSucc = res.orElse(() => ok(0))
export const catchAllSucc = task.catchAll(() => ResultTask.succeed(42))

// 2. prefer-tap
export const tapMap = res.map((x) => {
  sideEffect(x)
  return x
})
export const tapAndThen = task.andThen((x) => {
  sideEffect(x)
  return ResultTask.succeed(x)
})

// 3. prefer-tap-error
export const tapErrMap = res.mapErr((e) => {
  sideEffect(e)
  return e
})
export const tapErrOrElse = task.orElse((e) => {
  sideEffect(e)
  return ResultTask.fail(e)
})

// 4. prefer-as-void
export const asVoidUndef = res.map(() => undefined)
export const asVoidExpr = task.map((x) => void sideEffect(x))

// 5. prefer-filter-or-else
export const filterTernary = res.andThen((x) => (x > 0 ? ok(x) : err('neg')))
export const filterIf = task.flatMap((x) => {
  if (x <= 0) {
    return ResultTask.fail('neg')
  }
  return ResultTask.succeed(x)
})

// 6. prefer-acquire-disposable
export const acqDisp = ResultTask.scoped(
  ResultTask.acquireRelease(disposableTask, (r) => r[Symbol.dispose]())
)

// 7. no-fn-iife
export const fnIife = ResultTask.fn(function* () {
  return yield* task
})()

// 8. require-return-yield-star
export const termYield = ResultTask.gen(function* () {
  if (Math.random() > 0.5) {
    yield* ResultTask.fail('boom')
  }
  return yield* task
})

// 9. no-unnecessary-err-wrap-in-gen
export const errWrapGen = ResultTask.gen(function* () {
  const v = yield* ResultTask.fromResult(res)
  if (v < 0) {
    return yield* ResultTask.fail(new AppError('bad'))
  }
  return v
})

// 10. unnecessary-pipe
export const singlePipe = pipe(res)
export const emptyMethodPipe = task.pipe()

// 11. no-run-inside-gen
export const runInsideGen = ResultTask.gen(function* () {
  const a = runSync(res)
  const b = res._unsafeUnwrap()
  void ResultTask.runPromise(task)
  return a + b
})
`
	directory := writeFixture(t, source)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, f := range findings {
		counts[f.Rule]++
	}
	expected := map[string]int{
		"prefer-or-else-succeed":         2,
		"prefer-tap":                     2,
		"prefer-tap-error":               2,
		"prefer-as-void":                 2,
		"prefer-filter-or-else":          2,
		"prefer-acquire-disposable":      1,
		"no-fn-iife":                     1,
		"require-return-yield-star":      1,
		"no-unnecessary-err-wrap-in-gen": 2,
		"unnecessary-pipe":               2,
		"no-run-inside-gen":              3,
	}
	for rule, want := range expected {
		if counts[rule] != want {
			t.Fatalf("rule %s: got %d, want %d (all findings: %#v)", rule, counts[rule], want, findings)
		}
	}
}

func TestStage2SafeRefactorsFnAndPipe(t *testing.T) {
	source := stage1And2Fixture + `
declare const task: ResultTask<number, string>
export const toTaskFn = (a: number, b: string) => ResultTask.gen(function* () {
  const x = yield* task
  return x + a + b.length
})
export const toResultFn = (a: number) => {
  return Result.gen(function* () {
    return a + 1
  })
}
export const fromPipeFn = pipe(task, (x) => x.map((n) => n + 1))
export const fromMethodPipe = task.pipe((x) => x.map((n) => n + 1))
`
	directory := writeFixture(t, source)
	path := filepath.Join(directory, "fixture.ts")
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil || len(diagnostics) > 0 {
		t.Fatalf("open: %v %v", err, diagnostics)
	}
	refactors, err := Refactors(context.Background(), opened.Program, path)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, fix := range refactors {
		counts[fix.Title]++
	}
	if counts["Convert to ResultTask.fn"] != 1 ||
		counts["Convert to Result.fn"] != 1 ||
		counts["Convert to method .pipe()"] != 1 ||
		counts["Convert to pipe(...)"] != 1 {
		t.Fatalf("unexpected refactors: %#v", refactors)
	}
	for _, fix := range refactors {
		edited := source
		for i := len(fix.Edits) - 1; i >= 0; i-- {
			edit := fix.Edits[i]
			edited = edited[:edit.Start] + edit.NewText + edited[edit.Start+edit.Length:]
		}
		next, diags, err := project.OpenWithOverlay(opened.ConfigPath, map[string]string{path: edited})
		if err != nil || len(diags) > 0 {
			t.Fatalf("preview project for %s: %v %v", fix.Title, err, diags)
		}
		if semDiags := next.Program.GetSemanticDiagnostics(context.Background(), nil); len(semDiags) > 0 {
			t.Fatalf("invalid refactor %s:\nedited:\n%s\ndiagnostics: %v", fix.Title, edited, semDiags)
		}
		if strings.Contains(fix.Title, "Convert to ") && !strings.Contains(edited, fix.Edits[0].NewText) {
			t.Fatalf("missing edited text for %s", fix.Title)
		}
	}
}
