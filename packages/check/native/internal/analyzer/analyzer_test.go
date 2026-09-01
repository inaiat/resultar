package analyzer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/microsoft/typescript-go/resultar-check/internal/config"
	"github.com/microsoft/typescript-go/resultar-check/internal/project"
)

const pilotFixture = `
type Result<T, E> = {
  readonly value?: T
  readonly error?: E
  map<X>(fn: (value: T) => X): Result<X, E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function save(): Result<string, Error>
declare function asyncSave(value: number): Promise<void>

save()
const unhandled = save()
ok(1).map(asyncSave)
declare const unsafe: Result<string, unknown>
void unsafe
`

func TestPilotRuleParity(t *testing.T) {
	directory := writeFixture(t, pilotFixture)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	findings, err := Run(context.Background(), opened.Program, opened.Directory, config.Defaults())
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-discard", 11},
		{"no-discard", 12},
		{"no-discard", 13},
		{"no-promise-in-result-success", 13},
		{"no-unknown-result-error", 14},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	if len(findings[0].Fixes) != 1 || findings[0].Fixes[0].Edits[0].NewText != "void " {
		t.Fatalf("no-discard direct finding should offer an explicit void fix: %#v", findings[0].Fixes)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
}

func TestNoDiscardModesAndConsumers(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  readonly value?: T
  readonly error?: E
  match<A, B>(ok: (value: T) => A, error: (error: E) => B): A | B
}
declare function save(): Result<string, Error>
declare function external(value: unknown): void

const unhandled = save()
external(unhandled)
const handled = save()
handled.match(value => value, error => error.message)
const returned = save()
const passThrough = (): Result<string, Error> => ({ ...returned })
const discarded = save()
void discarded
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	mustUse, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(mustUse) != 1 || mustUse[0].Line != 10 {
		t.Fatalf("must-use findings = %#v", mustUse)
	}

	options.NoDiscardMode = "direct"
	direct, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(direct) != 0 {
		t.Fatalf("direct findings = %#v", direct)
	}
}

func TestLineSuppressions(t *testing.T) {
	directory := writeFixture(t, `
// resultar-check-disable-next-line no-throw
throw new Error("allowed here")
throw new Error("reported") // resultar-check-disable-line no-throw
throw new Error("reported too")
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}
	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	options.NoThrow = config.SeverityError
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Line != 5 {
		t.Fatalf("unexpected suppressed findings: %#v", findings)
	}
}

func TestCompositionRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  map<X>(fn: (value: T) => X): Result<X, E>
  andThen<X, F>(fn: (value: T) => Result<X, F>): Result<X, E | F>
  orElse<F>(fn: (error: E) => Result<T, F>): Result<T, F>
}
type ResultAsync<T, E> = {
  map<X>(fn: (value: T) => X): ResultAsync<X, E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function err<E, T = never>(error: E): Result<T, E>
declare function source(): Result<number, string>
declare function fallback(): Result<number, string>
declare function asyncFallback(): ResultAsync<number, string>
declare function fromThrowable<T>(fn: () => T, catchMapper?: (error: unknown) => Error): Result<T, Error>
declare function tryResult<T, E = unknown>(fn: () => T, catchMapper?: (error: unknown) => E): Result<T, E>

void source().orElse(() => err("mapped"))
void source().map(() => fallback())
void source().map(() => asyncFallback())
void source().andThen((value) => ok(value + 1))
void source().orElse(() => fallback()).orElse(() => fallback())
void fromThrowable(() => 1)
void tryResult<number, Error>(() => 1)
void fromThrowable({ try: () => 1, catch: () => new Error("mapped") })
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule     string
		line     int
		column   int
		severity config.Severity
		message  string
	}{
		{"prefer-map-err", 18, 15, config.SeverityWarning, "`orElse` only replaces the failure with another Err. Use `mapErr` when the Ok value cannot recover."},
		{"prefer-and-then", 19, 15, config.SeverityWarning, "`map` creates a nested Result when its callback returns Result<number, string>. Use `andThen` for fallible composition."},
		{"prefer-and-then", 20, 15, config.SeverityWarning, "`map` creates a nested Result when its callback returns ResultAsync<number, string>. Use `asyncAndThen` for fallible composition."},
		{"prefer-map", 21, 15, config.SeverityWarning, "andThen only wraps the callback value in Ok. Use map for a non-fallible transformation."},
		{"prefer-first-success-of", 22, 40, config.SeverityWarning, "This chain has 2 error-independent orElse fallbacks. Use Result.firstSuccessOf to express the fallback selection."},
		{"typed-catch-mapper", 23, 6, config.SeverityWarning, "`fromThrowable` without a catch mapper leaves the error channel as `unknown`. Map the caught value to a specific Resultar error."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Column != expected.column ||
			finding.Severity != expected.severity || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
	if len(findings[0].Fixes) != 1 || findings[0].Fixes[0].Edits[0].NewText != "mapErr" {
		t.Fatalf("expected mapErr quick fix, got %#v", findings[0].Fixes)
	}
	if len(findings[1].Fixes) != 1 || findings[1].Fixes[0].Edits[0].NewText != "andThen" {
		t.Fatalf("expected andThen quick fix, got %#v", findings[1].Fixes)
	}
}

func TestCompositionRulesAvoidFalsePositives(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  map<X>(fn: (value: T) => X): Result<X, E>
  andThen<X, F>(fn: (value: T) => Result<X, F>): Result<X, E | F>
  orElse<F>(fn: (error: E) => Result<T, F>): Result<T, F>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function source(): Result<number, string>
declare function fallback(): Result<number, string>
declare function tryResult<T, E = unknown>(fn: (() => T) | { try: () => T, catch: (error: unknown) => E }): Result<T, E>

void source().orElse(() => ok(1))
void source().map((value) => value + 1)
void source().andThen(() => fallback())
void source().orElse(() => fallback())
void tryResult<number, TypeError>(() => 1)
void tryResult({ try: () => 1, catch: () => new TypeError("mapped") })
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 0 {
		t.Fatalf("unexpected composition findings: %#v", findings)
	}
}

func TestStructuralRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  catchTag<X, F>(tag: string, fn: (error: E) => Result<X, F>): Result<T | X, F>
}
declare const Result: {
  combine<T, E>(values: readonly Result<T, E>[]): Result<T[], E>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function validate(value: number): Result<string, Error>
declare function safeTry(body: unknown): unknown
declare const values: readonly number[]
declare const source: Result<number, { reason: { _tag: string } }>

void Result.combine(values.map(validate))
void source.catchTag("Nested", (error) => error.reason._tag === "Missing" ? ok(0) : source)
safeTry(function* () {
  yield source
})
try {
  throw new Error("failed")
} catch {}
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoThrow = config.SeverityError
	options.NoTryCatch = config.SeveritySuggestion
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule     string
		line     int
		severity config.Severity
		message  string
	}{
		{"prefer-result-for-each", 14, config.SeverityWarning, "Use Result.forEach instead of Result.combine over an intermediate map result list."},
		{"prefer-catch-reason", 15, config.SeverityWarning, "This catchTag callback inspects a nested reason._tag. Use catchReason or catchReasons for typed nested-error handling."},
		{"yield-star-in-safe-try", 17, config.SeverityWarning, "Use `yield*` when unwrapping Resultar values inside `safeTry`."},
		{"no-try-catch", 19, config.SeveritySuggestion, "Avoid raw try/catch for expected failures. Use tryResult or tryResultAsync to preserve the typed error channel."},
		{"no-throw", 20, config.SeverityError, "Do not throw for expected Resultar failures. Return `Err`/`errAsync` or wrap uncontrolled external code with a Resultar catch boundary."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for _, finding := range findings {
		if finding.Rule == "yield-star-in-safe-try" && (len(finding.Fixes) != 1 || finding.Fixes[0].Edits[0].NewText != "yield*") {
			t.Fatalf("yield-star finding should offer a yield* fix: %#v", finding.Fixes)
		}
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Severity != expected.severity || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestSafeTryAndTaggedErrorRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare function err<T = never, E = unknown>(error: E): Result<T, E>
declare function safeTry(body: unknown): unknown
declare function createTaggedError(
  options: { readonly message?: string; readonly name: string }
): new (...args: readonly unknown[]) => Error

class DomainError extends Error {}
void err(new Error("channel"))
throw new Error("thrown")
class InvalidEmailError extends createTaggedError({
  name: "OtherEmailError",
  message: "Invalid email"
}) {
  constructor() {
    super()
  }
}
safeTry(async function* () {
  await Promise.resolve(1)
  try {
    return 1
  } finally {}
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule    string
		line    int
		message string
	}{
		{"prefer-tagged-error", 9, "Prefer `createTaggedError` for Resultar domain errors so failures keep a stable tag and typed metadata."},
		{"prefer-tagged-error", 10, "Prefer a `createTaggedError` instance over `new Error(...)` in Resultar error channels."},
		{"prefer-tagged-error", 11, "Prefer a `createTaggedError` instance over throwing `new Error(...)` so failures keep a stable tag and typed metadata."},
		{"tagged-error-name-match", 13, "Tagged error name `OtherEmailError` should match class name `InvalidEmailError`."},
		{"no-tagged-error-constructor-override", 16, "Do not override the constructor generated by `createTaggedError`; it owns template props, cause, and serialization behavior."},
		{"no-await-in-safe-try", 21, "Do not use `await` inside `safeTry`. Use `yield*` for Resultar values and wrap raw Promises before yielding them."},
		{"no-try-catch-in-safe-try", 22, "Avoid raw try/catch inside `safeTry`. Use `safeTry({ try, catch })`, `tryResult`, or `tryResultAsync` to keep failures typed."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestErrorChannelSemanticRuleParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = {
  readonly error?: E
  mapErr<F>(fn: (error: E) => F): Result<T, F>
}
class FirstError extends Error { readonly first = true }
class SecondError extends Error { readonly second = true }
declare const infallible: Result<string, never>
declare const fallible: Result<string, Error>
declare const union: Result<string, FirstError | SecondError>

void infallible.mapErr((error) => error)
void fallible.mapErr((error) => error)
const narrowed = union as Result<string, FirstError>
const unchanged = fallible as Result<string, Error>
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule    string
		line    int
		message string
	}{
		{"no-useless-recovery", 12, "`mapErr` cannot run because this Resultar value has `never` in the error channel."},
		{"unsafe-result-type-assertion", 14, "This assertion narrows the Resultar error channel unsafely (`FirstError | SecondError` to `FirstError`). Prefer a real recovery or mapping step."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != expected.rule || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestNoUnsafeAwaitParity(t *testing.T) {
	directory := writeFixture(t, `
type Result<T, E> = { readonly value?: T; readonly error?: E }
declare class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  then<A = Result<T, E>, B = never>(
    ok?: ((value: Result<T, E>) => A | PromiseLike<A>) | null,
    error?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B>
}
declare function ok<T, E = never>(value: T): Result<T, E>
declare function fetch(path: string): Promise<string>
declare function startServer(): Promise<void>
declare function promiseReturningResult(): Promise<Result<string, Error>>
declare function runPromise<T, E>(result: ResultAsync<T, E>): Promise<T>
declare function tryAsync(body: unknown): unknown
declare const resultAsync: ResultAsync<string, Error>

async function raw() {
  await fetch("/raw")
  await resultAsync
  await startServer()
}
async function context(): Promise<Result<string, Error>> {
  const value = await fetch("/context")
  await resultAsync
  await promiseReturningResult()
  await runPromise(resultAsync)
  await 1
  return ok(value)
}
tryAsync(async () => await fetch("/boundary"))
tryAsync(async () => {
  async function nested() {
    await fetch("/nested")
  }
  return nested()
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitIgnoreCalls = []string{"startServer"}
	options.TypedCatchMapper = config.SeverityOff
	contextFindings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(contextFindings) != 1 || contextFindings[0].Rule != "no-unsafe-await" || contextFindings[0].Line != 23 {
		t.Fatalf("resultar-context findings = %#v", contextFindings)
	}

	options.NoUnsafeAwaitMode = "all"
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		line    int
		message string
	}{
		{18, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
		{19, "Do not unwrap a Resultar async value inside a raw Promise boundary. Return ResultAsync or Promise<Result> so failures stay in the Resultar error channel."},
		{23, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
		{33, "Wrap this awaited Promise in tryAsync, tryResultAsync, tryCatchAsync, or fromThrowableAsync so rejections stay in the Resultar error channel."},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		finding := findings[index]
		if finding.Rule != "no-unsafe-await" || finding.Line != expected.line || finding.Message != expected.message {
			t.Errorf("finding %d = %#v, want %#v", index, finding, expected)
		}
	}
}

func TestNoUnsafeAwaitDoesNotTreatUnrelatedTryPromiseAsBoundary(t *testing.T) {
	directory := writeFixture(t, `
interface Client {
  tryPromise<T>(options: { try: () => Promise<T>; catch: (error: unknown) => Error }): Promise<T>
}
declare const client: Client

void client.tryPromise({
  try: async () => {
    await Promise.resolve(1)
    return 1
  },
  catch: () => new Error("failed"),
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	options.NoUnsafeAwait = config.SeverityWarning
	options.NoUnsafeAwaitMode = "all"
	options.PreferTaggedError = config.SeverityOff
	options.TypedCatchMapper = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Rule != "no-unsafe-await" {
		t.Fatalf("unrelated tryPromise findings = %#v", findings)
	}
}

func TestResultTaskRuleParity(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never, R = never> {
  map<X>(fn: (value: T) => X): ResultTask<X, E, R>
  andThen<X, F, S>(fn: (value: T) => ResultTask<X, F, S>): ResultTask<X, E | F, R | S>
  catchAll<X, F, S>(fn: (error: E) => ResultTask<X, F, S>): ResultTask<T | X, F, R | S>
  [Symbol.iterator](): Generator<unknown, T, unknown>
}
declare const ResultTask: {
  succeed<T, E = never>(value: T): ResultTask<T, E>
  gen<T>(body: () => Generator<unknown, T, unknown>): ResultTask<T>
}
declare function task(): ResultTask<number, string>
declare const unknownTask: ResultTask<number, unknown>
class FirstTaskError extends Error {}
class SecondTaskError extends Error {}
declare const unionTask: ResultTask<number, FirstTaskError | SecondTaskError>

void task().map(async (value) => value)
void task().map(() => ResultTask.succeed(1))
void task().andThen(() => ResultTask.succeed(1))
void ResultTask.succeed(1).catchAll(() => ResultTask.succeed(2))
void (unionTask as ResultTask<number, FirstTaskError>)
void ResultTask.gen(function* () {
  yield task()
  return 1
})
void ResultTask.gen(function* () {
  yield* task()
  return 1
})
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoDiscard = config.SeverityOff
	options.PreferTaggedError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		rule string
		line int
	}{
		{"no-unknown-result-error", 13},
		{"no-promise-in-result-success", 18},
		{"prefer-and-then", 19},
		{"prefer-map", 20},
		{"no-useless-recovery", 21},
		{"unsafe-result-type-assertion", 22},
		{"yield-star-in-result-task-gen", 24},
	}
	if len(findings) != len(want) {
		t.Fatalf("got %d findings, want %d: %#v", len(findings), len(want), findings)
	}
	for index, expected := range want {
		if findings[index].Rule != expected.rule || findings[index].Line != expected.line {
			t.Errorf("finding %d = %s:%d, want %s:%d", index, findings[index].Rule, findings[index].Line, expected.rule, expected.line)
		}
	}
	if len(findings[2].Fixes) != 1 || findings[2].Fixes[0].Edits[0].NewText != "andThen" {
		t.Fatalf("expected andThen quick fix, got %#v", findings[2].Fixes)
	}
	if len(findings[3].Fixes) != 1 || findings[3].Fixes[0].Edits[0].NewText != "map" {
		t.Fatalf("expected map quick fix, got %#v", findings[3].Fixes)
	}
	if len(findings[6].Fixes) != 1 || findings[6].Fixes[0].Edits[0].NewText != "yield*" {
		t.Fatalf("expected yield* quick fix, got %#v", findings[6].Fixes)
	}
}

func TestResultTaskStaticConsumersAvoidNoDiscardFalsePositives(t *testing.T) {
	directory := writeFixture(t, `
interface ResultTask<T, E = never, R = never> {}
declare const ResultTask: {
  provideServices<T, E, R>(task: ResultTask<T, E, R>, services: object): ResultTask<T, E, R>
  runExit<T, E, R>(task: ResultTask<T, E, R>): Promise<unknown>
  runResult<T, E, R>(task: ResultTask<T, E, R>): Promise<unknown>
}
declare function task(): ResultTask<number, string>

task()
const unhandled = task()
ResultTask.runResult(unhandled)
const provided = ResultTask.provideServices(task(), {})
ResultTask.runExit(provided)
`)
	opened, diagnostics, err := project.Open(filepath.Join(directory, "tsconfig.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("unexpected TypeScript diagnostics: %v", diagnostics)
	}

	options := config.Defaults()
	options.NoPromiseInResultSuccess = config.SeverityOff
	options.NoUnknownResultError = config.SeverityOff
	findings, err := Run(context.Background(), opened.Program, opened.Directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 1 || findings[0].Rule != "no-discard" || findings[0].Line != 10 {
		t.Fatalf("unexpected ResultTask no-discard findings: %#v", findings)
	}
}

func writeFixture(t *testing.T, source string) string {
	t.Helper()
	directory := t.TempDir()
	configText := `{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "strict": true,
    "target": "ES2022"
  },
  "files": ["fixture.ts"]
}`
	if err := os.WriteFile(filepath.Join(directory, "tsconfig.json"), []byte(configText), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "fixture.ts"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}
